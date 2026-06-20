/**
 * Flyxa Chart Scanner — Background Service Worker
 *
 * Triggers: toolbar icon click OR Ctrl+Shift+L
 *
 * The extension icon badge shows live status so you can see exactly
 * what step is running or where it fails:
 *   📷  = capturing screenshot
 *   🔍  = waiting for Flyxa tab to load
 *   ⚡  = injecting into page
 *   ✓   = done (clears after 2s)
 *   ERR = something failed (check background console for details)
 */

const FLYXA_URLS = [
  'http://localhost:5173',
  'https://flyxa.app',
];

const FLYXA_OPEN_URL = 'http://localhost:5173/scanner';

// ─── Entry points ─────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(() => {
  captureAndSend();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-chart') {
    captureAndSend();
  }
});

// ─── Core logic ───────────────────────────────────────────────────────────────

async function captureAndSend() {
  try {
    // Step 1 — capture
    badge('📷', '#6366f1');
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) throw new Error('No active tab found');

    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
    if (!dataUrl) throw new Error('captureVisibleTab returned empty');

    badge('🔍', '#f59e0b');

    // Step 2 — find or open Flyxa at /scanner
    const flyxaTab = await findFlyxaTab();
    let tabId;

    if (flyxaTab) {
      await chrome.tabs.update(flyxaTab.id, { active: true, url: FLYXA_OPEN_URL });
      if (flyxaTab.windowId) {
        await chrome.windows.update(flyxaTab.windowId, { focused: true });
      }
      tabId = flyxaTab.id;
    } else {
      const newTab = await chrome.tabs.create({ url: FLYXA_OPEN_URL });
      tabId = newTab.id;
    }

    // Step 3 — wait for page to be fully loaded
    await waitForTabReady(tabId);
    await sleep(400); // let React finish mounting

    // Step 4 — inject directly into the page's main JS context
    badge('⚡', '#8b5cf6');
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [dataUrl],
      func: (base64) => {
        window.dispatchEvent(
          new CustomEvent('flyxa:ext_screenshot', { detail: { base64 } })
        );
      },
    });

    badge('✓', '#34d399');
    setTimeout(() => badge('', ''), 2000);

  } catch (err) {
    console.error('[Flyxa extension] captureAndSend failed:', err.message ?? err);
    badge('ERR', '#f87171');
    setTimeout(() => badge('', ''), 4000);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findFlyxaTab() {
  const allTabs = await chrome.tabs.query({});
  return allTabs.find(tab =>
    tab.url && FLYXA_URLS.some(base => tab.url.startsWith(base))
  ) ?? null;
}

/**
 * Resolves when tab status === 'complete'.
 * Adds the onUpdated listener FIRST to avoid the race where the tab
 * completes between the get() call and the listener being registered.
 */
function waitForTabReady(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timed out after ' + timeout + 'ms'));
    }, timeout);

    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    // Register listener first, then check current state
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        if (!resolved) { resolved = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); reject(chrome.runtime.lastError); }
        return;
      }
      if (tab.status === 'complete' && !resolved) {
        resolved = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
