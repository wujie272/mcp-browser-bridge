"""
WebSocket 守护进程 - 独立于 MCP 生命周期运行
与 MCP 服务端通过 TCP IPC 通信（端口 9235）
"""
import asyncio
import json
import logging
import os
import signal
import socket
import struct
import sys
import time
import uuid
from argparse import ArgumentParser
from dataclasses import dataclass, field
from typing import Any, Optional

logging.basicConfig(
    level=logging.INFO,
    format="[WS-Daemon] %(asctime)s %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ws-daemon")

WS_HOST = "127.0.0.1"
WS_PORT = 9234
IPC_HOST = "127.0.0.1"
IPC_PORT = 9235
CMD_TIMEOUT = 45


@dataclass
class DaemonState:
    websocket: Optional[Any] = None
    connected: bool = False
    pending_requests: dict = field(default_factory=dict)
    command_count: int = 0
    error_count: int = 0
    start_time: float = field(default_factory=time.time)


state = DaemonState()


# ========== WebSocket 处理（与 Firefox 扩展通信） ==========

async def ws_handler(websocket):
    if state.connected and state.websocket:
        log.info("已有浏览器连接，替换旧连接")
        try:
            await state.websocket.close()
        except Exception:
            pass

    state.websocket = websocket
    state.connected = True
    log.info("🟢 浏览器已连接")

    try:
        async for raw_message in websocket:
            try:
                data = json.loads(raw_message)
                msg_type = data.get("type", "")

                if msg_type == "handshake":
                    log.info(f"浏览器握手: version={data.get('version')}, tabs={data.get('tabs')}")
                elif msg_type == "response":
                    req_id = data.get("id")
                    if req_id and req_id in state.pending_requests:
                        state.pending_requests[req_id].set_result(data)
                elif msg_type == "tab_update":
                    log.info(f"📄 标签页: {data.get('data', {}).get('title', '?')[:50]}")
                elif msg_type == "pong":
                    pass
                else:
                    log.debug(f"未知消息类型: {msg_type}")
            except json.JSONDecodeError:
                log.warning(f"非法 JSON: {raw_message[:100]}")
            except Exception as e:
                log.error(f"处理消息出错: {e}")
    except Exception:
        log.info("🔴 浏览器连接断开")
    finally:
        state.connected = False
        state.websocket = None
        for req_id, future in state.pending_requests.items():
            if not future.done():
                future.set_result({"success": False, "error": "浏览器连接断开"})
        state.pending_requests.clear()
        log.info("⏸ 等待浏览器重新连接...")


# ========== TCP IPC（与 MCP 服务端通信） ==========

async def handle_ipc(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """处理 MCP 服务端发来的命令请求"""
    peer = writer.get_extra_info("peername")
    log.debug(f"IPC 连接: {peer}")

    try:
        # 使用长度前缀协议读取请求（与响应侧对称，无 64KB 限制）
        len_bytes = await asyncio.wait_for(reader.readexactly(4), timeout=10.0)
        data_len = struct.unpack('!I', len_bytes)[0]
        data = await asyncio.wait_for(reader.readexactly(data_len), timeout=10.0)

        if not data:
            return

        request = json.loads(data.decode("utf-8"))
        action = request.get("action")
        cmd_id = request.get("id", str(uuid.uuid4()))
        params = request.get("params", {})

        if action == "ping":
            # 健康检查 + 附加状态
            response = {
                "success": True,
                "data": {
                    "connected": state.connected,
                    "uptime": time.time() - state.start_time,
                    "commands": state.command_count,
                    "errors": state.error_count,
                    "pending_requests": len(state.pending_requests),
                }
            }
        elif action == "send_command":
            if not state.connected or not state.websocket:
                response = {"success": False, "error": "浏览器未连接。请在 Firefox 扩展中点击「连接」"}
            else:
                ws_cmd_id = str(uuid.uuid4())
                msg = {
                    "id": ws_cmd_id,
                    "type": "command",
                    "action": params.get("action", ""),
                    "params": params.get("params", {}),
                }

                future = asyncio.get_event_loop().create_future()
                state.pending_requests[ws_cmd_id] = future
                state.command_count += 1

                try:
                    await state.websocket.send(json.dumps(msg))
                    result = await asyncio.wait_for(future, timeout=CMD_TIMEOUT)
                    response = result
                except asyncio.TimeoutError:
                    state.error_count += 1
                    response = {"success": False, "error": f"命令超时（{CMD_TIMEOUT}秒）"}
                except Exception as e:
                    state.error_count += 1
                    response = {"success": False, "error": str(e)}
                finally:
                    state.pending_requests.pop(ws_cmd_id, None)
        else:
            response = {"success": False, "error": f"未知动作: {action}"}

        # 使用长度前缀协议发送响应（4字节大端 uint32 + JSON 数据）
        encoded = json.dumps(response).encode("utf-8")
        writer.write(struct.pack('!I', len(encoded)) + encoded)
        await writer.drain()
    except json.JSONDecodeError:
        log.warning(f"IPC 非法请求")
    except Exception as e:
        log.error(f"IPC 错误: {e}")
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def start_ipc_server():
    """启动 TCP IPC 服务端"""
    server = await asyncio.start_server(handle_ipc, IPC_HOST, IPC_PORT)
    log.info(f"🔌 IPC 服务启动: tcp://{IPC_HOST}:{IPC_PORT}")
    async with server:
        await server.serve_forever()


async def start_ws_server():
    """启动 WebSocket 服务端"""
    import websockets
    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        log.info(f"🌐 WebSocket 服务启动: ws://{WS_HOST}:{WS_PORT}")
        log.info("  请在 Firefox 扩展中点击「连接」")
        await asyncio.Future()


async def main():
    parser = ArgumentParser()
    parser.add_argument("--port", type=int, default=9234, help="WebSocket 端口")
    parser.add_argument("--ipc-port", type=int, default=9235, help="IPC 端口")
    args = parser.parse_args()

    global WS_PORT, IPC_PORT
    WS_PORT = args.port
    IPC_PORT = args.ipc_port

    log.info("=" * 50)
    log.info(f"🚀 WebSocket 守护进程启动")
    log.info(f"   WebSocket:    ws://{WS_HOST}:{WS_PORT}")
    log.info(f"   IPC 通道:     tcp://{IPC_HOST}:{IPC_PORT}")
    log.info("=" * 50)

    # 启动 IPC 和 WebSocket 两个服务
    await asyncio.gather(
        start_ipc_server(),
        start_ws_server(),
    )


if __name__ == "__main__":
    asyncio.run(main())
