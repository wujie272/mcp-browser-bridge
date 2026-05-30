/**
 * MCP Browser Bridge - Background Script (Manifest V2)
 * 管理 WebSocket 连接到 Termux MCP 服务，路由命令到 content script
 */

const CONFIG = {
  wsUrl: 'ws://127.0.0.1:9234',
  reconnectInterval: 3000,
  maxReconnectAttempts: 50,
  commandTimeout: 60000,
};

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pendingCommands = new Map();
let cmdIdCounter = 0;
let registeredContentTabs = new Map(); // tabId -> registered
let isConnected = false;
let lastStatus = 'disconnected';

// ========== WebSocket 管理 ==========

function getStatus() {
  return {
    connected: isConnected,
    status: lastStatus,
    pendingCount: pendingCommands.size,
    wsUrl: CONFIG.wsUrl,
    reconnectAttempts,
    activeTabId: null,
  };
}

function updateBadge(text, color) {
  browser.browserAction.setBadgeText({ text });
  if (color) {
    browser.browserAction.setBadgeBackgroundColor({ color });
  }
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  lastStatus = 'connecting';
  updateBadge('...', '#f0ad4e');
  console.log(`[MCP Bridge] Connecting to ${CONFIG.wsUrl}...`);

  try {
    ws = new WebSocket(CONFIG.wsUrl);
  } catch (e) {
    console.error('[MCP Bridge] WebSocket creation failed:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[MCP Bridge] WebSocket connected');
    isConnected = true;
    lastStatus = 'connected';
    reconnectAttempts = 0;
    updateBadge('ON', '#4CAF50');

    // 发送握手信息
    sendWS({
      type: 'handshake',
      client: 'firefox-extension',
      version: '1.1.0',
      tabs: registeredContentTabs.size,
    });

    // 广播当前活跃标签页信息
    broadcastActiveTab();
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log('[MCP Bridge] WS received:', msg.action || msg.type, msg.id);

      if (msg.type === 'command') {
        await handleCommand(msg);
      } else if (msg.type === 'ping') {
        sendWS({ type: 'pong', id: msg.id });
      }
    } catch (e) {
      console.error('[MCP Bridge] WS message error:', e);
    }
  };

  ws.onclose = (event) => {
    console.log(`[MCP Bridge] WS closed: code=${event.code}, reason=${event.reason}`);
    isConnected = false;
    lastStatus = 'disconnected';
    updateBadge('OFF', '#f44336');
    ws = null;

    // 拒绝所有待处理的命令
    for (const [id, entry] of pendingCommands) {
      entry.reject(new Error('WebSocket disconnected'));
      clearTimeout(entry.timer);
    }
    pendingCommands.clear();

    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error('[MCP Bridge] WS error:', error);
    // onclose 会自动触发
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= CONFIG.maxReconnectAttempts) {
    console.log('[MCP Bridge] Max reconnect attempts reached');
    lastStatus = 'failed';
    updateBadge('ERR', '#f44336');
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(CONFIG.reconnectInterval * Math.pow(1.3, reconnectAttempts - 1), 30000);
  console.log(`[MCP Bridge] Reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, delay);
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// ========== 命令处理 ==========

async function handleCommand(msg) {
  const { id, action, params = {} } = msg;

  try {
    // 处理需要在 background script 中执行的特殊命令
    if (action === 'getAllTabs') {
      try {
        const allTabs = await browser.tabs.query({});
        const tabsInfo = allTabs.map(t => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
        }));
        sendWS({
          id,
          type: 'response',
          success: true,
          data: { tabs: tabsInfo },
        });
      } catch (e) {
        sendWS({
          id,
          type: 'response',
          success: false,
          error: `getAllTabs failed: ${e.message}`,
        });
      }
      return;
    }

    if (action === 'switchTab') {
      try {
        const tabId = params.tabId;
        if (tabId) {
          await browser.tabs.update(tabId, { active: true });
          const tab = await browser.tabs.get(tabId);
          sendWS({
            id,
            type: 'response',
            success: true,
            data: { tabId: tab.id, url: tab.url, title: tab.title },
          });
        } else {
          sendWS({
            id,
            type: 'response',
            success: false,
            error: 'switchTab requires tabId parameter',
          });
        }
      } catch (e) {
        sendWS({
          id,
          type: 'response',
          success: false,
          error: `switchTab failed: ${e.message}`,
        });
      }
      return;
    }

    if (action === 'createTab') {
      try {
        const tab = await browser.tabs.create({ url: params.url || 'about:blank' });
        sendWS({
          id,
          type: 'response',
          success: true,
          data: { tabId: tab.id, url: tab.url, title: tab.title },
        });
      } catch (e) {
        sendWS({
          id,
          type: 'response',
          success: false,
          error: `createTab failed: ${e.message}`,
        });
      }
      return;
    }

    if (action === 'closeTab') {
      try {
        await browser.tabs.remove(params.tabId);
        sendWS({ id, type: 'response', success: true, data: { closed: true } });
      } catch (e) {
        sendWS({
          id,
          type: 'response',
          success: false,
          error: `closeTab failed: ${e.message}`,
        });
      }
      return;
    }

    // 获取活跃标签页
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    let tab = tabs[0];

    // 如果没有活跃标签页，尝试任意标签页
    if (!tab) {
      const allTabs = await browser.tabs.query({});
      if (allTabs.length > 0) tab = allTabs[0];
    }

    if (!tab) {
      sendWS({ id, type: 'response', success: false, error: 'No open tabs' });
      return;
    }

    // 确保 content script 已注入（对 about: 页面跳过）
    if (!tab.url || tab.url.startsWith('about:')) {
      // about: 页面不能注入 content script，但可以返回基本信息
      if (action === 'getUrl') {
        sendWS({
          id, type: 'response', success: true, data: {
            url: tab.url, title: tab.title,
          }, tab: { id: tab.id, url: tab.url, title: tab.title },
        });
        return;
      }
      sendWS({ id, type: 'response', success: false, error: `Cannot execute in about: pages` });
      return;
    }

    // 确保 content script 已注入
    if (!registeredContentTabs.has(tab.id)) {
      try {
        await browser.tabs.executeScript(tab.id, { file: 'content.js' });
        registeredContentTabs.set(tab.id, true);
      } catch (e) {
        // 可能 already injected
      }
    }

    // 发送命令到 content script
    const result = await sendToTab(tab.id, { action, params, commandId: id });

    // 返回结果
    sendWS({
      id,
      type: 'response',
      success: true,
      data: result,
      tab: { id: tab.id, url: tab.url, title: tab.title },
    });
  } catch (e) {
    sendWS({
      id,
      type: 'response',
      success: false,
      error: e.message || String(e),
    });
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    const cmdId = message.commandId || `cmd_${++cmdIdCounter}`;

    const timer = setTimeout(() => {
      pendingCommands.delete(cmdId);
      reject(new Error('Tab response timeout'));
    }, CONFIG.commandTimeout);

    pendingCommands.set(cmdId, { resolve, reject, timer, tabId });

    // content.js 通过 sendResponse() 返回结果 → 这里 .then() 接收
    browser.tabs.sendMessage(tabId, message)
      .then((result) => {
        clearTimeout(timer);
        pendingCommands.delete(cmdId);
        console.log('[MCP Bridge] Content script response:', result?.type, cmdId?.slice(0, 8));
        if (result && result.type === 'command_result') {
          if (result.success) resolve(result.data);
          else reject(new Error(result.error || 'Unknown error'));
        } else {
          resolve(result);
        }
      })
      .catch((err) => {
        clearTimeout(timer);
        pendingCommands.delete(cmdId);
        reject(new Error(`Tab messaging failed: ${err.message}`));
      });
  });
}

// ========== 标签页管理 ==========

async function broadcastActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && isConnected) {
      sendWS({
        type: 'tab_update',
        data: {
          url: tabs[0].url,
          title: tabs[0].title,
          tabId: tabs[0].id,
        },
      });
    }
  } catch (e) {
    // 忽略
  }
}

// ========== 事件监听 ==========

// 标签页切换/更新时通知 MCP
browser.tabs.onActivated.addListener(() => broadcastActiveTab());
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    broadcastActiveTab();
  }
});
browser.tabs.onRemoved.addListener((tabId) => {
  registeredContentTabs.delete(tabId);
});

// 页面导航完成时注入 content script
browser.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId === 0) {
    try {
      await browser.tabs.executeScript(details.tabId, { file: 'content.js' });
      registeredContentTabs.set(details.tabId, true);
    } catch (e) {
      // 某些页面（about:blank 等）不支持注入
    }
  }
});

// 监听来自 popup 的消息
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'get_status') {
    return Promise.resolve(getStatus());
  }
  if (msg.type === 'connect') {
    connectWS();
    return Promise.resolve({ success: true });
  }
  if (msg.type === 'disconnect') {
    disconnect();
    return Promise.resolve({ success: true });
  }
  if (msg.type === 'reconnect') {
    disconnect();
    setTimeout(() => connectWS(), 500);
    return Promise.resolve({ success: true });
  }
  return undefined;
});

// 处理来自 content script 的响应
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'command_result' && msg.commandId) {
    const entry = pendingCommands.get(msg.commandId);
    if (entry) {
      clearTimeout(entry.timer);
      pendingCommands.delete(msg.commandId);
      if (msg.success) {
        entry.resolve(msg.data);
      } else {
        entry.reject(new Error(msg.error || 'Unknown error'));
      }
    }
  }
  return undefined;
});

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = CONFIG.maxReconnectAttempts; // 阻止自动重连
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnected = false;
  lastStatus = 'disconnected';
  updateBadge('OFF', '#888');
}

// ========== 启动 ==========

// 初始化：读取是否启用自动连接
browser.storage.local.get('autoConnect').then((result) => {
  if (result.autoConnect !== false) {
    connectWS();
  }
});

console.log('[MCP Bridge] Background script loaded');