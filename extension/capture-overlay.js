/**
 * Flyxa Capture Overlay — injected into MAIN world of the chart tab.
 *
 * Reads:   window.__flyxaScreenshot  (set by background.js before injection)
 * Writes:  window.__flyxaCapture     (cropped PNG data URL, read by background.js)
 *          window.__flyxaCancelled   (set on ESC)
 *
 * UX:
 *  - Screenshot fills the viewport, rest of page dimmed
 *  - Default selection = full visible area (ready to confirm immediately)
 *  - Drag to draw a new selection
 *  - Enter / Space = confirm   |   Esc = cancel
 *  - A "Scan" button appears in the top-right corner of the selection
 */
(function () {
  const src = window.__flyxaScreenshot;
  if (!src) return;

  // Clean up any previous overlay
  document.getElementById('flyxa-sel-overlay')?.remove();

  const W = window.innerWidth;
  const H = window.innerHeight;
  const DPR = window.devicePixelRatio || 1;

  // ── Overlay root ────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'flyxa-sel-overlay';
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    cursor: 'crosshair', userSelect: 'none', WebkitUserSelect: 'none',
  });

  // ── Canvas ──────────────────────────────────────────────────────────────────
  const cvs = document.createElement('canvas');
  cvs.width = W * DPR; cvs.height = H * DPR;
  Object.assign(cvs.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  root.appendChild(cvs);
  const ctx = cvs.getContext('2d');
  ctx.scale(DPR, DPR);

  // ── Scan button ─────────────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.textContent = 'Scan chart';
  Object.assign(btn.style, {
    position: 'absolute', zIndex: '1',
    padding: '7px 14px', borderRadius: '7px',
    border: '1.5px solid #34d399', background: 'rgba(17,20,24,0.95)',
    color: '#34d399', fontSize: '12px', fontWeight: '700',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    cursor: 'pointer', letterSpacing: '0.04em', display: 'none',
  });
  btn.addEventListener('mousedown', (e) => { e.stopPropagation(); confirm(); });
  root.appendChild(btn);

  // ── State ────────────────────────────────────────────────────────────────────
  let sel = { x: 0, y: 0, w: W, h: H }; // default = full area
  let dragging = false;
  let dragOrigin = { x: 0, y: 0 };

  // ── Image ───────────────────────────────────────────────────────────────────
  const img = new Image();
  img.onload = () => { draw(); };
  img.src = src;

  // ── Rendering ───────────────────────────────────────────────────────────────
  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Dim the full screenshot
    ctx.drawImage(img, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(0, 0, W, H);

    // Bright window — clip to selection and redraw at full brightness
    if (sel.w > 0 && sel.h > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(sel.x, sel.y, sel.w, sel.h);
      ctx.clip();
      ctx.drawImage(img, 0, 0, W, H);
      ctx.restore();

      // Border
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);

      // Corner handles
      const hs = 7;
      ctx.fillStyle = '#34d399';
      [
        [sel.x,           sel.y          ],
        [sel.x + sel.w - hs, sel.y       ],
        [sel.x,           sel.y + sel.h - hs],
        [sel.x + sel.w - hs, sel.y + sel.h - hs],
      ].forEach(([hx, hy]) => ctx.fillRect(hx, hy, hs, hs));

      // Size label
      ctx.fillStyle = '#34d399';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(sel.w)} × ${Math.round(sel.h)}`, sel.x + 4, sel.y - 5);

      // Position scan button above top-right corner of selection
      btn.style.display = 'block';
      btn.style.left = (sel.x + sel.w - 110) + 'px';
      btn.style.top  = Math.max(4, sel.y - 40) + 'px';
    }

    // Hint bar at bottom
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, H - 34, W, 34);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Drag to select · Enter or click "Scan chart" to capture · Esc to cancel', W / 2, H - 12);
  }

  // ── Mouse ───────────────────────────────────────────────────────────────────
  cvs.addEventListener('mousedown', (e) => {
    dragging = true;
    dragOrigin = { x: e.clientX, y: e.clientY };
    sel = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    btn.style.display = 'none';
  });

  cvs.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.min(dragOrigin.x, e.clientX);
    const y = Math.min(dragOrigin.y, e.clientY);
    sel = { x, y, w: Math.abs(e.clientX - dragOrigin.x), h: Math.abs(e.clientY - dragOrigin.y) };
    draw();
  });

  cvs.addEventListener('mouseup', () => { dragging = false; });

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { cancel(); }
  }
  document.addEventListener('keydown', onKey);

  // ── Confirm / cancel ─────────────────────────────────────────────────────────
  function confirm() {
    const crop = document.createElement('canvas');
    // Crop in physical pixels
    const px = Math.round(sel.x * DPR);
    const py = Math.round(sel.y * DPR);
    const pw = Math.round(sel.w * DPR);
    const ph = Math.round(sel.h * DPR);

    if (pw < 20 || ph < 20) {
      // Fallback to full image if selection is too tiny
      window.__flyxaCapture = src;
    } else {
      crop.width = pw; crop.height = ph;
      const cctx = crop.getContext('2d');
      // Draw from the original image at physical pixel coords
      const scaleX = img.naturalWidth / (W * DPR);
      const scaleY = img.naturalHeight / (H * DPR);
      cctx.drawImage(img,
        px * scaleX, py * scaleY, pw * scaleX, ph * scaleY,
        0, 0, pw, ph
      );
      window.__flyxaCapture = crop.toDataURL('image/png');
    }
    cleanup();
  }

  function cancel() {
    window.__flyxaCancelled = true;
    cleanup();
  }

  function cleanup() {
    document.removeEventListener('keydown', onKey);
    root.remove();
    delete window.__flyxaScreenshot;
  }

  document.body.appendChild(root);
})();
