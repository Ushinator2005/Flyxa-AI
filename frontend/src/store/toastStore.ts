import { create } from 'zustand';

export type ToastTone = 'amber' | 'red' | 'green';

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number | null;
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
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
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
