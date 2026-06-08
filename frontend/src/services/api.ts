import { createClient } from '@supabase/supabase-js';
import {
  Trade,
  RiskSettings,
  ExtractedTradeData,
  JournalEntry,
  JournalBackupRestoreResult,
} from '../types/index.js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const API_URL = import.meta.env.VITE_API_URL as string || 'http://localhost:3001';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

class ApiService {
  private async getFreshToken(): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return '';
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at !== undefined && session.expires_at < now + 60) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      return refreshed.session?.access_token ?? '';
    }
    return session.access_token;
  }

  private async getHeaders(): Promise<HeadersInit> {
    const token = await this.getFreshToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async getAuthHeader(): Promise<string> {
    const token = await this.getFreshToken();
    return token ? `Bearer ${token}` : '';
  }

  async get<T>(path: string): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch(`${API_URL}${path}`, { headers });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async postFormData<T>(path: string, formData: FormData): Promise<T> {
    const authHeader = await this.getAuthHeader();
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
      },
      body: formData,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch(`${API_URL}${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    const headers = await this.getHeaders();
    const response = await fetch(`${API_URL}${path}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Request failed: ${response.status}`);
    }
  }
}

export const api = new ApiService();

export const tradesApi = {
  getAll: () => api.get<Trade[]>('/api/trades'),
  create: (data: Partial<Trade>) => api.post<Trade>('/api/trades', data),
  update: (id: string, data: Partial<Trade>) => api.put<Trade>(`/api/trades/${id}`, data),
  delete: (id: string) => api.delete(`/api/trades/${id}`),
};

export const analyticsApi = {
  getSummary: () => api.get('/api/analytics/summary'),
  getDailyPnL: () => api.get('/api/analytics/daily-pnl'),
  getEquityCurve: () => api.get('/api/analytics/equity-curve'),
  getBySession: () => api.get('/api/analytics/by-session'),
  getByInstrument: () => api.get('/api/analytics/by-instrument'),
  getByConfluence: () => api.get('/api/analytics/by-confluence'),
  getByDayOfWeek: () => api.get('/api/analytics/by-day-of-week'),
  getByTimeOfDay: () => api.get('/api/analytics/by-time-of-day'),
  getMonthlyHeatmap: (year: number, month: number) =>
    api.get(`/api/analytics/monthly-heatmap?year=${year}&month=${month}`),
  getAdvanced: () => api.get('/api/analytics/advanced'),
};

export const aiApi = {
  scanChart: (
    file: File,
    entryDate: string,
    entryTime: string,
    focusImages: File[] = [],
    scannerContext?: Record<string, unknown>
  ) => {
    const formData = new FormData();
    formData.append('image', file);
    focusImages.forEach(image => formData.append('focusImages', image));
    if (scannerContext) {
      formData.append('scannerContext', JSON.stringify(scannerContext));
    }
    formData.append('entryDate', entryDate);
    formData.append('entryTime', entryTime);
    return api.postFormData<ExtractedTradeData & { warnings?: string[] }>('/api/ai/scan', formData);
  },
  analyzeTradeById: (tradeId: string, trade?: Partial<Trade>) => api.post<{ analysis: string }>(`/api/ai/trade-analysis/${tradeId}`, { trade }),
  analyzePatterns: () => api.post('/api/ai/patterns', {}),
  weeklyReport: (weekStart: string, weekEnd: string) =>
    api.post('/api/ai/weekly-report', { weekStart, weekEnd }),
  psychologyReport: () => api.post('/api/ai/psychology-report', {}),
  flyxaChat: (
    question: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    systemContext?: string
  ) => api.post<{ reply: string }>('/api/ai/flyxa-chat', { question, history, systemContext }),
  filterNews: (headlines: Array<{ headline: string; source: string; timestamp: string; summary?: string; url?: string }>) =>
    api.post<{ items: NewsFilterItem[] }>('/api/ai/filter-news', { headlines }),
};

export interface NewsFilterItem {
  headline: string;
  summary: string;
  impact: 'high' | 'medium' | 'low';
  category: string;
  marketImpact: { es: string; nq: string; note?: string };
  isBreaking: boolean;
  source: string;
  timestamp: string;
  url?: string;
}

export const riskApi = {
  getSettings: () => api.get<RiskSettings>('/api/risk/settings'),
  updateSettings: (data: Partial<RiskSettings>) => api.put<RiskSettings>('/api/risk/settings', data),
  getDailyStatus: () => api.get('/api/risk/daily-status'),
};

export const psychologyApi = {
  getAll: () => api.get('/api/psychology'),
  create: (data: Record<string, unknown>) => api.post('/api/psychology', data),
  update: (id: string, data: Record<string, unknown>) => api.put(`/api/psychology/${id}`, data),
  delete: (id: string) => api.delete(`/api/psychology/${id}`),
  getMindsetChart: () => api.get('/api/psychology/mindset-chart'),
};

export const journalApi = {
  getAll: () => api.get('/api/journal'),
  getById: (id: string) => api.get(`/api/journal/${id}`),
  create: (data: Record<string, unknown>) => api.post('/api/journal', data),
  update: (id: string, data: Record<string, unknown>) => api.put(`/api/journal/${id}`, data),
  delete: (id: string) => api.delete(`/api/journal/${id}`),
  exportBackup: () =>
    api.get<{
      version: number;
      exported_at: string;
      entries: JournalEntry[];
    }>('/api/journal/backup'),
  restoreBackup: (entries: Array<Pick<JournalEntry, 'date' | 'content' | 'screenshots'>>) =>
    api.post<JournalBackupRestoreResult>('/api/journal/backup/restore', { entries }),
};

export const marketDataApi = {
  getChart: (symbol: string, interval: string, range: string) =>
    api.get<Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>>(
      `/api/market-data/chart?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`
    ),
  getFfCalendar: () => api.get<Array<Record<string, unknown>>>('/api/market-data/ff-calendar'),
  getXNews: () => api.get<Array<{ headline: string; source: string; timestamp: string; summary?: string; url?: string }>>('/api/market-data/x-news'),
};

export interface RivalProfileResponse {
  userId: string;
  username: string;
  displayName: string;
  avatarInitials: string;
  avatarColor: string;
  avatarUrl?: string | null;
  stats?: {
    dailyJournalStreak: number;
    dailyJournalScore: number;
    tradingJournalScore: number;
    backtestSessions: number;
    processScore: number;
    winRate?: number | null;
    avgR?: number | null;
  };
}

export interface RivalRequestResponse {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  respondedAt: string | null;
  profile: RivalProfileResponse | null;
}

export const rivalsApi = {
  getProfile: () => api.get<RivalProfileResponse | null>('/api/rivals/profile'),
  updateProfile: (data: { username: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }) =>
    api.put<RivalProfileResponse>('/api/rivals/profile', data),
  updateStats: (stats: NonNullable<RivalProfileResponse['stats']>) =>
    api.put<RivalProfileResponse>('/api/rivals/profile/stats', { stats }),
  search: (username: string) =>
    api.get<RivalProfileResponse | null>(`/api/rivals/search?username=${encodeURIComponent(username)}`),
  getAll: () => api.get<RivalRequestResponse[]>('/api/rivals'),
  sendRequest: (username: string) => api.post<RivalRequestResponse>('/api/rivals/requests', { username }),
  updateRequest: (id: string, action: 'accept' | 'decline' | 'cancel') =>
    api.put<RivalRequestResponse>(`/api/rivals/requests/${id}`, { action }),
};

export interface BillingLivePricesResponse {
  firm: string;
  prices: Record<string, number>;
  source: string;
  fetchedAt: string;
  live: boolean;
  fallback: boolean;
  note?: string;
  unavailableSizes?: string[];
}

export const billingApi = {
  getLivePrices: (firm: string) =>
    api.get<BillingLivePricesResponse>(`/api/billing/live-prices?firm=${encodeURIComponent(firm)}`),
};
