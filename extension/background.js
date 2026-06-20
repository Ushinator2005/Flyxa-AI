/**
 * Flyxa Chart Scanner — Background Service Worker
 *
 * Full flow when Ctrl+Shift+L is pressed (or toolbar icon clicked):
 *
 *  1. Capture the visible tab as a full-page PNG                    (📷)
 *  2. Inject a detection script to find the largest canvas element —
 *     the trading chart — and record its bounding rect              (🔍)
 *  3. Crop the screenshot to the chart bounds using OffscreenCanvas
 *     in the service worker (no user interaction required)
 *  4. Show a preview toast in the bottom-right of the chart tab
 *  5. Open / focus Flyxa at /scanner
 *  6. Wait for the page to load, then dispatch flyxa:ext_screenshot
 *     directly into React's JS context — TradeJournal picks it up
 *     and fires the same scanning UI as a drag-and-drop             (✓)
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

    badge('🔍', '#8b5cf6');

    // 2. Detect chart bounds — find the largest visible <canvas> on the page.
    //    Trading platforms (TradingView, Tradovate, FTMO, TopstepX, etc.) all
    //    render charts into <canvas> elements; picking the largest one reliably
    //    isolates the chart from toolbars, sidebars, and order panels.
    const [detectionResult] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: 'MAIN',
      func: () => {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const canvases = Array.from(document.querySelectorAll('canvas'));
        let best = null;
        let bestArea = 0;

        for (const c of canvases) {
          const r = c.getBoundingClientRect();
          // Require meaningful size and at least partially within the viewport
          if (r.width < 200 || r.height < 150) continue;
          if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
          // Clip rect to the visible viewport
          const x = Math.max(0, r.left);
          const y = Math.max(0, r.top);
          const w = Math.min(r.right, W) - x;
          const h = Math.min(r.bottom, H) - y;
          const area = w * h;
          if (area > bestArea) {
            bestArea = area;
            best = { x, y, w, h };
          }
        }

        return {
          bounds: best,       // CSS-pixel rect of the largest chart canvas
          viewportW: W,
          viewportH: H,
          dpr: window.devicePixelRatio || 1,
        };
      },
    });

    const detection = detectionResult?.result ?? null;

    // 3. Crop to chart bounds using OffscreenCanvas in the service worker.
    //    Falls back to the full screenshot if no canvas was detected.
    const croppedDataUrl = detection?.bounds
      ? await cropScreenshot(fullDataUrl, detection.bounds, detection.viewportW, detection.viewportH, detection.dpr)
      : fullDataUrl;

    // 4. Show preview toast in the bottom-right of the chart tab
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: 'MAIN',
      args: [croppedDataUrl, !!detection?.bounds],
      func: showPreviewToast,
    });

    badge('⚡', '#34d399');

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
    await sleep(800); // give React time to mount and register listeners

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

// ─── Crop using OffscreenCanvas in the service worker ─────────────────────────
// Service workers have access to OffscreenCanvas and createImageBitmap, so we
// can crop entirely in the background without injecting anything extra into the
// chart page.

async function cropScreenshot(fullDataUrl, bounds, viewportW, viewportH, dpr) {
  try {
    const response = await fetch(fullDataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    // captureVisibleTab returns an image at physical pixel resolution.
    // Scale factors map CSS pixels → physical pixels in the captured image.
    const scaleX = bitmap.width  / (viewportW * dpr);
    const scaleY = bitmap.height / (viewportH * dpr);

    const sx = Math.round(bounds.x * dpr * scaleX);
    const sy = Math.round(bounds.y * dpr * scaleY);
    const sw = Math.round(bounds.w * dpr * scaleX);
    const sh = Math.round(bounds.h * dpr * scaleY);

    if (sw < 10 || sh < 10) return fullDataUrl; // safety: too small

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

    const outBlob = await canvas.convertToBlob({ type: 'image/png' });

    // FileReader works in service workers to convert blob → data URL
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(outBlob);
    });
  } catch (e) {
    console.warn('[Flyxa] Crop failed, using full screenshot:', e);
    return fullDataUrl;
  }
}

// ─── Preview toast (injected into chart tab) ──────────────────────────────────

function showPreviewToast(base64, chartDetected) {
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
  const label = chartDetected ? 'Chart captured' : 'Screen captured';
  const sub   = chartDetected ? 'Scanning trade…' : 'No chart canvas found — using full screen';
  info.innerHTML = [
    '<div style="color:#34d399;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:5px;">Flyxa</div>',
    `<div style="color:#fff;font-size:12px;font-weight:600;line-height:1.3;margin-bottom:3px;">${label}</div>`,
    `<div style="color:rgba(255,255,255,0.45);font-size:11px;">${sub}</div>`,
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
