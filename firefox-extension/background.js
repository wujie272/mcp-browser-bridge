/**
 * MCP Browser Bridge v2.0 — Background Script
 * 管理 WebSocket → MCP 服务，路由命令到 content script
 * 支持: 标签页/书签/历史/下载/窗口/通知/右键菜单
 */
const CONFIG = {
  wsUrl: 'ws://127.0.0.1:9234',
  reconnectInterval: 2000,
  maxReconnectAttempts: 999999,
  commandTimeout: 60000,
};

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pendingCommands = new Map();
let cmdIdCounter = 0;
let registeredTabs = new Set();
let intentDisconnect = false;
let isConnected = false;
let lastStatus = 'disconnected';
let startTime = Date.now();
let cmdTotal = 0;
let cmdErrors = 0;

// ========== 工具 ==========
function getStatus() {
  return {
    connected: isConnected, status: lastStatus,
    pendingCount: pendingCommands.size, wsUrl: CONFIG.wsUrl,
    reconnectAttempts, uptime: Math.round((Date.now() - startTime) / 1000),
    cmdTotal, cmdErrors, activeTabId: null,
  };
}
function updateBadge(text, color) {
  browser.browserAction.setBadgeText({ text });
  if (color) browser.browserAction.setBadgeBackgroundColor({ color });
}

// ========== WebSocket 管理 ==========
function scheduleReconnect() {
  if (reconnectTimer) return;
  if (intentDisconnect) return;
  reconnectAttempts++;
  const delay = Math.min(CONFIG.reconnectInterval * Math.pow(1.3, Math.min(reconnectAttempts, 30)), 60000);
  lastStatus = 'connecting';
  updateBadge('..', '#f0ad4e');
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, delay);
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  lastStatus = 'connecting';
  updateBadge('..', '#f0ad4e');

  try {
    ws = new WebSocket(CONFIG.wsUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnected = true; lastStatus = 'connected';
    reconnectAttempts = 0; updateBadge('ON', '#4CAF50');
    startTime = Date.now();
    sendWS({ type: 'handshake', client: 'firefox-extension', version: '2.0.0', tabs: registeredTabs.size });
    broadcastActiveTab();
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'command') { cmdTotal++; await handleCommand(msg); }
      else if (msg.type === 'ping') sendWS({ type: 'pong', id: msg.id, uptime: Math.round((Date.now()-startTime)/1000) });
    } catch (e) { console.error('[MCP] msg error:', e); }
  };

  ws.onclose = () => {
    isConnected = false; lastStatus = 'disconnected';
    updateBadge('OFF', '#f44336'); ws = null;
    for (const [id, entry] of pendingCommands) {
      entry.reject(new Error('WS disconnected'));
      clearTimeout(entry.timer);
    }
    pendingCommands.clear();
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose fires after */ };
}

function disconnect() {
  intentDisconnect = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  if (ws) { ws.close(); ws = null; }
  isConnected = false; lastStatus = 'disconnected';
  updateBadge('OFF', '#888');
}

// ========== 命令处理 ==========
async function handleCommand(msg) {
  const { id, action, params = {} } = msg;
  try {
    // ---- Background-only 操作（不需要 content script） ----
    if (action === 'getAllTabs') {
      const tabs = (await browser.tabs.query({})).map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
      return sendWS({ id, type: 'response', success: true, data: { tabs } });
    }
    if (action === 'switchTab') {
      if (params.tabId) {
        await browser.tabs.update(params.tabId, { active: true });
        const t = await browser.tabs.get(params.tabId);
        return sendWS({ id, type: 'response', success: true, data: { tabId: t.id, url: t.url, title: t.title } });
      }
      return sendWS({ id, type: 'response', success: false, error: 'tabId required' });
    }
    if (action === 'createTab') {
      const t = await browser.tabs.create({ url: params.url || 'about:blank' });
      return sendWS({ id, type: 'response', success: true, data: { tabId: t.id, url: t.url, title: t.title } });
    }
    if (action === 'closeTab') {
      await browser.tabs.remove(params.tabId);
      return sendWS({ id, type: 'response', success: true, data: { closed: true } });
    }

    // ---- 书签 ----
    if (action === 'getBookmarks') {
      const tree = await browser.bookmarks.getTree();
      function flatten(nodes, path = '') {
        const items = [];
        for (const n of nodes) {
          const p = path ? `${path}/${n.title}` : n.title;
          if (n.url) items.push({ id: n.id, title: n.title, url: n.url, path: path, dateAdded: n.dateAdded });
          if (n.children) items.push(...flatten(n.children, n.url ? path : p));
        }
        return items;
      }
      return sendWS({ id, type: 'response', success: true, data: { bookmarks: flatten(tree).slice(0, 500) } });
    }
    if (action === 'createBookmark') {
      const b = await browser.bookmarks.create({ title: params.title, url: params.url, parentId: params.parentId });
      return sendWS({ id, type: 'response', success: true, data: { id: b.id, title: b.title, url: b.url } });
    }
    if (action === 'removeBookmark') {
      await browser.bookmarks.remove(params.id);
      return sendWS({ id, type: 'response', success: true, data: { removed: true } });
    }

    // ---- 历史 ----
    if (action === 'getHistory') {
      const items = await browser.history.search({ text: params.query || '', maxResults: params.maxResults || 100, startTime: params.startTime, endTime: params.endTime });
      return sendWS({ id, type: 'response', success: true, data: { items: items.map(i => ({ id: i.id, url: i.url, title: i.title, lastVisitTime: i.lastVisitTime, visitCount: i.visitCount })) } });
    }
    if (action === 'deleteHistory') {
      if (params.url) await browser.history.deleteUrl({ url: params.url });
      else if (params.range) await browser.history.deleteRange({ startTime: params.range.start, endTime: params.range.end });
      else await browser.history.deleteAll();
      return sendWS({ id, type: 'response', success: true, data: { deleted: true } });
    }

    // ---- 下载 ----
    if (action === 'downloadFile') {
      const downloadId = await browser.downloads.download({ url: params.url, filename: params.filename, saveAs: params.saveAs });
      return sendWS({ id, type: 'response', success: true, data: { downloadId } });
    }
    if (action === 'getDownloads') {
      const items = await browser.downloads.search({ limit: params.limit || 50 });
      return sendWS({ id, type: 'response', success: true, data: { items: items.map(d => ({ id: d.id, url: d.url, filename: d.filename, totalBytes: d.totalBytes, state: d.state, mime: d.mime, startTime: d.startTime })) } });
    }

    // ---- 窗口 ----
    if (action === 'getAllWindows') {
      const wins = await browser.windows.getAll({ populate: params.populate });
      return sendWS({ id, type: 'response', success: true, data: { windows: wins.map(w => ({ id: w.id, type: w.type, state: w.state, focused: w.focused, tabs: w.tabs?.length, width: w.width, height: w.height })) } });
    }
    if (action === 'createWindow') {
      const w = await browser.windows.create({ url: params.url, state: params.state, type: params.type, width: params.width, height: params.height });
      return sendWS({ id, type: 'response', success: true, data: { windowId: w.id, tabs: w.tabs?.length } });
    }
    if (action === 'closeWindow') {
      await browser.windows.remove(params.windowId);
      return sendWS({ id, type: 'response', success: true, data: { closed: true } });
    }

    // ---- 缩放 ----
    if (action === 'getZoom') {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        const zoom = await browser.tabs.getZoom(tabs[0].id);
        return sendWS({ id, type: 'response', success: true, data: { zoom } });
      }
      return sendWS({ id, type: 'response', success: false, error: 'No active tab' });
    }
    if (action === 'setZoom') {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        await browser.tabs.setZoom(tabs[0].id, params.zoom);
        return sendWS({ id, type: 'response', success: true, data: { zoom: params.zoom } });
      }
      return sendWS({ id, type: 'response', success: false, error: 'No active tab' });
    }

    // ---- 通知 ----
    if (action === 'sendNotification') {
      await browser.notifications.create({
        type: 'basic', iconUrl: browser.runtime.getURL('icons/icon.svg'),
        title: params.title || 'MCP Bridge', message: params.message || '',
      });
      return sendWS({ id, type: 'response', success: true });
    }

    // ---- 获取扩展状态 ----
    if (action === 'getExtensionState') {
      return sendWS({ id, type: 'response', success: true, data: getStatus() });
    }

    // ---- 需要 content script 的操作 ----
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    let tab = tabs[0];
    if (!tab) { const all = await browser.tabs.query({}); if (all.length) tab = all[0]; }
    if (!tab) return sendWS({ id, type: 'response', success: false, error: 'No open tabs' });
    if (!tab.url || tab.url.startsWith('about:')) {
      if (action === 'getUrl') return sendWS({ id, type: 'response', success: true, data: { url: tab.url, title: tab.title }, tab: { id: tab.id, url: tab.url, title: tab.title } });
      return sendWS({ id, type: 'response', success: false, error: 'Cannot execute in about: pages' });
    }

    if (!registeredTabs.has(tab.id)) {
      try { await browser.tabs.executeScript(tab.id, { file: 'content.js' }); registeredTabs.add(tab.id); }
      catch (e) { /* already injected */ }
    }

    const result = await sendToTab(tab.id, { action, params, commandId: id });
    sendWS({ id, type: 'response', success: true, data: result, tab: { id: tab.id, url: tab.url, title: tab.title } });
  } catch (e) {
    cmdErrors++;
    sendWS({ id, type: 'response', success: false, error: e.message || String(e) });
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    const cmdId = message.commandId || `cmd_${++cmdIdCounter}`;
    const timer = setTimeout(() => { pendingCommands.delete(cmdId); reject(new Error('Tab timeout')); }, CONFIG.commandTimeout);
    pendingCommands.set(cmdId, { resolve, reject, timer, tabId });
    browser.tabs.sendMessage(tabId, message)
      .then(r => { clearTimeout(timer); pendingCommands.delete(cmdId); if (r?.type === 'command_result') r.success ? resolve(r.data) : reject(new Error(r.error || 'Unknown')); else resolve(r); })
      .catch(e => { clearTimeout(timer); pendingCommands.delete(cmdId); reject(new Error(`Tab msg: ${e.message}`)); });
  });
}

// ========== 标签页管理 ==========
async function broadcastActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && isConnected) sendWS({ type: 'tab_update', data: { url: tabs[0].url, title: tabs[0].title, tabId: tabs[0].id } });
  } catch (e) { /* ignore */ }
}

// ========== 事件监听 ==========
browser.tabs.onActivated.addListener(() => broadcastActiveTab());
browser.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'complete') broadcastActiveTab(); });
browser.tabs.onRemoved.addListener((tabId) => { registeredTabs.delete(tabId); });

// 注入 content script
browser.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId === 0) {
    try { await browser.tabs.executeScript(details.tabId, { file: 'content.js' }); registeredTabs.add(details.tabId); }
    catch (e) { /* ignore */ }
  }
});

// 下载事件跟踪
browser.downloads.onCreated.addListener((d) => {
  if (isConnected) sendWS({ type: 'download_created', data: { id: d.id, url: d.url, filename: d.filename, totalBytes: d.totalBytes, mime: d.mime, startTime: d.startTime } });
});
browser.downloads.onChanged.addListener((d) => {
  if (d.state && isConnected) sendWS({ type: 'download_changed', data: { id: d.id, state: d.state.current, error: d.error?.current } });
});

// ========== 消息处理（来自 popup） ==========
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_status') return Promise.resolve(getStatus());
  if (msg.type === 'connect') { intentDisconnect = false; connectWS(); return Promise.resolve({ success: true }); }
  if (msg.type === 'disconnect') { disconnect(); return Promise.resolve({ success: true }); }
  if (msg.type === 'reconnect') { disconnect(); setTimeout(() => { intentDisconnect = false; connectWS(); }, 500); return Promise.resolve({ success: true }); }
  if (msg.type === 'set_ws_url') { CONFIG.wsUrl = msg.url; browser.storage.local.set({ wsUrl: msg.url }); return Promise.resolve({ success: true }); }
  if (msg.type === 'command_result' && msg.commandId) {
    const entry = pendingCommands.get(msg.commandId);
    if (entry) { clearTimeout(entry.timer); pendingCommands.delete(msg.commandId); msg.success ? entry.resolve(msg.data) : entry.reject(new Error(msg.error || 'Unknown')); }
  }
  return undefined;
});

// ========== 右键菜单 ==========
browser.contextMenus.create({
  id: 'mcp-copy-url', title: '复制页面 URL', contexts: ['page'],
  onclick: (info, tab) => {
    browser.tabs.executeScript(tab.id, { code: `navigator.clipboard.writeText('${tab.url.replace(/'/g, "\\'")}');` });
  }
});
browser.contextMenus.create({
  id: 'mcp-copy-title', title: '复制页面标题', contexts: ['page'],
  onclick: (info, tab) => {
    browser.tabs.executeScript(tab.id, { code: `navigator.clipboard.writeText('${(tab.title||'').replace(/'/g, "\\'")}');` });
  }
});
browser.contextMenus.create({
  id: 'mcp-separator', type: 'separator', contexts: ['page'],
});
browser.contextMenus.create({
  id: 'mcp-reconnect', title: '⟳ 重连 MCP Bridge', contexts: ['page'],
  onclick: () => { disconnect(); setTimeout(() => { intentDisconnect = false; connectWS(); }, 500); }
});

// ========== 启动 ==========
browser.storage.local.get(['wsUrl', 'autoConnect']).then((result) => {
  if (result.wsUrl) CONFIG.wsUrl = result.wsUrl;
  intentDisconnect = false;
  connectWS();
  // 保险：5 秒后还没连上再试一次
  setTimeout(() => { if (!isConnected && !intentDisconnect) { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } connectWS(); } }, 5000);
});

console.log('[MCP Bridge v2.0] Loaded');
