/**
 * Flyxa Chart Scanner — Background Service Worker
 *
 * Handles two triggers:
 *  - Toolbar icon click  (chrome.action.onClicked)
 *  - Keyboard shortcut   Ctrl+Shift+L  (chrome.commands.onCommand)
 *
 * Flow:
 *  1. Capture the visible tab as a PNG data URL
 *  2. Find or open the Flyxa tab at /scanner
 *  3. Wait for the page to finish loading
 *  4. Inject a script directly into the page's main JS context that
 *     dispatches flyxa:ext_screenshot — React's listener in App.tsx
 *     receives it and fires the scanner automatically
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
    // 1. Capture whatever is currently visible in the active tab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // 2. Find or open the Flyxa tab, always at /scanner
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

    // 3. Wait for the page to fully load (React needs to be mounted)
    await waitForTabReady(tabId);

    // Give React a moment to finish mounting after the load event
    await sleep(350);

    // 4. Inject directly into the page's main JS world — no content script
    //    message passing, no timing guesses. The dataUrl is passed as an arg
    //    so it doesn't need to cross any storage boundary.
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

  } catch (err) {
    console.error('[Flyxa extension] captureAndSend failed:', err);
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
 * Resolves when the tab's status becomes 'complete'.
 * If it's already complete, resolves immediately.
 */
function waitForTabReady(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
      if (tab.status === 'complete') { resolve(); return; }

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab load timed out'));
      }, timeout);

      function listener(updatedTabId, info) {
        if (updatedTabId === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
