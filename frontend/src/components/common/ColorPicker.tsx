import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GRAYSCALE = [
  '#FFFFFF', '#D1D4DC', '#A3A7B5', '#787B8E',
  '#545775', '#363A4E', '#2A2E39', '#1E2030', '#131722', '#000000',
];

const COLOR_ROWS: string[][] = [
  ['#FFD2D2','#FFE0CC','#FFF0C8','#FFFBCC','#E2FFC8','#C8FFC8','#C8FFE8','#C8EEFF','#D8C8FF','#FFC8F0'],
  ['#FFB3B3','#FFBF99','#FFD999','#FFF799','#C8EF99','#99EF99','#99EFD5','#99D5EF','#B399EF','#EF99D5'],
  ['#FF8080','#FF9966','#FFB833','#FFE033','#99D633','#66CC66','#33CCAA','#33AACC','#7766CC','#CC66AA'],
  ['#FF4D4D','#FF7033','#FF9B00','#FFCB00','#66BB00','#33AA33','#00AA77','#0088BB','#5544BB','#BB4488'],
  ['#FF0000','#FF4500','#FF8C00','#FFB800','#33A300','#00A300','#008866','#006699','#4400CC','#990066'],
  ['#CC0000','#CC3600','#CC7000','#CC9400','#268000','#007A00','#006650','#004D77','#330099','#770055'],
  ['#990000','#992800','#995500','#996C00','#1A6000','#005A00','#004D3A','#003855','#250075','#550040'],
  ['#660000','#661A00','#663A00','#664800','#104000','#003A00','#003328','#002438','#18004D','#38002A'],
  ['#330000','#330C00','#331C00','#332400','#082000','#001A00','#001A14','#00121C','#0C0024','#1C0015'],
];

const PALETTE: string[][] = [GRAYSCALE, ...COLOR_ROWS];

const SWATCH_SIZE = 18;
const SWATCH_GAP = 2;
const COLS = 10;
const PICKER_WIDTH = COLS * SWATCH_SIZE + (COLS - 1) * SWATCH_GAP + 24;

interface ColorPickerPanelProps {
  value: string;
  opacity: number;
  onColorChange: (hex: string) => void;
  onOpacityChange: (pct: number) => void;
}

function ColorPickerPanel({ value, opacity, onColorChange, onOpacityChange }: ColorPickerPanelProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const trackRef = useRef<HTMLDivElement>(null);

  function commitCustom() {
    const trimmed = customInput.trim().replace(/^#+/, '#').replace(/^([^#])/, '#$1');
    if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
      onColorChange(trimmed.toUpperCase());
      setCustomInput('');
      setShowCustom(false);
    }
  }

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.round(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)));
    onOpacityChange(pct);
  }

  const normalizedValue = value.startsWith('#') ? value : `#${value}`;

  return (
    <div
      style={{
        width: PICKER_WIDTH,
        background: '#1A1D2A',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '8px',
        padding: '12px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
      }}
    >
      {/* Color grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${SWATCH_GAP}px` }}>
        {PALETTE.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: `${SWATCH_GAP}px` }}>
            {row.map(color => {
              const selected = color.toUpperCase() === normalizedValue.toUpperCase();
              return (
                <button
                  key={color}
                  type="button"
                  title={color}
                  onClick={() => onColorChange(color)}
                  style={{
                    width: SWATCH_SIZE,
                    height: SWATCH_SIZE,
                    flexShrink: 0,
                    borderRadius: '3px',
                    background: color,
                    border: selected
                      ? '2px solid rgba(255,255,255,0.9)'
                      : '1px solid rgba(0,0,0,0.25)',
                    cursor: 'pointer',
                    padding: 0,
                    outline: selected ? '1px solid rgba(0,0,0,0.5)' : 'none',
                    outlineOffset: '1px',
                    boxSizing: 'border-box',
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Custom "+" row */}
      <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          type="button"
          title="Enter custom hex color"
          onClick={() => setShowCustom(s => !s)}
          style={{
            width: SWATCH_SIZE,
            height: SWATCH_SIZE,
            flexShrink: 0,
            borderRadius: '3px',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.22)',
            color: 'rgba(255,255,255,0.55)',
            fontSize: '16px',
            lineHeight: 1,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        >
          +
        </button>
        {showCustom && (
          <input
            autoFocus
            type="text"
            value={customInput}
            placeholder="#RRGGBB"
            onChange={e => setCustomInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitCustom(); if (e.key === 'Escape') setShowCustom(false); }}
            onBlur={commitCustom}
            style={{
              flex: 1,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '11px',
              fontFamily: 'var(--font-mono, monospace)',
              padding: '3px 7px',
              outline: 'none',
            }}
          />
        )}
      </div>

      {/* Opacity section */}
      <div style={{ marginTop: '12px' }}>
        <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.38)', marginBottom: '8px', userSelect: 'none' }}>
          Opacity
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Slider track */}
          <div
            ref={trackRef}
            onClick={handleTrackClick}
            style={{
              flex: 1,
              position: 'relative',
              height: '6px',
              borderRadius: '3px',
              cursor: 'pointer',
              background: `linear-gradient(to right, transparent, ${normalizedValue})`,
            }}
          >
            {/* Thumb */}
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: `${opacity}%`,
                transform: 'translate(-50%, -50%)',
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                background: normalizedValue,
                border: '2px solid #fff',
                boxShadow: '0 1px 4px rgba(0,0,0,0.55)',
                pointerEvents: 'none',
              }}
            />
            {/* Invisible range for drag */}
            <input
              type="range"
              min={0}
              max={100}
              value={opacity}
              onChange={e => onOpacityChange(Number(e.target.value))}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0,
                cursor: 'pointer',
                margin: 0,
              }}
            />
          </div>

          {/* Percentage input */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '4px',
              padding: '3px 6px',
              gap: '2px',
              flexShrink: 0,
            }}
          >
            <input
              type="number"
              min={0}
              max={100}
              value={opacity}
              onChange={e => onOpacityChange(Math.min(100, Math.max(0, Number(e.target.value))))}
              style={{
                width: '28px',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#fff',
                fontSize: '11px',
                fontFamily: 'var(--font-mono, monospace)',
                textAlign: 'right',
                padding: 0,
                appearance: 'textfield' as React.CSSProperties['appearance'],
              }}
            />
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', userSelect: 'none' }}>%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ColorSwatchPickerProps {
  value: string;
  onChange: (hex: string) => void;
  size?: number;
  radius?: number;
  ariaLabel?: string;
}

/**
 * A bare colour swatch that opens the TradingView-style palette popover.
 * Use when the surrounding layout supplies its own label/hex text.
 */
export function ColorSwatchPicker({ value, onChange, size = 28, radius = 7, ariaLabel }: ColorSwatchPickerProps) {
  const [open, setOpen] = useState(false);
  const [opacity, setOpacity] = useState(100);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      const insideTrigger = rootRef.current?.contains(target) ?? false;
      const insidePanel = panelRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insidePanel) setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  function handleToggle() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const panelH = 340;
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow >= panelH + 8 ? rect.bottom + 6 : Math.max(8, rect.top - panelH - 6);
      let left = rect.left;
      if (left + PICKER_WIDTH > window.innerWidth - 8) left = window.innerWidth - PICKER_WIDTH - 8;
      setPopoverPos({ top, left: Math.max(8, left) });
    }
    setOpen(o => !o);
  }

  const hex = value.startsWith('#') ? value : `#${value}`;

  return (
    <span ref={rootRef} style={{ display: 'inline-block', position: 'relative', lineHeight: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        onClick={handleToggle}
        style={{
          display: 'block',
          width: size,
          height: size,
          borderRadius: radius,
          background: hex,
          border: `1px solid ${open ? 'rgba(245,158,11,0.6)' : 'rgba(255,255,255,0.16)'}`,
          cursor: 'pointer',
          padding: 0,
        }}
      />
      {open && popoverPos && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', top: popoverPos.top, left: popoverPos.left, zIndex: 9999 }}>
          <ColorPickerPanel
            value={hex}
            opacity={opacity}
            onColorChange={color => onChange(color)}
            onOpacityChange={setOpacity}
          />
        </div>,
        document.body,
      )}
    </span>
  );
}

interface ColorPickerFieldProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (hex: string) => void;
}

export default function ColorPickerField({ label, hint, value, onChange }: ColorPickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [opacity, setOpacity] = useState(100);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      const insideTrigger = rootRef.current?.contains(target) ?? false;
      const insidePanel   = panelRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insidePanel) setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  function handleToggle() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Prefer opening below; if too close to bottom, open above
      const panelH = 260; // approximate height
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow >= panelH + 8
        ? rect.bottom + 6
        : rect.top - panelH - 6;
      setPopoverPos({ top, left: rect.left });
    }
    setOpen(o => !o);
  }

  const hex = value.startsWith('#') ? value : `#${value}`;

  return (
    <div ref={rootRef} style={{ position: 'relative', userSelect: 'none' }}>
      {/* Trigger row */}
      <button
        ref={triggerRef}
        type="button"
        title={hint}
        onClick={handleToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          background: 'var(--app-panel-strong)',
          border: `1px solid ${open ? 'rgba(245,158,11,0.5)' : 'var(--app-border)'}`,
          borderRadius: '6px',
          padding: '8px 10px',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'border-color 0.15s',
        }}
      >
        {/* Color swatch */}
        <span
          style={{
            display: 'block',
            width: '24px',
            height: '24px',
            borderRadius: '5px',
            background: hex,
            border: '1px solid rgba(255,255,255,0.15)',
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--app-text)', marginBottom: '2px' }}>
            {label}
          </p>
          <p style={{ fontSize: '10px', color: 'var(--app-text-subtle)', fontFamily: 'var(--font-mono, monospace)' }}>
            {hex.toUpperCase()}
          </p>
        </div>
      </button>

      {/* Popover — rendered as a portal so it's never clipped by overflow:hidden ancestors */}
      {open && popoverPos && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: popoverPos.top,
            left: popoverPos.left,
            zIndex: 9999,
          }}
        >
          <ColorPickerPanel
            value={hex}
            opacity={opacity}
            onColorChange={color => { onChange(color); }}
            onOpacityChange={setOpacity}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
