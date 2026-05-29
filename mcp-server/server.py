"""
MCP 浏览器桥接服务端
运行在 Termux 中，通过 WebSocket 与 Firefox 扩展通信，
对外暴露 MCP 工具供 AI 使用。
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
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

import websockets
from mcp.server import FastMCP
from pydantic import BaseModel, Field

# ========== 配置 ==========

IPC_HOST = "127.0.0.1"
IPC_PORT = 9235
WS_PORT = 9234
CMD_TIMEOUT = 45
MAX_TEXT_LENGTH = 50000
MAX_ELEMENTS = 200

# ========== 日志 ==========

logging.basicConfig(
    level=logging.INFO,
    format="[MCP-Browser] %(asctime)s %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mcp-browser")

# ========== 全局状态 ==========

@dataclass
class BridgeState:
    start_time: float = field(default_factory=time.time)
    command_count: int = 0
    error_count: int = 0

state = BridgeState()

# ========== IPC 客户端（与 WS 守护进程通信） ==========

async def ipc_request(data: dict) -> dict:
    """通过 TCP IPC 向 WS 守护进程发送请求（双向长度前缀协议，无 64KB 限制）"""
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(IPC_HOST, IPC_PORT),
            timeout=5.0,
        )
        payload = json.dumps(data).encode("utf-8")
        # 发送长度前缀（4字节大端 uint32）+ 数据
        writer.write(struct.pack('!I', len(payload)) + payload)
        await writer.drain()

        # 读取响应长度前缀（4字节大端 uint32）
        len_bytes = await asyncio.wait_for(reader.readexactly(4), timeout=CMD_TIMEOUT + 5)
        data_len = struct.unpack('!I', len_bytes)[0]

        # 按确切长度读取，零截断风险
        response_data = await asyncio.wait_for(reader.readexactly(data_len), timeout=CMD_TIMEOUT + 5)

        return json.loads(response_data.decode("utf-8"))
    except asyncio.IncompleteReadError:
        state.error_count += 1
        return {"success": False, "error": "IPC 响应不完整（连接提前关闭）"}
    except asyncio.TimeoutError:
        state.error_count += 1
        return {"success": False, "error": "WS 守护进程连接超时"}
    except ConnectionRefusedError:
        state.error_count += 1
        return {"success": False, "error": "WS 守护进程未运行"}
    except Exception as e:
        state.error_count += 1
        return {"success": False, "error": f"IPC 错误: {e}"}
    finally:
        if writer:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


async def send_command(action: str, params: dict | None = None) -> dict:
    """通过 IPC 发送命令到 WS 守护进程"""
    state.command_count += 1
    return await ipc_request({
        "action": "send_command",
        "params": {
            "action": action,
            "params": params or {},
        },
    })


async def send_command_with_retry(action: str, params: dict | None = None, retries: int = 2) -> dict:
    """发送命令并自动重试（用于读操作，如获取页面内容）"""
    last_error = None
    for attempt in range(1 + retries):
        result = await send_command(action, params)
        if result.get("success"):
            return result
        error = result.get("error", "")
        # 只在特定错误时重试（超时、连接断开等可恢复错误）
        if any(msg in error for msg in ["超时", "断开", "未运行", "无响应"]):
            last_error = result
            if attempt < retries:
                log.warning(f"⏳ 命令 {action} 失败 (尝试 {attempt+1}/{1+retries}): {error[:60]}")
                await asyncio.sleep(1.0 * (attempt + 1))
                continue
        return result
    return last_error if last_error else {"success": False, "error": "所有重试均失败"}


async def check_daemon_status() -> dict:
    """检查 WS 守护进程状态"""
    return await ipc_request({"action": "ping"})


# ========== MCP 服务端 ==========

@asynccontextmanager
async def mcp_lifespan(server: FastMCP):
    """MCP 生命周期：使用独立的 WS 守护进程"""
    log.info("=" * 50)
    log.info("🚀 MCP Browser Bridge 启动")
    log.info(f"   WS 守护进程端口: {WS_PORT}")
    log.info(f"   IPC 通道端口:    {IPC_PORT}")
    log.info(f"   命令超时:         {CMD_TIMEOUT}s")
    log.info("=" * 50)

    # 启动独立的 WS 守护进程（如尚未运行）
    start_ws_daemon()

    try:
        yield
    finally:
        # 注意：不停止 WS 守护进程！它独立于 MCP 运行
        log.info("MCP 服务关闭（WS 守护进程继续运行，浏览器连接保持）")


# 创建 MCP 服务
mcp = FastMCP(
    "MCP Browser Bridge",
    instructions="通过 Firefox 扩展操控手机浏览器的 MCP 服务",
    lifespan=mcp_lifespan,
)


# ========== 辅助函数 ==========

def _require_browser(result: dict) -> dict | None:
    """检查浏览器是否连接，未连接则返回错误"""
    if not result.get("success"):
        return None
    return result.get("data")


def _wrap(data: Any) -> dict:
    """统一包装成功响应"""
    return {"success": True, "data": data}


def _diagnose(daemon_status: dict) -> str:
    """生成连接诊断信息"""
    if not daemon_status.get("success"):
        error = daemon_status.get("error", "")
        if "连接超时" in error:
            return "⚠️ WS 守护进程无响应（可能未启动或端口冲突）"
        if "连接被拒绝" in error:
            return "❌ WS 守护进程未运行。请执行: python ws_daemon.py"
        return f"❌ {error}"
    ds = daemon_status.get("data", {})
    if ds.get("connected"):
        return "✅ 浏览器已连接"
    return "⏸ 浏览器未连接。请在 Firefox 扩展中点击「连接」按钮"


# ========== MCP 工具 ==========

# --- 页面信息工具 ---

@mcp.tool()
async def browser_get_page(max_length: int = 10000) -> dict:
    """获取当前浏览器页面的纯文本内容"""
    result = await send_command_with_retry("getPageText")
    data = _require_browser(result)
    if data is None:
        return result
    text = data.get("text", "")
    if len(text) > max_length:
        text = text[:max_length] + f"\n\n[...截断，全文 {len(text)} 字符，仅显示前 {max_length}]"
    return _wrap({"text": text, "length": len(text)})


@mcp.tool()
async def browser_get_url() -> dict:
    """获取当前浏览器页面的 URL 和标题"""
    result = await send_command_with_retry("getUrl")
    return result if not result.get("success") else _wrap(result.get("data", {}))


@mcp.tool()
async def browser_get_structure() -> dict:
    """获取页面的结构化信息（标题、标题层级、链接/图片数量等）"""
    result = await send_command_with_retry("getPageStructure")
    return result if not result.get("success") else _wrap(result.get("data", {}))


@mcp.tool()
async def browser_get_meta() -> dict:
    """获取页面的 meta 标签信息（description、keywords、og 等）"""
    result = await send_command_with_retry("getMeta")
    return result if not result.get("success") else _wrap(result.get("data", {}))


@mcp.tool()
async def browser_get_visible_text() -> dict:
    """获取当前视口范围内可见的文本内容（不包含屏幕外的内容）"""
    result = await send_command_with_retry("getVisibleText")
    return result if not result.get("success") else _wrap(result.get("data", {}))


# --- 导航工具 ---

@mcp.tool()
async def browser_navigate(url: str) -> dict:
    """
    导航到指定 URL
    Args:
        url: 要打开的完整 URL（如 https://www.example.com）
    """
    if not url.startswith(("http://", "https://", "about:")):
        url = "https://" + url
    result = await send_command("navigate", {"url": url})
    return result


@mcp.tool()
async def browser_go_back() -> dict:
    """返回上一页（通过 history.back()）"""
    result = await send_command("executeJS", {"code": "history.back()"})
    return _wrap({"success": True})


# --- 页面交互工具 ---

@mcp.tool()
async def browser_get_clickable_elements() -> dict:
    """
    🌲 全 DOM 树 DFS 遍历，返回所有可点击元素的稳定索引列表。
    索引基于文档顺序的深度优先遍历，页面不刷新时保持稳定。
    比 browser_get_interactive_elements 更完整（包含不在视口内的元素）。
    
    返回：
      - count: 返回的元素数（≤500）
      - totalInDOM: DOM 中实际总数
      - elements: 元素列表，含 index/tag/text/selector/rect/display/isVisible/isInViewport
    
    提示：
      - 元素可能 CSS 隐藏（display:none），这时 isVisible=false，display="none"
      - 先调用此工具获取索引，再用 browser_click_by_dom_index 点击
      - 隐藏元素也能点击（会找可见祖先滚动）
    """
    result = await send_command("getDOMClickableElements")
    data = _require_browser(result)
    if data is None:
        return result
    elements = data.get("elements", [])
    return _wrap({
        "count": len(elements),
        "totalInDOM": data.get("total", len(elements)),
        "elements": elements,
    })


@mcp.tool()
async def browser_click_by_dom_index(index: int) -> dict:
    """
    🎯 通过 DOM 树索引点击元素。
    先用 browser_get_clickable_elements 获取索引列表。
    索引基于 DFS 遍历顺序，页面不刷新时稳定。
    
    特性：
      - 自动 scrollIntoView：元素不在视口时自动滚动过去
      - 可见性降级：如果元素 CSS display:none，自动找可见祖先滚动
      - 支持点击隐藏元素（弹窗/菜单等未展开的内容）
    
    Args:
        index: DOM 树遍历索引（0-based，从 browser_get_clickable_elements 获取）
    """
    result = await send_command("clickByDOMIndex", {"index": index})
    return result


@mcp.tool()
async def browser_get_interactive_elements() -> dict:
    """获取页面上所有可交互元素（按钮、链接、输入框等）的列表及其位置信息"""
    result = await send_command("getInteractiveElements")
    data = _require_browser(result)
    if data is None:
        return result
    elements = data.get("elements", [])[:MAX_ELEMENTS]
    return _wrap({
        "count": len(elements),
        "elements": elements,
    })


@mcp.tool()
async def browser_click(selector: str) -> dict:
    """
    点击指定的元素（通过 CSS 选择器）
    Args:
        selector: CSS 选择器，如 '#submit-btn', 'button.primary', 'a[href="/login"]'
    """
    result = await send_command("click", {"selector": selector})
    return result


@mcp.tool()
async def browser_click_index(index: int) -> dict:
    """
    点击第 N 个可交互元素（从 0 开始）
    先用 browser_get_interactive_elements 查看可用的元素列表
    Args:
        index: 可交互元素列表中的索引（0-based）
    """
    result = await send_command("clickByIndex", {"index": index})
    return result


@mcp.tool()
async def browser_scroll(amount: int = 300, direction: str = "down") -> dict:
    """
    滚动页面
    Args:
        amount: 滚动的像素数
        direction: 'down' 向下滚动, 'up' 向上滚动, 'left' 向左, 'right' 向右
    """
    y = amount if direction in ("down", "up") else 0
    x = amount if direction in ("left", "right") else 0
    if direction == "up":
        y = -amount
    if direction == "left":
        x = -amount
    result = await send_command("scrollBy", {"x": x, "y": y})
    return result


@mcp.tool()
async def browser_scroll_to(y: int = 0, x: int = 0) -> dict:
    """
    滚动到指定位置
    Args:
        y: 纵向滚动到的位置（像素）
        x: 横向滚动到的位置（像素）
    """
    result = await send_command("scrollTo", {"x": x, "y": y})
    return result


@mcp.tool()
async def browser_scroll_into_view(selector: str) -> dict:
    """
    将指定元素滚动到视口中
    Args:
        selector: CSS 选择器
    """
    result = await send_command("scrollIntoView", {"selector": selector})
    return result


@mcp.tool()
async def browser_scroll_to_text(text: str) -> dict:
    """
    🔍 搜索页面中的文本并滚动到该位置（高亮显示 2 秒）。
    适合在长篇页面中快速定位到包含特定关键词的位置。
    Args:
        text: 要搜索的文本
    """
    result = await send_command("scrollToText", {"text": text})
    return result


@mcp.tool()
async def browser_get_scroll_info() -> dict:
    """获取当前滚动位置和页面尺寸信息"""
    result = await send_command("getScrollInfo")
    return result if not result.get("success") else _wrap(result.get("data", {}))


@mcp.tool()
async def browser_fill_field(selector: str, value: str) -> dict:
    """
    填写表单字段
    Args:
        selector: CSS 选择器，如 '#search-input', 'input[name="q"]'
        value: 要填入的值
    """
    result = await send_command("fillField", {"selector": selector, "value": value})
    return result


@mcp.tool()
async def browser_select_option(selector: str, value: str) -> dict:
    """
    选择下拉框选项
    Args:
        selector: SELECT 元素的 CSS 选择器
        value: 要选中的 option 的 value
    """
    result = await send_command("selectOption", {"selector": selector, "value": value})
    return result


@mcp.tool()
async def browser_get_forms() -> dict:
    """获取页面上所有表单及其字段信息"""
    result = await send_command("getForms")
    return result if not result.get("success") else _wrap(result.get("data", {}))


# --- 信息提取工具 ---

@mcp.tool()
async def browser_get_links() -> dict:
    """获取当前页面上所有链接"""
    result = await send_command("getLinks")
    data = _require_browser(result)
    if data is None:
        return result
    links = data.get("links", [])
    return _wrap({"count": len(links), "links": links[:200]})


@mcp.tool()
async def browser_get_selection() -> dict:
    """获取当前页面上选中的文本"""
    result = await send_command("getSelection")
    return result if not result.get("success") else _wrap(result.get("data", {}))


@mcp.tool()
async def browser_search(query: str) -> dict:
    """
    在当前页面中搜索文本
    Args:
        query: 要搜索的文本
    """
    result = await send_command("searchText", {"query": query})
    return result if not result.get("success") else _wrap(result.get("data", {}))


@mcp.tool()
async def browser_get_images() -> dict:
    """获取当前页面上可见图片的信息"""
    result = await send_command("getImages")
    return result if not result.get("success") else _wrap(result.get("data", {}))


# --- 截图工具 ---

@mcp.tool()
async def browser_screenshot() -> dict:
    """📸 截取当前浏览器页面的截图（返回 base64 PNG 数据）。
    适合 AI 查看页面视觉布局、验证元素位置、识别图片内容。
    返回格式：{ dataUrl: "data:image/png;base64,...", format: "png" }"""
    result = await send_command("captureScreenshot")
    return result


# --- 标签页管理 ---

@mcp.tool()
async def browser_list_tabs() -> dict:
    """📑 列出浏览器中所有打开的标签页。
    返回每个标签页的 ID、URL、标题和活动状态。
    适合在多标签页场景下切换或管理标签页"""
    result = await send_command("getAllTabs")
    return result


@mcp.tool()
async def browser_switch_tab(tab_id: int) -> dict:
    """
    🔀 切换到指定 ID 的标签页
    Args:
        tab_id: 标签页 ID（通过 browser_list_tabs 获取）
    """
    result = await send_command("switchTab", {"tabId": tab_id})
    return result


@mcp.tool()
async def browser_create_tab(url: str = "about:blank") -> dict:
    """
    ➕ 打开新标签页
    Args:
        url: 要打开的 URL（默认空白页）
    """
    if not url.startswith(("http://", "https://", "about:")):
        url = "https://" + url
    result = await send_command("createTab", {"url": url})
    return result


@mcp.tool()
async def browser_close_tab(tab_id: int) -> dict:
    """
    ❌ 关闭指定 ID 的标签页
    Args:
        tab_id: 标签页 ID
    """
    result = await send_command("closeTab", {"tabId": tab_id})
    return result


# --- 高级工具 ---

@mcp.tool()
async def browser_execute_js(code: str) -> dict:
    """
    在页面中执行任意 JavaScript 代码（危险操作）
    Args:
        code: 要执行的 JS 代码
    """
    result = await send_command("executeJS", {"code": code})
    return result


@mcp.tool()
async def browser_highlight(selector: str) -> dict:
    """
    高亮显示页面上的某个元素（持续 2 秒后恢复）
    Args:
        selector: CSS 选择器
    """
    result = await send_command("highlight", {"selector": selector, "color": "#ff5722"})
    return result


@mcp.tool()
async def browser_get_dom(max_depth: int = 5) -> dict:
    """
    获取简化 DOM 树结构
    Args:
        max_depth: 最大递归深度（默认 5）
    """
    result = await send_command("getDOM", {"maxDepth": max_depth})
    return result if not result.get("success") else _wrap(result.get("data", {}))


@mcp.tool()
async def browser_get_local_storage(keys: list[str] | None = None) -> dict:
    """
    获取页面的 localStorage 数据
    Args:
        keys: 要获取的键名列表（不传则返回所有）
    """
    result = await send_command("getLocalStorage", {"keys": keys or []})
    return result


@mcp.tool()
async def browser_get_cookies() -> dict:
    """获取页面的 document.cookie"""
    result = await send_command("getCookies")
    return result if not result.get("success") else _wrap(result.get("data", {}))


# --- 状态工具 ---

@mcp.tool()
async def browser_status() -> dict:
    """检查浏览器连接状态（从 WS 守护进程获取实时状态）"""
    now = time.time()
    uptime = now - state.start_time

    # 从 WS 守护进程获取实时状态
    daemon_status = await check_daemon_status()

    if daemon_status.get("success"):
        ds = daemon_status.get("data", {})
        return _wrap({
            "connected": ds.get("connected", False),
            "uptime_seconds": round(uptime),
            "uptime_str": f"{int(uptime // 3600)}h{int((uptime % 3600) // 60)}m{int(uptime % 60)}s",
            "commands_sent": state.command_count,
            "errors": state.error_count,
            "daemon_uptime": round(ds.get("uptime", 0)),
            "daemon_commands": ds.get("commands", 0),
            "daemon_errors": ds.get("errors", 0),
            "daemon_pending": ds.get("pending_requests", 0),
            "ws_url": f"ws://127.0.0.1:{WS_PORT}",
            "last_active_tab": "—",
            "diagnosis": _diagnose(daemon_status),
        })
    else:
        return _wrap({
            "connected": False,
            "uptime_seconds": round(uptime),
            "uptime_str": f"{int(uptime // 3600)}h{int((uptime % 3600) // 60)}m{int(uptime % 60)}s",
            "commands_sent": state.command_count,
            "errors": state.error_count,
            "ws_url": f"ws://127.0.0.1:{WS_PORT}",
            "daemon_error": daemon_status.get("error"),
            "last_active_tab": "—",
            "diagnosis": _diagnose(daemon_status),
        })


@mcp.tool()
async def browser_wait(seconds: float = 2.0) -> dict:
    """
    等待一段时间（用于页面加载、动画等）
    Args:
        seconds: 等待秒数（默认 2.0）
    """
    await asyncio.sleep(seconds)
    return _wrap({"waited": seconds})


@mcp.tool()
async def browser_wait_for_element(selector: str, timeout: float = 10.0) -> dict:
    """
    👀 等待指定元素出现在页面上（用于动态加载内容）
    通过反复执行 document.querySelector 检查元素是否存在。
    Args:
        selector: CSS 选择器
        timeout: 最大等待秒数（默认 10）
    """
    import math
    deadline = time.time() + timeout
    last_result = None
    while time.time() < deadline:
        result = await send_command("executeJS", {
            "code": f"""(() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return {{ found: false }};
                const rect = el.getBoundingClientRect();
                return {{
                    found: true,
                    tag: el.tagName,
                    text: (el.textContent||'').trim().slice(0, 200),
                    visible: rect.width > 0 && rect.height > 0,
                    rect: {{ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }}
                }};
            }})()"""
        })
        if result.get("success") and result.get("data", {}).get("result"):
            data = json.loads(result["data"]["result"])
            if data.get("found") and data.get("visible"):
                return _wrap({"found": True, "element": data, "waited": round(timeout - (deadline - time.time()), 1)})
        last_result = result
        await asyncio.sleep(0.3)

    return _wrap({"found": False, "waited": timeout, "error": f"元素 '{selector}' 在 {timeout}s 内未出现"})


# ========== 资源 ==========

@mcp.resource("bridge://status")
async def get_status_resource() -> str:
    """获取桥接器的状态信息"""
    daemon_status = await check_daemon_status()
    ds = daemon_status.get("data", {}) if daemon_status.get("success") else {}
    return json.dumps({
        "connected": ds.get("connected", False),
        "uptime": time.time() - state.start_time,
        "daemon_uptime": ds.get("uptime", 0),
        "commands": state.command_count,
        "errors": state.error_count,
        "daemon_commands": ds.get("commands", 0),
        "daemon_errors": ds.get("errors", 0),
        "server": f"ws://127.0.0.1:{WS_PORT}",
    }, ensure_ascii=False, indent=2)


@mcp.resource("bridge://tab")
async def get_tab_resource() -> str:
    """获取当前活动标签页信息（通过 IPC）"""
    result = await send_command("getUrl")
    if result.get("success") and result.get("data"):
        return json.dumps(result["data"], ensure_ascii=False, indent=2)
    return json.dumps({"error": "No active tab info"}, ensure_ascii=False, indent=2)


# ========== 提示模板 ==========

@mcp.prompt()
def browser_help() -> str:
    """使用浏览器 MCP 工具的指南"""
    return """# MCP Browser Bridge 使用指南

## 前提
1. 在 Firefox 中安装 MCP Browser Bridge 扩展
2. 打开扩展面板，点击「连接」
3. 确认状态变为「已连接」

## 常用工作流

### 浏览网页
1. `browser_navigate(url)` — 打开网页
2. `browser_wait(2)` — 等待加载
3. `browser_get_page()` — 获取内容
4. `browser_get_links()` — 查看链接
5. `browser_click_index(n)` — 点击链接

### 搜索信息
1. `browser_navigate("google.com")` — 打开搜索引擎
2. `browser_fill_field("input[name=q]", "关键词")` — 输入关键词
3. `browser_click("button")` — 点击搜索
4. `browser_get_page()` — 查看结果

### 表单填写
1. `browser_get_forms()` — 查看表单字段
2. `browser_fill_field("#name", "张三")` — 填写名称
3. `browser_select_option("#country", "CN")` — 选择下拉
4. `browser_click("#submit")` — 提交

### 调试
- `browser_get_interactive_elements()` — 查看可点击元素
- `browser_highlight("#element-id")` — 高亮定位元素
- `browser_get_structure()` — 查看页面结构
- `browser_execute_js("document.title")` — 执行 JS

## 注意事项
- 页面加载需要时间，操作后建议 `browser_wait()`
- 某些网站可能阻止 JS 执行
- 选择器尽量使用 ID 或唯一 class
"""


# ========== 独立 WebSocket 守护进程管理 ==========

WS_DAEMON_PID_FILE = os.path.join(os.path.dirname(__file__), ".ws_daemon.pid")


def start_ws_daemon():
    """启动独立的 WebSocket 守护进程（如未运行）"""
    import subprocess

    pid_file = WS_DAEMON_PID_FILE

    if os.path.exists(pid_file):
        try:
            with open(pid_file) as f:
                old_pid = int(f.read().strip())
            os.kill(old_pid, 0)
            log.info(f"✅ WS 守护进程已在运行 (PID: {old_pid})")
            return old_pid
        except (ProcessLookupError, ValueError, OSError):
            log.info("发现过期 PID 文件，将启动新守护进程")
            try:
                os.remove(pid_file)
            except OSError:
                pass

    ws_script = os.path.join(os.path.dirname(__file__), "ws_daemon.py")
    if not os.path.exists(ws_script):
        log.error(f"WS 守护进程脚本不存在: {ws_script}")
        return None

    proc = subprocess.Popen(
        [sys.executable, ws_script, "--port", str(WS_PORT), "--ipc-port", str(IPC_PORT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )

    with open(pid_file, "w") as f:
        f.write(str(proc.pid))

    log.info(f"🚀 启动独立 WS 守护进程 (PID: {proc.pid})")

    # 等待守护进程就绪
    for i in range(10):
        try:
            result = asyncio.run(ipc_request({"action": "ping"}))
            if result.get("success"):
                log.info("✅ WS 守护进程就绪")
                return proc.pid
        except Exception:
            pass
        time.sleep(0.5)

    log.warning("⚠ WS 守护进程可能未就绪")
    return proc.pid


def stop_ws_daemon():
    """停止 WebSocket 守护进程"""
    pid_file = WS_DAEMON_PID_FILE
    if not os.path.exists(pid_file):
        return

    try:
        with open(pid_file) as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
        log.info(f"🛑 停止 WS 守护进程 (PID: {pid})")
        os.remove(pid_file)
    except (ProcessLookupError, ValueError, OSError):
        try:
            os.remove(pid_file)
        except OSError:
            pass


# ========== 入口 ==========

def main():
    """启动 MCP 服务"""
    import argparse

    parser = argparse.ArgumentParser(description="MCP Browser Bridge - 通过 Firefox 扩展操控浏览器")
    parser.add_argument("--host", default=None,
                        help="SSE 模式监听地址 (默认: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None,
                        help="SSE 模式监听端口 (默认: 3501)")
    parser.add_argument("--ws-port", type=int, default=9234,
                        help="Firefox 扩展 WebSocket 端口 (默认: 9234)")
    parser.add_argument("--transport", choices=["stdio", "sse"], default=None,
                        help="传输协议 (默认: stdio, 指定 host/port 自动切换 SSE)")
    parser.add_argument("--daemon", choices=["start", "stop", "status"], default=None,
                        help="管理独立 WS 守护进程")
    args = parser.parse_args()

    # 动态配置
    global WS_PORT
    WS_PORT = args.ws_port

    # 守护进程管理命令
    if args.daemon == "start":
        pid = start_ws_daemon()
        if pid:
            print(f"WebSocket 守护进程已启动 (PID: {pid})")
        return
    elif args.daemon == "stop":
        stop_ws_daemon()
        print("WebSocket 守护进程已停止")
        return
    elif args.daemon == "status":
        pid_file = WS_DAEMON_PID_FILE
        if os.path.exists(pid_file):
            try:
                with open(pid_file) as f:
                    pid = int(f.read().strip())
                os.kill(pid, 0)
                print(f"WebSocket 守护进程正在运行 (PID: {pid})")
            except (ProcessLookupError, ValueError, OSError):
                print("PID 文件过期，守护进程未运行")
                try:
                    os.remove(pid_file)
                except OSError:
                    pass
        else:
            print("WebSocket 守护进程未运行")
        return

    if args.host and args.port:
        # SSE 模式（供 mcp-manager 使用）
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        log.info(f"📡 SSE 模式: http://{args.host}:{args.port}/sse")
        mcp.run(transport="sse")
    elif args.transport == "sse":
        # SSE 模式使用默认配置
        mcp.settings.host = "127.0.0.1"
        mcp.settings.port = 3501
        log.info(f"📡 SSE 模式: http://127.0.0.1:3501/sse")
        mcp.run(transport="sse")
    else:
        # stdio 模式（供 MCP 客户端直连）
        log.info("📡 stdio 模式")
        mcp.run()


if __name__ == "__main__":
    main()