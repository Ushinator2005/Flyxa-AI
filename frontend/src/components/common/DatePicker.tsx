import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  align?: 'left' | 'right';
  compact?: boolean;
  fullWidth?: boolean;
  min?: string;
  max?: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function toIsoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return parsed;
}

function formatLabel(value: string, placeholder: string) {
  const parsed = parseIsoDate(value);
  if (!parsed) return placeholder;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function monthGrid(monthDate: Date) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export default function DatePicker({
  value,
  onChange,
  disabled = false,
  className,
  style,
  placeholder = 'Select date',
  align = 'right',
  compact = false,
  fullWidth = false,
  min,
  max,
}: DatePickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number; right?: number } | null>(null);
  const selectedDate = parseIsoDate(value);
  const [viewDate, setViewDate] = useState(() => selectedDate ?? new Date());

  useEffect(() => {
    if (selectedDate) setViewDate(selectedDate);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    if (align === 'left') {
      setPopupPos({ top: rect.bottom + 8, left: rect.left });
    } else {
      setPopupPos({ top: rect.bottom + 8, left: rect.right - 286 });
    }
  }, [open, align]);

  const cells = useMemo(() => monthGrid(viewDate), [viewDate]);
  const todayIso = toIsoDate(new Date());
  const selectedIso = selectedDate ? toIsoDate(selectedDate) : '';

  const moveMonth = (delta: number) => {
    setViewDate(current => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  const choose = (date: Date) => {
    const iso = toIsoDate(date);
    if ((min && iso < min) || (max && iso > max)) return;
    onChange(iso);
    setOpen(false);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: fullWidth ? 'block' : 'inline-block', width: fullWidth ? '100%' : undefined }}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        className={className}
        style={{
          height: compact ? 30 : 40,
          width: fullWidth ? '100%' : undefined,
          minWidth: compact ? 128 : 158,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          borderRadius: compact ? 6 : 8,
          border: '1px solid var(--app-border, rgba(255,255,255,0.10))',
          background: 'var(--app-panel-strong, rgba(255,255,255,0.045))',
          color: 'var(--app-text, #e8e3dc)',
          padding: compact ? '0 9px' : '0 12px',
          fontSize: compact ? 11 : 12.5,
          fontFamily: 'var(--font-sans)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          boxSizing: 'border-box',
          ...style,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <CalendarDays size={compact ? 13 : 15} color="var(--amber, #f59e0b)" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {formatLabel(value, placeholder)}
          </span>
        </span>
      </button>

      {open && popupPos && createPortal(
        <div
          role="dialog"
          aria-label="Choose date"
          style={{
            position: 'fixed',
            top: popupPos.top,
            left: popupPos.left,
            zIndex: 9999,
            width: 286,
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'linear-gradient(180deg, rgba(26,25,23,0.98), rgba(14,13,13,0.98))',
            boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
            padding: 12,
            backdropFilter: 'blur(16px)',
          } as CSSProperties}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <button type="button" onClick={() => moveMonth(-1)} style={navButtonStyle} aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <div style={{ textAlign: 'center' }}>
              <p style={{ margin: 0, color: 'var(--app-text, #e8e3dc)', fontSize: 13, fontWeight: 800 }}>
                {MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
              </p>
            </div>
            <button type="button" onClick={() => moveMonth(1)} style={navButtonStyle} aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 5 }}>
            {DAYS.map(day => (
              <span key={day} style={{ color: 'var(--app-text-subtle, #5c5751)', fontSize: 9, fontWeight: 800, textAlign: 'center' }}>
                {day}
              </span>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {cells.map(date => {
              const iso = toIsoDate(date);
              const isCurrentMonth = date.getMonth() === viewDate.getMonth();
              const isSelected = iso === selectedIso;
              const isToday = iso === todayIso;
              const isDisabled = Boolean((min && iso < min) || (max && iso > max));
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => choose(date)}
                  style={{
                    height: 32,
                    borderRadius: 7,
                    border: isSelected ? '1px solid rgba(245,158,11,0.75)' : isToday ? '1px solid rgba(96,165,250,0.4)' : '1px solid transparent',
                    background: isSelected ? 'rgba(245,158,11,0.18)' : isToday ? 'rgba(96,165,250,0.10)' : 'transparent',
                    color: isDisabled ? 'rgba(138,129,120,0.20)' : isSelected ? '#fbbf24' : isCurrentMonth ? 'var(--app-text, #e8e3dc)' : 'rgba(138,129,120,0.38)',
                    fontSize: 12,
                    fontWeight: isSelected || isToday ? 800 : 600,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

const navButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.035)',
  color: 'var(--app-text-muted, #8a8178)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};
