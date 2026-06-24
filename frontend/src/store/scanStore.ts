import { create } from 'zustand';

export interface ScanResult {
  aiFields: string[];
  warnings: string[];
  evidence: string;
}

interface ScanStore {
  scanning: boolean;
  result: ScanResult | null;
  error: string;
  startScan: () => void;
  completeScan: (result: ScanResult) => void;
  failScan: (error: string) => void;
  clearScan: () => void;
}

export const useScanStore = create<ScanStore>((set) => ({
  scanning: false,
  result: null,
  error: '',
  startScan: () => set({ scanning: true, result: null, error: '' }),
  completeScan: (result) => set({ scanning: false, result }),
  failScan: (error) => set({ scanning: false, error }),
  clearScan: () => set({ scanning: false, result: null, error: '' }),
}));
