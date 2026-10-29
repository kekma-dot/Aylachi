const grantedTabs = new Set();
let port;

function connect() {
  port = chrome.runtime.connectNative('com.aylachi.satellite');
  port.onMessage.addListener(async message => {
    if (!message || message.type !== 'extract' || typeof message.requestId !== 'string' || typeof message.tabId !== 'string') return;
    const tabId = Number(message.tabId);
    try {
      if (!Number.isInteger(tabId) || !grantedTabs.delete(tabId)) throw new Error('TAB_NOT_GRANTED');
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
        title: document.title, text: (document.body?.innerText ?? '').slice(0, 65536),
      }) });
      const result = injection?.result;
      if (!result || typeof result.title !== 'string' || typeof result.text !== 'string') throw new Error('INVALID_PAGE_RESULT');
      port.postMessage({ type: 'result', requestId: message.requestId, ok: true,
        result: { tabId: message.tabId, title: result.title.slice(0, 4096), text: result.text } });
    } catch {
      port.postMessage({ type: 'result', requestId: message.requestId, ok: false });
    }
  });
  port.onDisconnect.addListener(() => { grantedTabs.clear(); port = undefined; });
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  if (!port) connect();
  grantedTabs.add(tab.id);
});
chrome.tabs.onRemoved.addListener(tabId => grantedTabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => { if (changeInfo.url) grantedTabs.delete(tabId); });
