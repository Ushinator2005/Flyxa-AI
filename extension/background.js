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
  'https://flyxa.app',
];
const FLYXA_PROD_SCANNER_URL = 'https://flyxa.app/scanner';

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
    //    Trading platforms embed charts in several ways:
    //      • Direct <canvas>  — TradingView standalone, Tradovate web
    //      • Cross-origin <iframe> containing a canvas — TopstepX, Apex,
    //        FTMO, and any platform embedding TradingView or another provider
    //      • Same-origin <iframe> — some prop firms
    //      • <svg>             — lightweight chart libraries
    //    We cascade through these in order and pick the largest visible element.
    const [detectionResult] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: 'MAIN',
      func: () => {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const info = { viewportW: W, viewportH: H, dpr: window.devicePixelRatio || 1 };

        // Clamp a {left,top,right,bottom} rect to the visible viewport.
        // Returns null if the visible portion is too small.
        function clip(r, minW = 200, minH = 150) {
          const x = Math.max(0, r.left);
          const y = Math.max(0, r.top);
          const w = Math.min(r.right,  W) - x;
          const h = Math.min(r.bottom, H) - y;
          return (w >= minW && h >= minH) ? { x, y, w, h } : null;
        }

        // Pick the largest clipped rect from a NodeList/Array of elements.
        function largest(els, minW = 200, minH = 150) {
          let best = null, bestArea = 0;
          for (const el of els) {
            const rect = clip(el.getBoundingClientRect(), minW, minH);
            if (!rect) continue;
            const area = rect.w * rect.h;
            if (area > bestArea) { bestArea = area; best = rect; }
          }
          return best;
        }

        // Compute the union bounding box of raw DOMRect objects and return
        // a clipped {x,y,w,h} or null. topPad expands the top edge upward
        // (used to capture the HTML chart header that sits above canvas elements).
        function unionBounds(rects, topPad = 0) {
          if (!rects.length) return null;
          let minX = W, minY = H, maxX = 0, maxY = 0;
          for (const r of rects) {
            minX = Math.min(minX, r.left);
            minY = Math.min(minY, r.top);
            maxX = Math.max(maxX, r.right);
            maxY = Math.max(maxY, r.bottom);
          }
          return clip({ left: minX, top: Math.max(0, minY - topPad), right: maxX, bottom: maxY }, 200, 150);
        }

        // Given all canvases in a document (possibly an iframe's doc) and
        // an origin offset, return the full chart bounds including price-axis
        // and time-axis canvases that sit adjacent to the main chart canvas.
        function canvasUnion(canvases, offsetX = 0, offsetY = 0) {
          // Find the main (largest) canvas — the candlestick area
          let mainR = null, mainArea = 0;
          for (const c of canvases) {
            const r = c.getBoundingClientRect();
            if (r.width < 200 || r.height < 150) continue;
            if (r.width * r.height > mainArea) { mainArea = r.width * r.height; mainR = r; }
          }
          if (!mainR) return null;

          // Collect ALL canvases within 150 px of the main canvas — this picks
          // up TradingView's separate price-axis canvas (right) and time-axis
          // canvas (bottom) without grabbing unrelated UI canvases far away.
          const TOL = 150;
          const nearby = canvases
            .map(c => c.getBoundingClientRect())
            .filter(r =>
              r.width >= 10 && r.height >= 10 &&
              r.left   < mainR.right  + TOL && r.right  > mainR.left   - TOL &&
              r.top    < mainR.bottom + TOL && r.bottom > mainR.top    - TOL
            )
            .map(r => ({
              left:   r.left   + offsetX,
              top:    r.top    + offsetY,
              right:  r.right  + offsetX,
              bottom: r.bottom + offsetY,
            }));

          // 60 px top padding captures the HTML header (ticker + timeframe)
          // that sits above the canvas stack and is not itself a canvas.
          return unionBounds(nearby, 60);
        }

        // ── 1. Canvases in the main document ──────────────────────────────────
        // TradingView standalone uses three sibling canvases: main chart area,
        // right price-axis, and bottom time-axis. Taking the union ensures all
        // three — and their price/time labels — are included in the crop.
        const mainDocCanvases = Array.from(document.querySelectorAll('canvas'));
        const mainDocBounds = canvasUnion(mainDocCanvases);
        if (mainDocBounds) return { ...info, bounds: mainDocBounds };

        // ── 2. Canvases inside same-origin iframes ────────────────────────────
        for (const iframe of document.querySelectorAll('iframe')) {
          try {
            const doc = iframe.contentDocument;
            if (!doc) continue;
            const ir = iframe.getBoundingClientRect();
            const iCanvases = Array.from(doc.querySelectorAll('canvas'));
            // getBoundingClientRect() inside an iframe is relative to the
            // iframe's viewport; add the iframe's own offset to convert to
            // main-document coordinates.
            const bounds = canvasUnion(iCanvases, ir.left, ir.top);
            if (bounds) return { ...info, bounds };
          } catch { /* cross-origin iframe — cannot access DOM */ }
        }

        // ── 3. Largest visible iframe (cross-origin embedded chart) ───────────
        // TopstepX, Apex, FTMO embed TradingView (tradingview.com) in a
        // cross-origin iframe. We cannot touch its DOM, so we use the iframe
        // element's own bounding rect and add generous padding so price labels
        // (right) and time labels (bottom) that may sit just outside the iframe
        // boundary are always captured.
        const bigIframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
          const r = f.getBoundingClientRect();
          const vw = Math.min(r.right, W) - Math.max(0, r.left);
          const vh = Math.min(r.bottom, H) - Math.max(0, r.top);
          return vw > 0 && vh > 0 && vw * vh >= W * H * 0.20;
        });
        const iframeBounds = largest(bigIframes, 300, 200);
        if (iframeBounds) {
          const padR = 120; // right: price-axis labels
          const padB = 80;  // bottom: time-axis labels
          return {
            ...info,
            bounds: {
              x: iframeBounds.x,
              y: iframeBounds.y,
              w: Math.min(W - iframeBounds.x, iframeBounds.w + padR),
              h: Math.min(H - iframeBounds.y, iframeBounds.h + padB),
            },
          };
        }

        // ── 4. SVG charts (some lightweight libs) ─────────────────────────────
        const svgBounds = largest(document.querySelectorAll('svg'));
        if (svgBounds) return { ...info, bounds: svgBounds };

        // ── 5. Nothing found — caller will use full screenshot ─────────────────
        return { ...info, bounds: null };
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
      try {
        // Navigate to /scanner on the existing tab's origin (flyxa.app)
        const origin = new URL(flyxaTab.url).origin;
        await chrome.tabs.update(flyxaTab.id, { active: true, url: `${origin}/scanner` });
        if (flyxaTab.windowId) await chrome.windows.update(flyxaTab.windowId, { focused: true });
        tabId = flyxaTab.id;
      } catch {
        // Tab was closed between query and update — open a fresh one
        tabId = (await chrome.tabs.create({ url: FLYXA_PROD_SCANNER_URL })).id;
      }
    } else {
      tabId = (await chrome.tabs.create({ url: FLYXA_PROD_SCANNER_URL })).id;
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
