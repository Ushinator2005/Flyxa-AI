import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppPreferences, Trade, TradingAccount } from '../types/index.js';
import { useAuth } from './AuthContext.js';
import { deriveTradeSessionLabel } from '../utils/sessionTimes.js';
import {
  ALL_ACCOUNTS_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_TRADING_ACCOUNT,
  ensureDefaultAccount,
  normalizeAccountStatus,
  normalizeAccountType,
  resolveDefaultTradeAccountId,
} from '../utils/tradingAccounts.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Account } from '../store/types.js';
import { supabase } from '../services/api.js';

export { ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID } from '../utils/tradingAccounts.js';
const DEFAULT_TIMEZONE = 'America/New_York';


const SUPPORTED_TIMEZONE_SET = (() => {
  const intlWithSupportedValues = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intlWithSupportedValues.supportedValuesOf?.('timeZone') ?? [];

  if (!zones.includes(DEFAULT_TIMEZONE)) {
    zones.push(DEFAULT_TIMEZONE);
  }

  return new Set(zones);
})();

const DEFAULT_ACCOUNT: TradingAccount = DEFAULT_TRADING_ACCOUNT;

const DEFAULT_PREFERENCES: AppPreferences = {
  dateFormat: 'dd/MM/yyyy',
  currencySymbol: '$',
  timezone: DEFAULT_TIMEZONE,
  defaultTimeframe: '5m',
  defaultChartType: 'Candles',
  sessionTimes: {
    asia: { start: '19:00', end: '04:00' },
    london: { start: '03:00', end: '11:30' },
    preMarket: { start: '07:00', end: '09:30' },
    newYork: { start: '09:30', end: '16:00' },
  },
  scannerColors: {
    entry: '#E67E22',
    stopLoss: '#C0392B',
    takeProfit: '#1A6B5A',
  },
};

const DEFAULT_CONFLUENCE_OPTIONS = [
  'Liquidity sweep',
  'VWAP reclaim',
  'HTF bias',
  'Session high/low sweep',
  'Market structure shift',
  'Order block retest',
  'Volume confirmation',
];

function normalizeConfluenceOption(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

function normalizeConfluenceOptions(values: unknown): string[] {
  const source = Array.isArray(values) ? values : [];
  const deduped = new Set<string>();
  const normalized: string[] = [];

  for (const value of source) {
    const cleaned = normalizeConfluenceOption(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (deduped.has(key)) continue;
    deduped.add(key);
    normalized.push(cleaned);
    if (normalized.length >= 64) break;
  }

  return normalized.length ? normalized : [...DEFAULT_CONFLUENCE_OPTIONS];
}

function normalizeSessionTimes(raw: unknown): AppPreferences['sessionTimes'] {
  const isValidTime = (value: unknown): value is string => (
    typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value)
  );

  const readTime = (value: unknown, fallback: string) => (isValidTime(value) ? value : fallback);
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const asia = typeof input.asia === 'object' && input.asia !== null ? input.asia as Record<string, unknown> : {};
  const london = typeof input.london === 'object' && input.london !== null ? input.london as Record<string, unknown> : {};
  const preMarket = typeof input.preMarket === 'object' && input.preMarket !== null ? input.preMarket as Record<string, unknown> : {};
  const newYork = typeof input.newYork === 'object' && input.newYork !== null ? input.newYork as Record<string, unknown> : {};

  return {
    asia: {
      start: readTime(asia.start, DEFAULT_PREFERENCES.sessionTimes.asia.start),
      end: readTime(asia.end, DEFAULT_PREFERENCES.sessionTimes.asia.end),
    },
    london: {
      start: readTime(london.start, DEFAULT_PREFERENCES.sessionTimes.london.start),
      end: readTime(london.end, DEFAULT_PREFERENCES.sessionTimes.london.end),
    },
    preMarket: {
      start: readTime(preMarket.start, DEFAULT_PREFERENCES.sessionTimes.preMarket.start),
      end: readTime(preMarket.end, DEFAULT_PREFERENCES.sessionTimes.preMarket.end),
    },
    newYork: {
      start: readTime(newYork.start, DEFAULT_PREFERENCES.sessionTimes.newYork.start),
      end: readTime(newYork.end, DEFAULT_PREFERENCES.sessionTimes.newYork.end),
    },
  };
}

interface AppSettingsContextValue {
  accounts: TradingAccount[];
  preferences: AppPreferences;
  confluenceOptions: string[];
  selectedAccountId: string;
  defaultTradeAccountId: string;
  setSelectedAccountId: (accountId: string) => void;
  addAccount: (account: Omit<TradingAccount, 'id' | 'createdAt'>) => void;
  updateAccount: (accountId: string, updates: Partial<Omit<TradingAccount, 'id' | 'createdAt'>>) => void;
  deleteAccount: (accountId: string) => void;
  addConfluenceOption: (option: string) => void;
  updateConfluenceOption: (index: number, option: string) => void;
  deleteConfluenceOption: (index: number) => void;
  updatePreferences: (updates: Partial<AppPreferences>) => void;
  getDefaultTradeAccountId: () => string;
  resolveTradeAccountId: (trade: Partial<Trade>) => string;
  isTradeAccountAllocatable: (accountId: string) => boolean;
  decorateTrades: (trades: Trade[]) => Trade[];
  filterTradesBySelectedAccount: (trades: Trade[]) => Trade[];
  persistTradeAccount: (tradeId: string, accountId?: string) => void;
  removeTradeAccount: (tradeId: string) => void;
}

const AppSettingsContext = createContext<AppSettingsContextValue | undefined>(undefined);

// localStorage keys kept only for one-time migration
function getAccountsKey(userId: string) { return `tw_accounts_${userId}`; }
function getPreferencesKey(userId: string) { return `tw_preferences_${userId}`; }
function getSelectedAccountKey(userId: string) { return `tw_selected_account_${userId}`; }
function getTradeAccountsKey(userId: string) { return `tw_trade_accounts_${userId}`; }
function getConfluenceOptionsKey(userId: string) { return `tw_confluence_options_${userId}`; }

interface AppSettingsRow {
  accounts?: TradingAccount[];
  preferences?: Partial<AppPreferences>;
  selectedAccountId?: string;
  tradeAccounts?: Record<string, string>;
  confluenceOptions?: string[];
}

async function loadAppSettingsFromSupabase(userId: string): Promise<AppSettingsRow | null> {
  try {
    const [settingsResult, accountsResult] = await Promise.all([
      supabase.from('user_store').select('app_settings').eq('user_id', userId).maybeSingle(),
      supabase.from('trading_accounts').select('id, name, broker, type, status, color, starting_balance, created_at').eq('user_id', userId),
    ]);

    if (settingsResult.error) return null;

    const row: AppSettingsRow = settingsResult.data?.app_settings
      ? { ...(settingsResult.data.app_settings as AppSettingsRow) }
      : {};

    if (!accountsResult.error && accountsResult.data?.length) {
      // Always merge trading_accounts into app_settings — this recovers any accounts that
      // were lost from app_settings (e.g. after a localStorage clear + timing race) while
      // preserving accounts that already exist in app_settings.
      const existingIds = new Set((row.accounts ?? []).map(a => a.id));

      const missingAccounts: TradingAccount[] = accountsResult.data
        .filter(a => !existingIds.has(a.id as string))
        .map(a => ({
          id: a.id as string,
          name: a.name as string,
          broker: (a.broker as string | null) ?? '',
          type: normalizeAccountType(a.type),
          status: normalizeAccountStatus(a.status),
          color: (a.color as string | null) ?? '#6366f1',
          createdAt: a.created_at as string,
          ...(a.starting_balance != null ? { startingBalance: Number(a.starting_balance) } : {}),
        }));

      if (missingAccounts.length > 0) {
        row.accounts = [...(row.accounts ?? []), ...missingAccounts];
      }

      // Also merge starting_balance for any existing accounts that are missing it
      const balanceMap = new Map<string, number | null>(
        accountsResult.data.map(a => [a.id as string, a.starting_balance != null ? Number(a.starting_balance) : null])
      );
      row.accounts = (row.accounts ?? []).map(account => ({
        ...account,
        startingBalance: account.startingBalance
          ?? (balanceMap.has(account.id) && balanceMap.get(account.id) != null
            ? (balanceMap.get(account.id) as number)
            : undefined),
      }));
    }

    // Only fall through to localStorage migration if there is truly nothing to load
    if (!settingsResult.data?.app_settings && !row.accounts?.length) return null;

    return row;
  } catch { /* fall through to localStorage migration */ }
  return null;
}

async function saveAppSettingsToSupabase(userId: string, row: AppSettingsRow): Promise<void> {
  try {
    await supabase.from('user_store').upsert(
      { user_id: userId, app_settings: row, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  } catch { /* silently fail */ }
}

function migrateFromLocalStorage(userId: string): AppSettingsRow {
  const tryParse = (raw: string | null) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
  return {
    accounts: tryParse(localStorage.getItem(getAccountsKey(userId))) ?? undefined,
    preferences: tryParse(localStorage.getItem(getPreferencesKey(userId))) ?? undefined,
    selectedAccountId: localStorage.getItem(getSelectedAccountKey(userId)) ?? undefined,
    tradeAccounts: tryParse(localStorage.getItem(getTradeAccountsKey(userId))) ?? undefined,
    confluenceOptions: tryParse(localStorage.getItem(getConfluenceOptionsKey(userId))) ?? undefined,
  };
}

function parsePreferences(parsed: Partial<AppPreferences> | undefined): AppPreferences {
  if (!parsed) return DEFAULT_PREFERENCES;
  const rawTimezone = parsed.timezone ?? DEFAULT_TIMEZONE;
  return {
    ...DEFAULT_PREFERENCES,
    ...parsed,
    timezone: SUPPORTED_TIMEZONE_SET.has(rawTimezone) ? rawTimezone : DEFAULT_TIMEZONE,
    sessionTimes: normalizeSessionTimes(parsed.sessionTimes),
    scannerColors: {
      ...DEFAULT_PREFERENCES.scannerColors,
      ...(typeof parsed.scannerColors === 'object' && parsed.scannerColors !== null ? parsed.scannerColors as object : {}),
    },
  };
}

export function AppSettingsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const hydrateSharedData = useFlyxaStore(state => state.hydrateSharedData);
  const setActiveAccount = useFlyxaStore(state => state.setActiveAccount);
  const updateScannerColors = useFlyxaStore(state => state.updateScannerColors);
  const [accounts, setAccounts] = useState<TradingAccount[]>([DEFAULT_ACCOUNT]);
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [confluenceOptions, setConfluenceOptions] = useState<string[]>([...DEFAULT_CONFLUENCE_OPTIONS]);
  const [selectedAccountId, setSelectedAccountIdState] = useState<string>(ALL_ACCOUNTS_ID);
  const [tradeAccounts, setTradeAccounts] = useState<Record<string, string>>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadDone = useRef(false);

  // Refs to hold latest state values for use in callbacks that don't re-create on state change
  const accountsRef = useRef(accounts);
  const preferencesRef = useRef(preferences);
  const confluenceOptionsRef = useRef(confluenceOptions);
  const selectedAccountIdRef = useRef(selectedAccountId);
  const tradeAccountsRef = useRef(tradeAccounts);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  useEffect(() => { confluenceOptionsRef.current = confluenceOptions; }, [confluenceOptions]);
  useEffect(() => { selectedAccountIdRef.current = selectedAccountId; }, [selectedAccountId]);
  useEffect(() => { tradeAccountsRef.current = tradeAccounts; }, [tradeAccounts]);

  // Load from Supabase on user login
  useEffect(() => {
    if (!user) {
      setAccounts([DEFAULT_ACCOUNT]);
      setPreferences(DEFAULT_PREFERENCES);
      setConfluenceOptions([...DEFAULT_CONFLUENCE_OPTIONS]);
      setSelectedAccountIdState(ALL_ACCOUNTS_ID);
      setTradeAccounts({});
      initialLoadDone.current = false;
      return;
    }

    void (async () => {
      let row = await loadAppSettingsFromSupabase(user.id);

      // First time: migrate from localStorage.
      if (!row || Object.values(row).every(v => v === undefined)) {
        row = migrateFromLocalStorage(user.id);
        if (Object.values(row).some(v => v !== undefined)) {
          void saveAppSettingsToSupabase(user.id, row);
        }
      }

      const nextAccounts = Array.isArray(row.accounts) ? ensureDefaultAccount(row.accounts) : [DEFAULT_ACCOUNT];
      setAccounts(nextAccounts);
      setPreferences(parsePreferences(row.preferences));
      setConfluenceOptions(normalizeConfluenceOptions(row.confluenceOptions));
      setTradeAccounts(
        row.tradeAccounts && typeof row.tradeAccounts === 'object'
          ? Object.fromEntries(Object.entries(row.tradeAccounts).filter((e): e is [string, string] => typeof e[1] === 'string'))
          : {}
      );
      const stored = row.selectedAccountId ?? ALL_ACCOUNTS_ID;
      setSelectedAccountIdState(stored === ALL_ACCOUNTS_ID || nextAccounts.some(a => a.id === stored) ? stored : ALL_ACCOUNTS_ID);
      initialLoadDone.current = true;
    })();
  }, [user]);

  // Debounced save to Supabase whenever any settings change
  const scheduleSave = useCallback(() => {
    if (!user || !initialLoadDone.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveAppSettingsToSupabase(user.id, {
        accounts: ensureDefaultAccount(accounts),
        preferences,
        selectedAccountId,
        tradeAccounts,
        confluenceOptions,
      });
    }, 1500);
  }, [user, accounts, preferences, selectedAccountId, tradeAccounts, confluenceOptions]);

  useEffect(() => { scheduleSave(); }, [scheduleSave]);

  useEffect(() => {
    const mapped: Account[] = accounts.map(account => {
      const sb = account.startingBalance ?? 0;
      return {
        id: account.id,
        name: account.name,
        firm: account.broker || 'Flyxa',
        size: sb,
        type: account.status === 'Live' ? 'live' : account.status === 'Funded' ? 'live' : 'eval',
        phase: account.status === 'Funded' ? 'funded' : 'eval',
        balance: sb,
        dailyLossLimit: 2500,
        maxDrawdown: 3000,
        profitTarget: null,
        startingBalance: sb,
        isActive: true,
        color: account.color,
      };
    });
    hydrateSharedData({ accounts: mapped });
  }, [accounts, hydrateSharedData]);

  useEffect(() => {
    setActiveAccount(selectedAccountId === ALL_ACCOUNTS_ID ? null : selectedAccountId);
  }, [selectedAccountId, setActiveAccount]);

  useEffect(() => {
    updateScannerColors(preferences.scannerColors);
  }, [preferences.scannerColors, updateScannerColors]);

  const validAccountIds = useMemo(() => new Set(accounts.map(account => account.id)), [accounts]);
  const accountById = useMemo(
    () => new Map(accounts.map(account => [account.id, account] as const)),
    [accounts]
  );
  const defaultTradeAccountId = useMemo(
    () => resolveDefaultTradeAccountId(accounts),
    [accounts]
  );

  const isTradeAccountAllocatable = useCallback((accountId: string) => {
    const account = accountById.get(accountId);
    return Boolean(account && account.status !== 'Blown');
  }, [accountById]);

  const getDefaultTradeAccountId = useCallback(() => {
    if (
      selectedAccountId !== ALL_ACCOUNTS_ID
      && validAccountIds.has(selectedAccountId)
      && isTradeAccountAllocatable(selectedAccountId)
    ) {
      return selectedAccountId;
    }

    return defaultTradeAccountId;
  }, [defaultTradeAccountId, isTradeAccountAllocatable, selectedAccountId, validAccountIds]);

  const resolveTradeAccountId = useCallback((trade: Partial<Trade>) => {
    // Check all field names used across the codebase:
    // `accountId` / `account_id` are the API-layer fields set by toApiTrade();
    // `account` is the raw store field on StoreTrade / JournalTrade.
    const accountCandidate = trade.accountId || trade.account_id
      || (trade as unknown as { account?: string }).account
      || (trade.id ? tradeAccounts[trade.id] : undefined);
    // DEFAULT_ACCOUNT_ID is a placeholder for "no account assigned" — treat it the same as
    // missing so these trades fall through to defaultTradeAccountId (the user's real primary account).
    if (accountCandidate && accountCandidate !== DEFAULT_ACCOUNT_ID && validAccountIds.has(accountCandidate)) {
      return accountCandidate;
    }

    return defaultTradeAccountId;
  }, [defaultTradeAccountId, tradeAccounts, validAccountIds]);

  const decorateTrades = useCallback((trades: Trade[]) => trades.map(trade => ({
    ...trade,
    accountId: resolveTradeAccountId(trade),
    session: deriveTradeSessionLabel(trade, preferences.sessionTimes),
  })), [preferences.sessionTimes, resolveTradeAccountId]);

  const filterTradesBySelectedAccount = useCallback((trades: Trade[]) => {
    const decorated = decorateTrades(trades);
    if (selectedAccountId === ALL_ACCOUNTS_ID) {
      return decorated;
    }

    return decorated.filter(trade => trade.accountId === selectedAccountId);
  }, [decorateTrades, selectedAccountId]);

  const setSelectedAccountId = useCallback((accountId: string) => {
    if (accountId === ALL_ACCOUNTS_ID || validAccountIds.has(accountId)) {
      setSelectedAccountIdState(accountId);
    }
  }, [validAccountIds]);

  const addAccount = useCallback((account: Omit<TradingAccount, 'id' | 'createdAt'>) => {
    const nextAccount: TradingAccount = {
      id: `account-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      ...account,
    };
    setAccounts(current => ensureDefaultAccount([...current, nextAccount]));
    if (user) {
      supabase.from('trading_accounts').insert({
        id: nextAccount.id, user_id: user.id, name: nextAccount.name,
        broker: nextAccount.broker || null,
        type: nextAccount.type, status: nextAccount.status, color: nextAccount.color,
        starting_balance: nextAccount.startingBalance ?? null,
      }).then(({ error }) => {
        if (error) console.error('[Accounts] Failed to save new account:', error.message);
      });
    }
  }, [user]);

  const updateAccount = useCallback((accountId: string, updates: Partial<Omit<TradingAccount, 'id' | 'createdAt'>>) => {
    const nextAccounts = ensureDefaultAccount(
      accountsRef.current.map(account =>
        account.id === accountId ? { ...account, ...updates } : account
      )
    );
    setAccounts(nextAccounts);

    // When startingBalance changes, save immediately to user_store without waiting for debounce.
    // This ensures the value survives a page refresh even if the 1.5s timer hasn't fired yet.
    if ('startingBalance' in updates && user && initialLoadDone.current) {
      void saveAppSettingsToSupabase(user.id, {
        accounts: nextAccounts,
        preferences: preferencesRef.current,
        selectedAccountId: selectedAccountIdRef.current,
        tradeAccounts: tradeAccountsRef.current,
        confluenceOptions: confluenceOptionsRef.current,
      });
    }

    if (user && accountId !== DEFAULT_ACCOUNT_ID) {
      supabase.from('trading_accounts').update({
        ...('name' in updates ? { name: updates.name } : {}),
        ...('broker' in updates ? { broker: updates.broker || null } : {}),
        ...('type' in updates ? { type: updates.type } : {}),
        ...('status' in updates ? { status: updates.status } : {}),
        ...('color' in updates ? { color: updates.color } : {}),
        ...('startingBalance' in updates ? { starting_balance: updates.startingBalance ?? null } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', accountId).eq('user_id', user.id).then(({ error }) => {
        if (error && !error.message.includes('starting_balance')) {
          console.error('[Accounts] Failed to update account:', error.message);
        }
      });
    }
  }, [user]);

  const deleteAccount = useCallback((accountId: string) => {
    if (accountId === DEFAULT_ACCOUNT_ID) return;

    const nextAccounts = ensureDefaultAccount(accounts.filter(account => account.id !== accountId));
    const nextDefaultTradeAccountId = resolveDefaultTradeAccountId(nextAccounts);

    setAccounts(nextAccounts);
    setTradeAccounts(current => Object.fromEntries(
      Object.entries(current).map(([tradeId, mappedAccountId]) => [
        tradeId,
        mappedAccountId === accountId ? nextDefaultTradeAccountId : mappedAccountId,
      ])
    ));
    setSelectedAccountIdState(current => current === accountId ? ALL_ACCOUNTS_ID : current);
    if (user) {
      supabase.from('trading_accounts').delete()
        .eq('id', accountId).eq('user_id', user.id)
        .then(({ error }) => {
          if (error) console.error('[Accounts] Failed to delete account:', error.message);
        });
    }
  }, [accounts, user]);

  const updatePreferences = useCallback((updates: Partial<AppPreferences>) => {
    setPreferences(current => ({ ...current, ...updates }));
  }, []);

  const addConfluenceOption = useCallback((option: string) => {
    const normalizedOption = normalizeConfluenceOption(option);
    if (!normalizedOption) return;

    setConfluenceOptions(current => normalizeConfluenceOptions([...current, normalizedOption]));
  }, []);

  const updateConfluenceOption = useCallback((index: number, option: string) => {
    const normalizedOption = normalizeConfluenceOption(option);
    if (!normalizedOption) return;

    setConfluenceOptions(current => normalizeConfluenceOptions(
      current.map((entry, entryIndex) => (entryIndex === index ? normalizedOption : entry))
    ));
  }, []);

  const deleteConfluenceOption = useCallback((index: number) => {
    setConfluenceOptions(current => {
      const next = current.filter((_, entryIndex) => entryIndex !== index);
      return next.length ? next : [...DEFAULT_CONFLUENCE_OPTIONS];
    });
  }, []);

  const persistTradeAccount = useCallback((tradeId: string, accountId?: string) => {
    if (!accountId) return;
    setTradeAccounts(current => ({
      ...current,
      [tradeId]: validAccountIds.has(accountId) ? accountId : defaultTradeAccountId,
    }));
  }, [defaultTradeAccountId, validAccountIds]);

  const removeTradeAccount = useCallback((tradeId: string) => {
    setTradeAccounts(current => {
      const next = { ...current };
      delete next[tradeId];
      return next;
    });
  }, []);

  const value = useMemo<AppSettingsContextValue>(() => ({
    accounts,
    preferences,
    confluenceOptions,
    selectedAccountId,
    defaultTradeAccountId,
    setSelectedAccountId,
    addAccount,
    updateAccount,
    deleteAccount,
    addConfluenceOption,
    updateConfluenceOption,
    deleteConfluenceOption,
    updatePreferences,
    getDefaultTradeAccountId,
    resolveTradeAccountId,
    isTradeAccountAllocatable,
    decorateTrades,
    filterTradesBySelectedAccount,
    persistTradeAccount,
    removeTradeAccount,
  }), [
    accounts,
    preferences,
    confluenceOptions,
    selectedAccountId,
    defaultTradeAccountId,
    addAccount,
    updateAccount,
    deleteAccount,
    addConfluenceOption,
    updateConfluenceOption,
    deleteConfluenceOption,
    updatePreferences,
    getDefaultTradeAccountId,
    resolveTradeAccountId,
    isTradeAccountAllocatable,
    decorateTrades,
    filterTradesBySelectedAccount,
    persistTradeAccount,
    removeTradeAccount,
  ]);

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const context = useContext(AppSettingsContext);
  if (!context) {
    throw new Error('useAppSettings must be used within AppSettingsProvider');
  }

  return context;
}
