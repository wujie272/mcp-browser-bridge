/**
 * MCP Browser Bridge - Popup Script
 */

const $ = id => document.getElementById(id);

function log(msg, type = 'info') {
  const box = $('logBox');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'ok' ? 'ok' : type === 'err' ? 'err' : ''}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
  // 限制日志条目
  while (box.children.length > 50) box.removeChild(box.firstChild);
}

function updateStatus(status) {
  const badge = $('statusBadge');
  badge.className = 'status-badge';
  switch (status) {
    case 'connected':
      badge.classList.add('status-connected');
      badge.textContent = '● 已连接';
      break;
    case 'disconnected':
      badge.classList.add('status-disconnected');
      badge.textContent = '● 未连接';
      break;
    case 'connecting':
      badge.classList.add('status-connecting');
      badge.textContent = '⟳ 连接中...';
      break;
    case 'failed':
      badge.classList.add('status-failed');
      badge.textContent = '● 连接失败';
      break;
    default:
      badge.classList.add('status-disconnected');
      badge.textContent = '● 未知';
  }
}

async function refreshInfo() {
  try {
    const status = await browser.runtime.sendMessage({ type: 'get_status' });
    if (!status) return;

    updateStatus(status.status);
    $('wsUrl').textContent = status.wsUrl;
    $('reconnectCount').textContent = status.reconnectAttempts;
    $('pendingCount').textContent = status.pendingCount;

    // 获取当前标签页
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      $('pageTitle').textContent = tabs[0].title || '—';
      $('pageUrl').textContent = tabs[0].url || '—';
    }
  } catch (e) {
    log('获取状态失败: ' + e.message, 'err');
  }
}

// ========== 初始化 ==========

document.addEventListener('DOMContentLoaded', async () => {
  log('面板已打开');

  // 按钮事件
  $('btnConnect').addEventListener('click', async () => {
    const result = await browser.runtime.sendMessage({ type: 'connect' });
    if (result?.success) log('正在连接...', 'ok');
  });

  $('btnDisconnect').addEventListener('click', async () => {
    const result = await browser.runtime.sendMessage({ type: 'disconnect' });
    if (result?.success) log('已断开连接');
  });

  $('btnReconnect').addEventListener('click', async () => {
    const result = await browser.runtime.sendMessage({ type: 'reconnect' });
    if (result?.success) log('正在重新连接...', 'ok');
  });

  $('btnRefreshInfo').addEventListener('click', () => {
    refreshInfo();
    log('信息已刷新', 'ok');
  });

  // 首次刷新
  await refreshInfo();

  // 每 3 秒自动刷新
  setInterval(refreshInfo, 3000);
});