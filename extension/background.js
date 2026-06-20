/**
 * Flyxa Chart Scanner — Background Service Worker
 *
 * Handles two triggers:
 *  - Toolbar icon click (chrome.action.onClicked)
 *  - Keyboard shortcut Ctrl+Shift+L (chrome.commands.onCommand)
 *
 * Flow:
 *  1. Capture the visible tab as a PNG data URL
 *  2. Store it in session storage (auto-cleared when browser closes)
 *  3. Find or open the Flyxa tab
 *  4. Tell the Flyxa content script to inject the screenshot into the page
 */

const FLYXA_URLS = [
  'http://localhost:5173',
  'https://flyxa.app',
];

const FLYXA_OPEN_URL = 'http://localhost:5173/journal';

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
    // 1. Capture the active tab in the current window
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // 2. Store in session storage (survives navigation, cleared on browser close)
    await chrome.storage.session.set({
      pendingScreenshot: dataUrl,
      capturedAt: Date.now(),
    });

    // 3. Find or open Flyxa, always landing on /journal so the listener is mounted
    const flyxaTab = await findFlyxaTab();
    let tabId;

    if (flyxaTab) {
      // Navigate to /journal (React Router handles this; content script stays injected)
      await chrome.tabs.update(flyxaTab.id, { active: true, url: FLYXA_OPEN_URL });
      if (flyxaTab.windowId) {
        await chrome.windows.update(flyxaTab.windowId, { focused: true });
      }
      tabId = flyxaTab.id;
    } else {
      // Open a new Flyxa tab directly at /journal
      const newTab = await chrome.tabs.create({ url: FLYXA_OPEN_URL });
      tabId = newTab.id;
    }

    // 4. Send message to content script — give React time to mount, then retry
    await sendWithRetry(tabId, { type: 'INJECT_SCREENSHOT' });

  } catch (err) {
    console.error('[Flyxa extension] captureAndSend failed:', err);
  }
}

async function findFlyxaTab() {
  const allTabs = await chrome.tabs.query({});
  return allTabs.find(tab =>
    tab.url && FLYXA_URLS.some(base => tab.url.startsWith(base))
  ) ?? null;
}

async function sendWithRetry(tabId, message, retries = 2, delayMs = 900) {
  for (let attempt = 0; attempt < retries; attempt++) {
    await sleep(attempt === 0 ? 600 : delayMs);
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return; // success
    } catch {
      if (attempt === retries - 1) {
        console.error('[Flyxa extension] Could not reach content script after', retries, 'attempts');
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
