/**
 * MCP Browser Bridge v2.0 — Popup Script
 * 标签式管理界面：状态 / 标签页 / 网络 / 工具 / 设置
 */
const $ = id => document.getElementById(id);

let netInterval = null;
let consoleCountInterval = null;

function log(msg, type = 'info') {
  const box = $('logBox');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 80) box.removeChild(box.firstChild);
}

function netLog(msg, type = 'info') {
  const box = $('netLogBox');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = msg;
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 100) box.removeChild(box.firstChild);
}

function updateStatus(status) {
  const badge = $('statusBadge');
  badge.className = 'status-badge';
  if (status === 'connected') { badge.classList.add('sc'); badge.textContent = '● 已连接'; }
  else if (status === 'connecting') { badge.classList.add('sg'); badge.textContent = '⟳ 连接中...'; }
  else if (status === 'failed') { badge.classList.add('sf'); badge.textContent = '● 失败'; }
  else { badge.classList.add('sd'); badge.textContent = '● 未连接'; }
}

async function refreshInfo() {
  try {
    const s = await browser.runtime.sendMessage({ type: 'get_status' });
    if (!s) return;
    updateStatus(s.status);
    $('wsUrl').textContent = s.wsUrl;
    $('statusText').textContent = s.status;
    $('reconnectCount').textContent = s.reconnectAttempts;
    $('pendingCount').textContent = s.pendingCount;
    $('cmdStats').textContent = `${s.cmdTotal} / ${s.cmdErrors}`;
    $('uptimeText').textContent = s.uptime ? `${Math.floor(s.uptime / 60)}m${s.uptime % 60}s` : '—';
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      $('pageTitle').textContent = (tabs[0].title || '—').slice(0, 60);
      $('pageUrl').textContent = tabs[0].url || '—';
    }
  } catch (e) {
    log('获取状态失败: ' + e.message, 'err');
  }
}

// ========== 标签页管理 ==========
async function refreshTabList() {
  const list = $('tabList');
  list.innerHTML = '<div class="info-label" style="padding:4px 0">正在加载...</div>';
  try {
    const status = await browser.runtime.sendMessage({ type: 'get_status' });
    const allTabs = await browser.tabs.query({});
    $('tabCount').textContent = `(${allTabs.length})`;
    list.innerHTML = '';
    allTabs.forEach(t => {
      const item = document.createElement('div');
      item.className = 'tab-item';
      const favicon = t.favIconUrl
        ? `<img src="${t.favIconUrl}" style="width:14px;height:14px;border-radius:2px" onerror="this.style.display='none'">`
        : '<span style="width:14px;text-align:center">📄</span>';
      const isActive = t.active ? 'active' : '';
      item.innerHTML = `
        ${favicon}
        <span class="title ${isActive}">${(t.title || '无标题').slice(0, 40)}</span>
        <span class="url-tag">${(t.url || '').slice(0, 30)}</span>
        <button class="btn btn-sm tab-switch" data-id="${t.id}" style="padding:2px 5px;font-size:9px">➡</button>
        <button class="btn btn-sm tab-close" data-id="${t.id}" style="padding:2px 5px;font-size:9px;color:var(--red)">✕</button>
      `;
      list.appendChild(item);
      item.querySelector('.tab-switch')?.addEventListener('click', async () => {
        await browser.tabs.update(t.id, { active: true });
        log(`切换到标签: ${(t.title || '').slice(0, 30)}`, 'ok');
        refreshTabList();
      });
      item.querySelector('.tab-close')?.addEventListener('click', async () => {
        await browser.tabs.remove(t.id);
        log(`关闭标签: ${(t.title || '').slice(0, 30)}`);
        refreshTabList();
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="log-entry err">加载失败: ${e.message}</div>`;
  }
}

// ========== 网络监控 ==========
async function refreshNetwork() {
  try {
    const data = await browser.runtime.sendMessage({ type: 'get_status' });
    // 从 content script 获取网络日志（需要先确保 content script 在活跃页面）
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      try {
        const result = await browser.tabs.sendMessage(tabs[0].id, { action: 'getInterceptedNetwork', params: {}, commandId: '_net' });
        if (result?.data) {
          $('netCount').textContent = result.data.count || 0;
          const box = $('netLogBox');
          box.innerHTML = '';
          (result.data.items || []).slice(0, 50).forEach(item => {
            const entry = document.createElement('div');
            entry.className = `log-entry ${item.status === 'success' ? 'ok' : item.status === 'error' ? 'err' : ''}`;
            const time = new Date(item.startTime).toLocaleTimeString();
            entry.textContent = `[${time}] ${item.method} ${(item.url || '').slice(0, 60)} ${item.statusCode || ''} ${item.duration ? item.duration + 'ms' : ''}`;
            box.appendChild(entry);
          });
          if (!result.data.count) box.innerHTML = '<div class="log-entry">无网络请求记录</div>';
        }
      } catch (e) {
        // content script not injected yet
      }
    }
  } catch (e) { /* ignore */ }
}

// ========== 控制台监控 ==========
async function refreshConsole() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      const result = await browser.tabs.sendMessage(tabs[0].id, { action: 'getCapturedConsole', params: {}, commandId: '_con' });
      if (result?.data) {
        $('consoleCount').textContent = `(${result.data.count || 0})`;
        const box = $('consoleBox');
        box.innerHTML = '';
        (result.data.logs || []).slice(-50).forEach(item => {
          const entry = document.createElement('div');
          entry.className = `log-entry ${item.level === 'error' ? 'err' : item.level === 'warn' ? '' : 'info'}`;
          const time = new Date(item.timestamp).toLocaleTimeString();
          entry.textContent = `[${time}] [${item.level}] ${(item.message || '').slice(0, 200)}`;
          box.appendChild(entry);
        });
        if (!result.data.count) box.innerHTML = '<div class="log-entry">等待捕获...</div>';
      }
    }
  } catch (e) { /* ignore */ }
}

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  log('面板已打开');

  // ---- 标签切换 ----
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`panel-${btn.dataset.tab}`).classList.add('active');
      // 切换到特定标签时刷新
      if (btn.dataset.tab === 'tabs') refreshTabList();
      if (btn.dataset.tab === 'network') refreshNetwork();
    });
  });

  // ---- 连接按钮 ----
  $('btnConnect').addEventListener('click', async () => {
    const r = await browser.runtime.sendMessage({ type: 'connect' });
    if (r?.success) log('正在连接...', 'ok');
  });
  $('btnDisconnect').addEventListener('click', async () => {
    const r = await browser.runtime.sendMessage({ type: 'disconnect' });
    if (r?.success) log('已断开');
  });
  $('btnReconnect').addEventListener('click', async () => {
    const r = await browser.runtime.sendMessage({ type: 'reconnect' });
    if (r?.success) log('正在重连...', 'ok');
  });
  // 状态徽章点击切换
  $('statusBadge').addEventListener('click', async () => {
    const s = await browser.runtime.sendMessage({ type: 'get_status' });
    if (s?.connected) await browser.runtime.sendMessage({ type: 'disconnect' });
    else await browser.runtime.sendMessage({ type: 'connect' });
    setTimeout(refreshInfo, 300);
  });

  // ---- 标签页管理 ----
  $('btnRefreshTabs').addEventListener('click', refreshTabList);
  $('btnCloseAllTabs').addEventListener('click', async () => {
    if (!confirm('确定关闭所有标签页？')) return;
    const tabs = await browser.tabs.query({});
    for (const t of tabs) await browser.tabs.remove(t.id).catch(() => {});
    log(`已关闭 ${tabs.length} 个标签`);
    refreshTabList();
  });
  $('btnListTabs').addEventListener('click', () => {
    document.querySelector('[data-tab="tabs"]').click();
    refreshTabList();
  });

  // ---- 网络监控 ----
  $('btnNetStart').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await browser.tabs.sendMessage(tabs[0].id, { action: 'interceptNetwork', params: { active: true }, commandId: '_net_start' });
      $('netStatus').textContent = '运行中';
      netLog('网络监控已启动', 'ok');
      netInterval = setInterval(refreshNetwork, 2000);
    }
  });
  $('btnNetStop').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await browser.tabs.sendMessage(tabs[0].id, { action: 'interceptNetwork', params: { active: false }, commandId: '_net_stop' });
      $('netStatus').textContent = '已停止';
      netLog('网络监控已停止');
      if (netInterval) { clearInterval(netInterval); netInterval = null; }
    }
  });
  $('btnNetClear').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await browser.tabs.sendMessage(tabs[0].id, { action: 'clearInterceptedNetwork', params: {}, commandId: '_net_clear' });
      $('netCount').textContent = '0';
      $('netLogBox').innerHTML = '<div class="log-entry">已清除</div>';
    }
  });
  $('btnNetRefresh').addEventListener('click', refreshNetwork);

  // ---- 工具 ----
  $('btnRefreshInfo').addEventListener('click', () => { refreshInfo(); log('信息已刷新', 'ok'); });
  $('btnCopyUrl').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      await navigator.clipboard.writeText(tabs[0].url);
      log('URL 已复制', 'ok');
    }
  });
  $('btnCopyTitle').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.title) {
      await navigator.clipboard.writeText(tabs[0].title);
      log('标题已复制', 'ok');
    }
  });
  $('btnStartConsole').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      const r = await browser.tabs.sendMessage(tabs[0].id, { action: 'captureConsole', params: { active: true }, commandId: '_con_start' });
      if (r?.data?.active) {
        log('控制台监控已启动', 'ok');
        if (consoleCountInterval) clearInterval(consoleCountInterval);
        consoleCountInterval = setInterval(refreshConsole, 2000);
        setTimeout(refreshConsole, 500);
      }
    }
  });
  $('btnClearConsole').addEventListener('click', async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await browser.tabs.sendMessage(tabs[0].id, { action: 'clearCapturedConsole', params: {}, commandId: '_con_clr' });
      $('consoleBox').innerHTML = '<div class="log-entry">已清除</div>';
      $('consoleCount').textContent = '(0)';
    }
  });

  // ---- 设置 ----
  const savedWsUrl = (await browser.storage.local.get('wsUrl')).wsUrl;
  if (savedWsUrl) $('wsUrlInput').value = savedWsUrl;
  $('btnSaveWsUrl').addEventListener('click', async () => {
    const url = $('wsUrlInput').value.trim();
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      log('无效的 WebSocket URL', 'err');
      return;
    }
    await browser.runtime.sendMessage({ type: 'set_ws_url', url });
    await browser.runtime.sendMessage({ type: 'reconnect' });
    log(`WebSocket 已设为: ${url}`, 'ok');
    setTimeout(refreshInfo, 1000);
  });

  // ---- 自动刷新 ----
  await refreshInfo();
  setInterval(refreshInfo, 3000);

  log('MCP Bridge v2.0 已就绪', 'ok');
});
