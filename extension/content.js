/**
 * Flyxa Chart Scanner — Content Script
 *
 * Injected into Flyxa pages (localhost:5173 and flyxa.app).
 * Bridges the extension's service worker → the React app.
 *
 * When background.js sends { type: 'INJECT_SCREENSHOT' }, this script:
 *  1. Reads the pending screenshot from session storage
 *  2. Dispatches a CustomEvent that TradeJournal.tsx is listening for
 *  3. Clears the stored screenshot so it can't be replayed
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'INJECT_SCREENSHOT') return;

  chrome.storage.session.get(['pendingScreenshot', 'capturedAt']).then(({ pendingScreenshot, capturedAt }) => {
    if (!pendingScreenshot) {
      console.warn('[Flyxa extension] No pending screenshot found in session storage.');
      sendResponse({ ok: false, reason: 'no_screenshot' });
      return;
    }

    // Reject stale screenshots (older than 30 seconds)
    if (capturedAt && Date.now() - capturedAt > 30_000) {
      console.warn('[Flyxa extension] Screenshot is stale, ignoring.');
      chrome.storage.session.remove(['pendingScreenshot', 'capturedAt']);
      sendResponse({ ok: false, reason: 'stale' });
      return;
    }

    // Dispatch into the React app
    window.dispatchEvent(
      new CustomEvent('flyxa:ext_screenshot', {
        detail: { base64: pendingScreenshot },
      })
    );

    // Consume — prevent double-inject if content script fires again
    chrome.storage.session.remove(['pendingScreenshot', 'capturedAt']);

    sendResponse({ ok: true });
  });

  // Keep message channel open for async response
  return true;
});
