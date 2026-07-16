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
  private async getFreshToken(forceRefresh = false): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return '';
    const now = Math.floor(Date.now() / 1000);
    if (forceRefresh || (session.expires_at !== undefined && session.expires_at < now + 60)) {
      const { data: refreshed, error } = await supabase.auth.refreshSession();
      if (error) return '';
      return refreshed.session?.access_token ?? '';
    }
    return session.access_token;
  }

  private async getHeaders(forceRefresh = false): Promise<Record<string, string>> {
    const token = await this.getFreshToken(forceRefresh);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async getAuthHeader(forceRefresh = false): Promise<string> {
    const token = await this.getFreshToken(forceRefresh);
    return token ? `Bearer ${token}` : '';
  }

  private async parseError(response: Response): Promise<Error> {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    return new Error(err.error || `Request failed: ${response.status}`);
  }

  async get<T>(path: string): Promise<T> {
    let headers = await this.getHeaders();
    let response = await fetch(`${API_URL}${path}`, { headers });
    if (response.status === 401) {
      headers = await this.getHeaders(true);
      if (headers.Authorization) {
        response = await fetch(`${API_URL}${path}`, { headers });
      }
    }
    if (!response.ok) {
      throw await this.parseError(response);
    }
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    let headers = await this.getHeaders();
    let response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      headers = await this.getHeaders(true);
      if (headers.Authorization) {
        response = await fetch(`${API_URL}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      }
    }
    if (!response.ok) {
      throw await this.parseError(response);
    }
    return response.json() as Promise<T>;
  }

  async postFormData<T>(path: string, formData: FormData, options: { timeoutMs?: number } = {}): Promise<T> {
    const authHeader = await this.getAuthHeader();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = options.timeoutMs;
    const timeoutId = controller && timeoutMs && timeoutMs > 0
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      const buildHeaders = (authHeaderValue: string): HeadersInit => (
        authHeaderValue ? { Authorization: authHeaderValue } : {}
      );

      let response = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: buildHeaders(authHeader),
        body: formData,
        signal: controller?.signal,
      });
      if (response.status === 401) {
        const refreshedAuthHeader = await this.getAuthHeader(true);
        if (refreshedAuthHeader) {
          response = await fetch(`${API_URL}${path}`, {
            method: 'POST',
            headers: buildHeaders(refreshedAuthHeader),
            body: formData,
            signal: controller?.signal,
          });
        }
      }
      if (!response.ok) {
        throw await this.parseError(response);
      }
      return response.json() as Promise<T>;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Scanner request timed out. Please retry with a clearer/cropped screenshot.');
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    let headers = await this.getHeaders();
    let response = await fetch(`${API_URL}${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      headers = await this.getHeaders(true);
      if (headers.Authorization) {
        response = await fetch(`${API_URL}${path}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body),
        });
      }
    }
    if (!response.ok) {
      throw await this.parseError(response);
    }
    return response.json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    let headers = await this.getHeaders();
    let response = await fetch(`${API_URL}${path}`, {
      method: 'DELETE',
      headers,
    });
    if (response.status === 401) {
      headers = await this.getHeaders(true);
      if (headers.Authorization) {
        response = await fetch(`${API_URL}${path}`, {
          method: 'DELETE',
          headers,
        });
      }
    }
    if (!response.ok) {
      throw await this.parseError(response);
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
    return api.postFormData<ExtractedTradeData & { warnings?: string[] }>('/api/ai/scan', formData, { timeoutMs: 120_000 });
  },
  analyzeTradeById: (tradeId: string, trade?: Partial<Trade>, history?: Partial<Trade>[]) =>
    api.post<{ analysis: string }>(`/api/ai/trade-analysis/${tradeId}`, { trade, history }),
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

export const journalApi = (() => {
  // Deduplicate concurrent getAll() calls that fire simultaneously on page mount
  // (Layout's useRivalStatsSync + Journal/Dashboard/Rivals components all call this).
  let inflightGetAll: Promise<unknown> | null = null;
  return {
    getAll: (): Promise<unknown> => {
      if (!inflightGetAll) {
        inflightGetAll = api.get('/api/journal').finally(() => {
          inflightGetAll = null;
        });
      }
      return inflightGetAll;
    },
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
    restoreBackup: (entries: Array<Pick<JournalEntry, 'date' | 'content' | 'screenshots' | 'mood'>>) =>
      api.post<JournalBackupRestoreResult>('/api/journal/backup/restore', { entries }),
  };
})();

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
  getCandles: (symbol: string, timeframe: string, from?: number, to?: number) => {
    const params = new URLSearchParams({
      symbol,
      timeframe,
    });
    if (from != null) params.set('from', String(from));
    if (to != null) params.set('to', String(to));
    return api.get<Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>>(`/api/market-data/candles?${params.toString()}`);
  },
  importCandles: (payload: {
    symbol: string;
    timeframe: string;
    candles: Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
  }) => api.post<{
    symbol: string;
    timeframe: string;
    imported: number;
    start: string | null;
    end: string | null;
  }>('/api/market-data/import-csv', payload),
  importDatabentoCandles: (payload: {
    symbol: string;
    timeframe: string;
    range: string;
    start?: string | number;
    end?: string | number;
  }) => api.post<{
    symbol: string;
    timeframe: string;
    imported: number;
    start: string | null;
    end: string | null;
  }>('/api/market-data/databento/import', payload),
  getSavedSymbols: () =>
    api.get<Array<{ symbol: string; timeframe: string }>>('/api/market-data/symbols'),
  getFfCalendar: () => api.get<Array<Record<string, unknown>>>('/api/market-data/ff-calendar'),
  getXNews: (accounts?: string) => {
    const query = accounts?.trim() ? `?accounts=${encodeURIComponent(accounts)}` : '';
    return api.get<Array<{ headline: string; source: string; timestamp: string; summary?: string; url?: string }>>(`/api/market-data/x-news${query}`);
  },
};

export interface RivalProfileResponse {
  userId: string;
  username: string;
  displayName: string;
  avatarInitials: string;
  avatarColor: string;
  avatarUrl?: string | null;
  stats?: {
    lifetimeXp?: number;
    dailyJournalStreak: number;
    dailyJournalScore: number;
    tradingJournalScore: number;
    backtestSessions: number;
    processScore: number;
    winRate?: number | null;
    avgR?: number | null;
    netPnl?: number | null;
    periods?: import('../types/rivals.js').MascotStats['periods'];
    previousPeriods?: import('../types/rivals.js').MascotStats['previousPeriods'];
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

export const rivalsApi = (() => {
  // Deduplicate concurrent getProfile() calls (Sidebar + useRivalStatsSync + useRivals all
  // call this on every page mount). Cache the result for 30s; invalidate on save.
  let inflightGetProfile: Promise<RivalProfileResponse | null> | null = null;
  let profileCache: { value: RivalProfileResponse | null; at: number } | null = null;
  const PROFILE_CACHE_TTL = 30_000;

  function getProfileCached(): Promise<RivalProfileResponse | null> {
    if (profileCache && Date.now() - profileCache.at < PROFILE_CACHE_TTL) {
      return Promise.resolve(profileCache.value);
    }
    if (inflightGetProfile) return inflightGetProfile;
    inflightGetProfile = api.get<RivalProfileResponse | null>('/api/rivals/profile')
      .then(data => {
        profileCache = { value: data, at: Date.now() };
        inflightGetProfile = null;
        return data;
      })
      .catch(err => {
        inflightGetProfile = null;
        throw err;
      });
    return inflightGetProfile;
  }

  function invalidateProfileCache() {
    profileCache = null;
    inflightGetProfile = null;
  }

  return {
    getProfile: getProfileCached,
    updateProfile: (data: { username: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }) => {
      invalidateProfileCache();
      return api.put<RivalProfileResponse>('/api/rivals/profile', data);
    },
    updateStats: (stats: NonNullable<RivalProfileResponse['stats']>) => {
      invalidateProfileCache();
      return api.put<RivalProfileResponse>('/api/rivals/profile/stats', { stats });
    },
    search: (username: string) =>
      api.get<RivalProfileResponse | null>(`/api/rivals/search?username=${encodeURIComponent(username)}`),
    getAll: () => api.get<RivalRequestResponse[]>('/api/rivals'),
    sendRequest: (username: string) => api.post<RivalRequestResponse>('/api/rivals/requests', { username }),
    updateRequest: (id: string, action: 'accept' | 'decline' | 'cancel') =>
      api.put<RivalRequestResponse>(`/api/rivals/requests/${id}`, { action }),
  };
})();

export const accountApi = {
  reset: () => api.post<{ ok: boolean; preserved: string[] }>('/api/account/reset', {}),
};

export interface SharedTradeRecord {
  shareId: string;
  sharedAt: string;
  sharedByUserId: string;
  sharedByProfile: {
    user_id: string;
    username: string;
    display_name: string | null;
    avatar_color: string;
    avatar_url: string | null;
  } | null;
  trade: Trade;
}

export const tradeSharesApi = {
  getSharedWithMe: () => api.get<SharedTradeRecord[]>('/api/trades/shared-with-me'),
  share: (tradeId: string, rivalUserId: string, tradeData: Trade) =>
    api.post<{ id: string }>('/api/trades/share', { tradeId, rivalUserId, tradeData }),
  unshare: (tradeId: string, rivalUserId: string) =>
    api.delete(`/api/trades/share/${tradeId}/${rivalUserId}`),
};

export interface RivalMessage {
  id: string;
  senderId: string;
  content: string;
  createdAt: string;
}

export const rivalMessagesApi = {
  get: (rivalUserId: string) =>
    api.get<RivalMessage[]>(`/api/rivals/messages/${rivalUserId}`),
  send: (toUserId: string, content: string) =>
    api.post<RivalMessage>('/api/rivals/messages', { toUserId, content }),
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

export interface SubscriptionStatusResponse {
  configured: boolean;
  active: boolean;
  status: string;
  currentPeriodEnd?: string | null;
  hasCustomer?: boolean;
}

export const subscriptionApi = {
  getStatus: () => api.get<SubscriptionStatusResponse>('/api/subscription/status'),
  startCheckout: () => api.post<{ url: string }>('/api/subscription/checkout', {}),
  openPortal: () => api.post<{ url: string }>('/api/subscription/portal', {}),
};

export const waitlistApi = {
  join: (email: string, source: string) =>
    api.post<{ ok: boolean; already: boolean }>('/api/waitlist', { email, source }),
};

export interface PropFirmRuleRecordResponse {
  id: string;
  firm: string;
  program: string;
  path: 'standard' | 'no_activation_fee';
  accountSize: number;
  profitTarget: number;
  maximumLossLimit: number;
  dailyLossLimit: number | null;
  optionalDailyLossLimit: number | null;
  responsibleTradingDiscount: number;
  responsibleTradingBenefit: string;
  maximumContracts: number;
  maximumMicros: number;
  consistencyTargetPct: number;
  minimumTradingDays: number;
  drawdownType: 'trailing';
  activationFee: number;
  monthlyPrice: number;
  version: number;
  status: 'verified' | 'draft' | 'retired';
  effectiveFrom: string;
  verifiedAt: string;
  sourceUrl: string;
  secondarySourceUrls: string[];
  note: string;
}

export const propFirmRulesApi = {
  getTopstep: () => api.get<{
    rules: PropFirmRuleRecordResponse[];
    source: string;
    fallback: boolean;
    note?: string;
  }>('/api/prop-firm-rules?firm=Topstep'),
};
