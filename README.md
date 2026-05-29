# MCP Browser Bridge 🦊🔗🧠

**在 Termux 中通过 MCP 协议操控 Android Firefox 浏览器。**

> 类似 Browser Control MCP / Claude Code Browser，但专为手机端设计。

---

## 架构

```
┌─────────────────────────────────────────────┐
│  AI (Claude / Cursor / 任何 MCP 客户端)      │
│  ┌─────────────────────────────────────────┐ │
│  │  MCP 协议 (stdio/SSE)                   │ │
│  └──────────┬──────────────────────────────┘ │
└─────────────┼────────────────────────────────┘
              │
┌─────────────▼────────────────────────────────┐
│  Termux                                      │
│  ┌──────────────────────────────────────────┐│
│  │  mcp-server-browser (Python)             ││
│  │  ├── FastMCP 服务                          ││
│  │  ├── IPC 通道 → ws_daemon.py                ││
│  │  └── 25+ 个 MCP 工具                      ││
│  └──────────────────┬───────────────────────┘│
└─────────────────────┼────────────────────────┘
                      │ WebSocket (localhost)
┌─────────────────────▼────────────────────────┐
│  Firefox (Android)                           │
│  ┌──────────────────────────────────────────┐│
│  │  MCP Bridge 扩展                          ││
│  │  ├── background.js → WS 客户端 + 截图/标签管理││
│  │  ├── content.js → DOM 操作引擎 (TreeWalker)││
│  │  └── popup → 连接管理界面                  ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

---

## 快速开始

### 1️⃣ 安装 Firefox 扩展

1. 打开 Firefox for Android
2. 在地址栏输入 `about:debugging#/runtime/this-firefox`
3. 点击「临时载入附加组件」
4. 选择 `firefox-extension/manifest.json`
5. 工具栏出现 MCP Bridge 图标 ✅

> 永久安装需要将扩展签名上传到 AMO，或在 Firefox Nightly 中启用签名校验跳过。

### 2️⃣ 安装 MCP 服务端

```bash
# 在 Termux 中
cd ~/mcp-browser-bridge/mcp-server
pip install -r requirements.txt

# 启动服务（默认端口 9234）
python server.py
```

### 3️⃣ 连接

1. 手机 Firefox 打开任意网页
2. 点击工具栏的 MCP Bridge 图标
3. 点击「连接」按钮
4. 状态变为 **「● 已连接」** ✅

### 4️⃣ 配置 MCP 客户端

将 MCP 服务添加到你的 AI 客户端配置中：

**Claude Desktop / Cursor / Continue / 其他 MCP 客户端：**

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "python",
      "args": ["/path/to/mcp-browser-bridge/mcp-server/server.py"],
      "env": {}
    }
  }
}
```

或者在现有的 MCP Manager 中添加：

```bash
# 如果使用 mcp-manager
mcp add browser-bridge "python ~/mcp-browser-bridge/mcp-server/server.py"
```

---

## MCP 工具列表（共 25+ 工具）

### 📄 页面信息
| 工具 | 描述 |
|------|------|
| `browser_get_page(max_length)` | 获取页面纯文本（带自动重试） |
| `browser_get_url()` | 获取 URL 和标题 |
| `browser_get_structure()` | 获取页面结构（标题层级等） |
| `browser_get_meta()` | 获取 meta 标签 |
| `browser_get_visible_text()` | 获取视口内可见文本 |

### 🧭 导航
| 工具 | 描述 |
|------|------|
| `browser_navigate(url)` | 打开 URL |
| `browser_go_back()` | 返回上页 |

### 🖱️ 交互
| 工具 | 描述 |
|------|------|
| `browser_get_interactive_elements()` | 获取所有可交互元素 |
| `browser_click(selector)` | CSS 选择器点击 |
| `browser_click_index(index)` | 按索引点击（0-based） |
| `browser_scroll(amount, direction)` | 滚动页面 |
| `browser_scroll_to(x, y)` | 滚动到指定位置 |
| `browser_scroll_into_view(selector)` | 将元素滚动到视口 |
| `browser_get_scroll_info()` | 获取滚动位置/页面尺寸 |
| `browser_fill_field(selector, value)` | 填写表单 |
| `browser_select_option(selector, value)` | 选择下拉框选项 |
| `browser_get_forms()` | 获取所有表单 |

### 🔍 信息提取
| 工具 | 描述 |
|------|------|
| `browser_get_links()` | 获取所有链接 |
| `browser_get_selection()` | 获取选中文本 |
| `browser_search(query)` | 页面内搜索 |
| `browser_get_images()` | 获取图片信息 |

### 📸 截图
| 工具 | 描述 |
|------|------|
| `browser_screenshot()` | **截取当前页面截图**（base64 PNG） |

### 📑 标签页管理
| 工具 | 描述 |
|------|------|
| `browser_list_tabs()` | **列出所有打开的标签页** |
| `browser_switch_tab(tab_id)` | **切换到指定标签页** |
| `browser_create_tab(url)` | **打开新标签页** |
| `browser_close_tab(tab_id)` | **关闭指定标签页** |

### ⚡ 高级
| 工具 | 描述 |
|------|------|
| `browser_execute_js(code)` | 执行任意 JS |
| `browser_highlight(selector)` | 高亮元素 |
| `browser_get_dom(max_depth)` | 获取简化 DOM 树 |
| `browser_get_local_storage(keys)` | 获取 localStorage |
| `browser_get_cookies()` | 获取 cookie |

### 🩺 状态 & 等待
| 工具 | 描述 |
|------|------|
| `browser_status()` | 连接状态 + 诊断信息 |
| `browser_wait(seconds)` | 等待（用于页面加载） |
| `browser_wait_for_element(selector, timeout)` | **等待元素出现**（动态页面） |

---

## 典型工作流

### 场景：AI 帮你搜索资料

```
用户: 帮我查一下 Python asyncio 的用法

AI 会:
1. browser_navigate("https://docs.python.org/3/library/asyncio.html")
2. browser_wait(3)
3. browser_get_page(max_length=8000)
4. → 读取内容并总结
```

### 场景：AI 帮你填写表单

```
用户: 帮我打开百度搜索"天气预报"

AI 会:
1. browser_navigate("https://www.baidu.com")
2. browser_wait(2)
3. browser_fill_field("input#kw", "天气预报")
4. browser_click("input#su")
5. browser_wait(2)
6. browser_get_page()
```

### 场景：AI 分析页面 + 截图

```
用户: 这个页面长什么样？

AI 会:
1. browser_get_structure()
2. browser_screenshot()
3. → 查看截图并分析布局
```

### 场景：AI 管理多标签页

```
用户: 帮我在新标签页打开 GitHub

AI 会:
1. browser_create_tab("https://github.com")
2. browser_wait(3)
3. browser_get_page(max_length=5000)
4. browser_list_tabs()  ← 查看所有标签页
5. browser_switch_tab(other_tab_id)  ← 切回之前页面
```

---

## 性能优化说明

本项目已应用以下优化：

| 优化项 | 改动位置 | 效果 |
|--------|---------|------|
| **TreeWalker 替代 cloneNode** | content.js getPageText | 大页面提速 10-50x，内存减 80% |
| **批量布局计算** | content.js getInteractiveElements | 减少回流，元素多时提速 3-5x |
| **TreeWalker 视口检测** | content.js getVisibleText | 精确且高效 |
| **双向长度前缀 IPC** | server.py + ws_daemon.py | 无 64KB 上限，零截断风险 |
| **命令自动重试** | server.py send_command_with_retry | 瞬断时自动恢复，减少超时错误 |
| **诊断信息** | server.py browser_status | 快速定位连接问题 |
| **独立 WS 守护进程** | ws_daemon.py | MCP 重启不影响浏览器连接 |

---

## 常见问题

### Q: 连接不上？
- 确认 Firefox 扩展已打开并点击「连接」
- 确认 MCP 服务已在 Termux 中运行
- 检查端口 9234 是否被占用
- 执行 `browser_status()` 查看诊断信息

### Q: 命令超时？
- 某些页面加载慢，可在操作后加 `browser_wait(2-3)`
- 长页面提取文本可能较慢，可限制 `max_length`
- 读操作已内置自动重试，可容忍瞬断

### Q: 选择器找不到元素？
- 先用 `browser_get_interactive_elements()` 查看可用元素
- 使用 `browser_highlight(selector)` 测试选择器
- 某些动态内容需要用 `browser_wait_for_element(selector)`

### Q: 在 Termux 中如何永久运行？
```bash
# 使用 tmux 或 screen
tmux new -s mcp-browser
python server.py
# Ctrl+B, D 分离会话
```

### Q: 守护进程管理？
```bash
# 手动启动守护进程
python server.py --daemon start

# 查看状态
python server.py --daemon status

# 停止守护进程
python server.py --daemon stop
```

---

## 文件结构

```
mcp-browser-bridge/
├── firefox-extension/       ← Firefox 扩展
│   ├── manifest.json        ← 扩展配置
│   ├── background.js        ← WebSocket 客户端 + 命令路由 + 截图/标签API
│   ├── content.js           ← DOM 操作引擎（TreeWalker 优化版）
│   ├── popup/
│   │   ├── popup.html       ← 连接管理界面
│   │   └── popup.js         ← 面板逻辑
│   └── icons/
│       └── icon.svg         ← 扩展图标
├── mcp-server/              ← Termux MCP 服务端
│   ├── server.py            ← FastMCP + IPC 客户端（25+ 工具）
│   ├── ws_daemon.py         ← 独立 WebSocket 守护进程
│   └── requirements.txt     ← Python 依赖
└── README.md
```

---

## 变更日志

### v1.1.0 (2026-05-29)
- 🐛 **修复**: IPC 协议双向长度前缀，消除 64KB 截断 bug
- 🐛 **修复**: ws_daemon.py 请求读取使用长度前缀，与大请求兼容
- ✨ **新增**: `browser_screenshot()` — 页面截图功能
- ✨ **新增**: `browser_list_tabs()` / `browser_switch_tab()` — 标签页管理
- ✨ **新增**: `browser_create_tab()` / `browser_close_tab()` — 标签页操作
- ✨ **新增**: `browser_wait_for_element()` — 等待动态元素加载
- ⚡ **优化**: content.js 使用 TreeWalker 替代 cloneNode，大页面提速 10-50x
- ⚡ **优化**: 批量布局计算减少浏览器回流
- ⚡ **优化**: 读操作自动重试（瞬断时自动恢复）
- 💡 **优化**: 诊断信息让排查问题更直观

---

## License

MIT
