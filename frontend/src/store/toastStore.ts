import { create } from 'zustand';

export type ToastTone = 'amber' | 'red' | 'green';

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number | null;
  /** Breaking-news treatment: solid red, pulsing, dismissed only by click. */
  emphasis?: boolean;
  /** Small label above the message (e.g. "BREAKING · Reuters · 2 min ago"). */
  kicker?: string;
  /** Navigate here when the toast body is clicked (also dismisses it). */
  href?: string;
}

interface ToastState {
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, 'id'>) => string;
  dismissToast: (id: string) => void;
}

function shouldSuppressToast() {
  return typeof window !== 'undefined' && window.location.pathname === '/trade-check';
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  pushToast: (toast) => {
    if (shouldSuppressToast()) return '';
    const id = crypto.randomUUID();
    // null means persistent — only substitute the default when the caller
    // omitted the field entirely (`?? 5000` would swallow null too).
    const durationMs = toast.durationMs === undefined ? 5000 : toast.durationMs;
    set((state) => ({ toasts: [...state.toasts, { ...toast, durationMs, id }] }));
    if (durationMs !== null) {
      window.setTimeout(() => {
        useToastStore.getState().dismissToast(id);
      }, durationMs);
    }
    return id;
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function pushToast(toast: Omit<ToastItem, 'id'>): string {
  return useToastStore.getState().pushToast(toast);
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismissToast(id);
}
