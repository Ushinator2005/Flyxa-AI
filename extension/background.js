/**
 * Flyxa Chart Scanner — Background Service Worker
 *
 * Full flow when Ctrl+Shift+L is pressed (or toolbar icon clicked):
 *
 *  1. Capture the visible tab as a full-page PNG
 *  2. Inject capture-overlay.js into the chart tab — the user sees the
 *     screenshot with a selection rectangle and can drag to pick just
 *     the chart area, then press Enter (or click "Scan chart")
 *  3. Poll for the confirmed, cropped image
 *  4. Show a preview toast in the bottom-right of the chart tab
 *  5. Open / focus Flyxa at /scanner
 *  6. Wait for the page to load, then dispatch flyxa:ext_screenshot
 *     directly into React's JS context — App.tsx fires the scanner
 *     with the same UI as a drag-and-drop
 */

const FLYXA_URLS = [
  'http://localhost:5173',
  'https://flyxa.app',
];
const FLYXA_SCANNER_URL = 'http://localhost:5173/scanner';

// ─── Entry points ─────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(() => { captureAndSend(); });

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-chart') captureAndSend();
});

// ─── Core flow ────────────────────────────────────────────────────────────────

async function captureAndSend() {
  try {
    badge('📷', '#6366f1');

    // 1. Get the active tab and capture it
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) throw new Error('No active tab');

    const fullDataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
    if (!fullDataUrl) throw new Error('captureVisibleTab returned empty');

    // 2. Stash the screenshot in a global on the page, then inject the overlay
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: 'MAIN',
      args: [fullDataUrl],
      func: (data) => {
        // Clear any previous state
        delete window.__flyxaCapture;
        delete window.__flyxaCancelled;
        window.__flyxaScreenshot = data;
      },
    });

    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: 'MAIN',
      files: ['capture-overlay.js'],
    });

    badge('✂️', '#f59e0b');

    // 3. Poll until the user confirms or cancels (max 60 seconds)
    const croppedDataUrl = await pollForCapture(activeTab.id, 60_000);
    if (!croppedDataUrl) {
      badge('', '');
      return; // user pressed Esc
    }

    // 4. Show preview toast in the bottom-right of the chart tab
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: 'MAIN',
      args: [croppedDataUrl],
      func: showPreviewToast,
    });

    badge('🔍', '#8b5cf6');

    // 5. Find or open Flyxa at /scanner
    const flyxaTab = await findFlyxaTab();
    let tabId;

    if (flyxaTab) {
      await chrome.tabs.update(flyxaTab.id, { active: true, url: FLYXA_SCANNER_URL });
      if (flyxaTab.windowId) await chrome.windows.update(flyxaTab.windowId, { focused: true });
      tabId = flyxaTab.id;
    } else {
      tabId = (await chrome.tabs.create({ url: FLYXA_SCANNER_URL })).id;
    }

    // 6. Wait for the page to finish loading, then inject the event
    await waitForTabReady(tabId);
    await sleep(400); // let React finish mounting

    badge('⚡', '#34d399');

    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [croppedDataUrl],
      func: (base64) => {
        window.dispatchEvent(
          new CustomEvent('flyxa:ext_screenshot', { detail: { base64 } })
        );
      },
    });

    badge('✓', '#34d399');
    setTimeout(() => badge('', ''), 2000);

  } catch (err) {
    console.error('[Flyxa] captureAndSend failed:', err?.message ?? err);
    badge('ERR', '#f87171');
    setTimeout(() => badge('', ''), 4000);
  }
}

// ─── Preview toast (injected into chart tab) ──────────────────────────────────

function showPreviewToast(base64) {
  document.getElementById('flyxa-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'flyxa-toast';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
    background: '#0f1115', border: '1.5px solid #34d399', borderRadius: '12px',
    padding: '12px 14px 12px 12px',
    display: 'flex', alignItems: 'center', gap: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
    transform: 'translateY(100px)', opacity: '0',
    transition: 'transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.25s ease',
    pointerEvents: 'none',
  });

  const img = document.createElement('img');
  img.src = base64;
  Object.assign(img.style, {
    width: '130px', height: '76px', objectFit: 'cover',
    borderRadius: '6px', border: '1px solid rgba(255,255,255,0.08)', flexShrink: '0',
  });

  const info = document.createElement('div');
  info.innerHTML = [
    '<div style="color:#34d399;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:5px;">Flyxa</div>',
    '<div style="color:#fff;font-size:12px;font-weight:600;line-height:1.3;margin-bottom:3px;">Chart captured</div>',
    '<div style="color:rgba(255,255,255,0.45);font-size:11px;">Scanning trade…</div>',
  ].join('');

  toast.appendChild(img);
  toast.appendChild(info);
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  }));

  // Animate out after 5 s
  setTimeout(() => {
    toast.style.transform = 'translateY(100px)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 350);
  }, 5000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function pollForCapture(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (window.__flyxaCancelled) { delete window.__flyxaCancelled; return { cancelled: true }; }
        if (window.__flyxaCapture)  { const d = window.__flyxaCapture; delete window.__flyxaCapture; return { data: d }; }
        return null;
      },
    });
    const val = result?.result;
    if (val?.cancelled) return null;
    if (val?.data)      return val.data;
  }
  return null;
}

async function findFlyxaTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(t => t.url && FLYXA_URLS.some(b => t.url.startsWith(b))) ?? null;
}

function waitForTabReady(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timed out'));
    }, timeout);

    function listener(id, info) {
      if (id !== tabId || info.status !== 'complete' || done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab.status === 'complete' && !done) {
        done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    });
  });
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
