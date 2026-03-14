// ─────────────────────────────────────────────────────────────
// PHANTOM CURSOR — Background Service Worker
// Routes commands from the Claude Code plugin (via CDP) to
// content scripts in active tabs.
// ─────────────────────────────────────────────────────────────

const VERSION = '0.1.0';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, { ...message, source: 'phantom-cursor' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/overlay.css'] });
  } catch (_) { /* Already injected */ }
}

async function dispatch(cmd) {
  const tabId = cmd.tabId || (await getActiveTab())?.id;
  if (!tabId) return { ok: false, error: 'No active tab' };
  await ensureContentScript(tabId);

  switch (cmd.type) {
    case 'move_attention':
      return sendToTab(tabId, { action: 'move_attention', agentId: cmd.agentId || 'default', x: cmd.x, y: cmd.y });
    case 'focus_element':
      return sendToTab(tabId, { action: 'focus_element', agentId: cmd.agentId || 'default', selector: cmd.selector });
    case 'click_element':
      return sendToTab(tabId, { action: 'click_element', agentId: cmd.agentId || 'default', selector: cmd.selector });
    case 'snapshot':
      return sendToTab(tabId, { action: 'snapshot', agentId: cmd.agentId || 'default', rootSelector: cmd.rootSelector || 'body' });
    case 'element_detail':
      return sendToTab(tabId, { action: 'element_detail', agentId: cmd.agentId || 'default', selector: cmd.selector });
    case 'hide_agent':
      return sendToTab(tabId, { action: 'hide_agent', agentId: cmd.agentId });
    case 'remove_agent':
      return sendToTab(tabId, { action: 'remove_agent', agentId: cmd.agentId });
    case 'list_agents':
      return sendToTab(tabId, { action: 'list_agents' });
    case 'navigate':
      await chrome.tabs.update(tabId, { url: cmd.url });
      return { ok: true, tabId, url: cmd.url };
    case 'tab_info': {
      const tab = await chrome.tabs.get(tabId);
      return { ok: true, tabId: tab.id, url: tab.url, title: tab.title };
    }
    default:
      return { ok: false, error: `Unknown command: ${cmd.type}` };
  }
}

// External port for MCP bridge
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener(async (msg) => {
    if (!msg.id || !msg.cmd) return;
    const result = await dispatch(msg.cmd);
    port.postMessage({ id: msg.id, result });
  });
});

// Internal messages (popup, devtools)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'dispatch') { dispatch(msg.cmd).then(sendResponse); return true; }
  if (msg.type === 'version') { sendResponse({ version: VERSION }); return true; }
});

console.log(`[PhantomCursor] Background v${VERSION} ready.`);
