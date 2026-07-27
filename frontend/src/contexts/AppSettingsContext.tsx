import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppPreferences, TradingAccount } from '../types/index.js';
import { useAuth } from './AuthContext.js';
import { deriveTradeSessionLabel, type TradeSessionLabel } from '../utils/sessionTimes.js';
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
import { supabase, propFirmRulesApi } from '../services/api.js';
import { primeCatalogTemplates } from '../utils/evaluationCoach.js';
import { normalizeConfluenceTag, normalizeConfluenceTags } from '../utils/confluenceTags.js';

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
  'LTF Orderblock',
  'Volume confirmation',
];

type TradeAccountMap = Record<string, string | string[]>;

function normalizeConfluenceOption(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = normalizeConfluenceTag(value);
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

function normalizeConfluenceOptions(values: unknown): string[] {
  const normalized = normalizeConfluenceTags(values, 64);
  return normalized.length ? normalized : [...DEFAULT_CONFLUENCE_OPTIONS];
}

function dedupeAccountIds(ids: unknown[], validAccountIds: Set<string>, fallback: string): string[] {
  const next: string[] = [];
  ids.forEach(value => {
    if (typeof value !== 'string') return;
    if (!value || value === DEFAULT_ACCOUNT_ID || !validAccountIds.has(value)) return;
    if (!next.includes(value)) next.push(value);
  });

  return next.length > 0 ? next : [fallback];
}

function normalizeTradeAccountMap(raw: unknown, validAccountIds: Set<string>, fallback: string): TradeAccountMap {
  if (!raw || typeof raw !== 'object') return {};

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .map(([tradeId, value]) => [tradeId, dedupeAccountIds(Array.isArray(value) ? value : [value], validAccountIds, fallback)] as const)
      .filter(([, ids]) => ids.length > 0)
  );
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

/**
 * Structural minimum the account/session resolvers actually read. Both Trade
 * shapes in the app satisfy this: the API-shape Trade (types/index.ts,
 * snake_case) and the journal-store Trade (store/types.ts, camelCase). Typing
 * against these fields lets decorateTrades/filterTradesBySelectedAccount
 * accept either shape and return it unchanged plus the decorations.
 */
export interface TradeAccountSource {
  id?: string;
  accountId?: string;
  account_id?: string;
  accountIds?: string[];
  account_ids?: string[];
  account?: string;
  trade_time?: string;
  session?: TradeSessionLabel;
}

export type DecoratedTrade<T> = T & {
  accountIds: string[];
  accountId: string;
  session: TradeSessionLabel;
};

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
  setDefaultAccount: (accountId: string | null) => void;
  addConfluenceOption: (option: string) => void;
  updateConfluenceOption: (index: number, option: string) => void;
  deleteConfluenceOption: (index: number) => void;
  updatePreferences: (updates: Partial<AppPreferences>) => void;
  getDefaultTradeAccountId: () => string;
  resolveTradeAccountId: (trade: TradeAccountSource) => string;
  resolveTradeAccountIds: (trade: TradeAccountSource) => string[];
  isTradeAccountAllocatable: (accountId: string) => boolean;
  decorateTrades: <T extends TradeAccountSource>(trades: T[]) => DecoratedTrade<T>[];
  filterTradesBySelectedAccount: <T extends TradeAccountSource>(trades: T[]) => DecoratedTrade<T>[];
  persistTradeAccount: (tradeId: string, accountId?: string | string[]) => void;
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
  tradeAccounts?: TradeAccountMap;
  confluenceOptions?: string[];
}

async function loadAppSettingsFromSupabase(userId: string): Promise<AppSettingsRow | null> {
  try {
    const [settingsResult, accountsResult] = await Promise.all([
      supabase.from('user_store').select('app_settings').eq('user_id', userId).maybeSingle(),
      supabase.from('trading_accounts').select('id, name, broker, type, status, color, starting_balance, target_balance, archived, created_at').eq('user_id', userId),
    ]);

    if (settingsResult.error) throw settingsResult.error;

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
          ...(a.target_balance != null ? { targetBalance: Number(a.target_balance) } : {}),
          ...(a.archived === true ? { archived: true } : {}),
        }));

      if (missingAccounts.length > 0) {
        row.accounts = [...(row.accounts ?? []), ...missingAccounts];
      }

      // Merge starting_balance, target_balance and archived for existing accounts using trading_accounts as fallback
      const dbFieldMap = new Map<string, { balance: number | null; target: number | null; archived: boolean }>(
        accountsResult.data.map(a => [a.id as string, {
          balance: a.starting_balance != null ? Number(a.starting_balance) : null,
          target: a.target_balance != null ? Number(a.target_balance) : null,
          archived: a.archived === true,
        }])
      );
      row.accounts = (row.accounts ?? []).map(account => {
        const dbFields = dbFieldMap.get(account.id);
        return {
          ...account,
          startingBalance: account.startingBalance
            ?? (dbFields?.balance != null ? dbFields.balance : undefined),
          targetBalance: account.targetBalance
            ?? (dbFields?.target != null ? dbFields.target : undefined),
          // Recover archived flag from trading_accounts if app_settings lost it
          ...(account.archived === true || dbFields?.archived === true ? { archived: true } : {}),
        };
      });
    }

    // Only fall through to localStorage migration if there is truly nothing to load
    if (!settingsResult.data?.app_settings && !row.accounts?.length) return null;

    return row;
  } catch (error) {
    throw error;
  }
}

async function saveAppSettingsToSupabase(userId: string, row: AppSettingsRow): Promise<void> {
  try {
    const { error } = await supabase.from('user_store').upsert(
      { user_id: userId, app_settings: row, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    if (error) console.error('[Settings] Failed to save app settings:', error.message);
  } catch (err) {
    console.error('[Settings] Failed to save app settings:', err);
  }
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

function isValidHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function parseScannerColors(raw: unknown): AppPreferences['scannerColors'] {
  const src = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  return {
    entry:      isValidHex(src.entry)      ? src.entry      : DEFAULT_PREFERENCES.scannerColors.entry,
    stopLoss:   isValidHex(src.stopLoss)   ? src.stopLoss   : DEFAULT_PREFERENCES.scannerColors.stopLoss,
    takeProfit: isValidHex(src.takeProfit) ? src.takeProfit : DEFAULT_PREFERENCES.scannerColors.takeProfit,
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
    scannerColors: parseScannerColors(parsed.scannerColors),
    marketClock: parsed.marketClock === 'futures' || parsed.marketClock === 'forex' ? parsed.marketClock : 'equities',
    clockFormat: parsed.clockFormat === '24h' ? '24h' : '12h',
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
  const [tradeAccounts, setTradeAccounts] = useState<TradeAccountMap>({});
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
      // Cancel any pending debounced save so it cannot fire after state resets to defaults
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setAccounts([DEFAULT_ACCOUNT]);
      setPreferences(DEFAULT_PREFERENCES);
      setConfluenceOptions([...DEFAULT_CONFLUENCE_OPTIONS]);
      setSelectedAccountIdState(ALL_ACCOUNTS_ID);
      setTradeAccounts({});
      initialLoadDone.current = false;
      return;
    }

    void (async () => {
      let row: AppSettingsRow | null = null;
      try {
        row = await loadAppSettingsFromSupabase(user.id);
      } catch {
        // Do not mark initial load complete after a transient Supabase failure.
        // Otherwise the default empty settings can be saved over the user's
        // real app_settings row on hard refresh.
        initialLoadDone.current = false;
        return;
      }

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
      const stored = row.selectedAccountId ?? ALL_ACCOUNTS_ID;
      setSelectedAccountIdState(stored === ALL_ACCOUNTS_ID || nextAccounts.some(a => a.id === stored) ? stored : ALL_ACCOUNTS_ID);
      const nextValidAccountIds = new Set(nextAccounts.map(account => account.id));
      const nextDefaultTradeAccountId = resolveDefaultTradeAccountId(nextAccounts);
      setTradeAccounts(normalizeTradeAccountMap(row.tradeAccounts, nextValidAccountIds, nextDefaultTradeAccountId));
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
        phase: account.status === 'Funded' || account.status === 'Live' ? 'funded' : 'eval',
        balance: sb,
        dailyLossLimit: account.dailyLossLimit ?? 0,
        maxDrawdown: account.maxDrawdown ?? 3000,
        profitTarget: account.profitTarget ?? null,
        startingBalance: sb,
        isActive: true,
        color: account.color,
        firmRuleVersionId: account.firmRuleVersionId,
        evaluationTemplateId: account.firmRuleVersionId,
        evaluationPath: account.evaluationPath,
        dailyLossMode: account.dailyLossMode,
        minimumTradingDays: account.minimumTradingDays,
        maxContracts: account.maxContracts,
        consistencyLimitPct: account.consistencyLimitPct,
        drawdownType: account.drawdownType,
        trailingStopsAt: account.trailingStopsAt,
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

  // Refresh prop-firm rule templates from the backend catalog; the bundled
  // copy stays in place if the request fails.
  useEffect(() => {
    if (!user?.id) return;
    propFirmRulesApi.getCatalog()
      .then(response => primeCatalogTemplates(response.firms))
      .catch(() => {});
  }, [user?.id]);

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
    return Boolean(account && account.status !== 'Blown' && account.status !== 'Passed');
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

  const resolveTradeAccountIds = useCallback((trade: TradeAccountSource) => {
    // Check all field names used across the codebase:
    // `accountId` / `account_id` are the API-layer fields set by toApiTrade();
    // `account` is the raw store field on StoreTrade / JournalTrade.
    const mappedAccounts = trade.id ? tradeAccounts[trade.id] : undefined;
    const rawIds = [
      ...(Array.isArray(trade.accountIds) ? trade.accountIds : []),
      ...(Array.isArray(trade.account_ids) ? trade.account_ids : []),
      ...(Array.isArray(mappedAccounts) ? mappedAccounts : [mappedAccounts]),
      trade.accountId,
      trade.account_id,
      trade.account,
    ];
    // DEFAULT_ACCOUNT_ID is a placeholder for "no account assigned" — treat it the same as
    // missing so these trades fall through to defaultTradeAccountId (the user's real primary account).
    return dedupeAccountIds(rawIds, validAccountIds, defaultTradeAccountId);
  }, [defaultTradeAccountId, tradeAccounts, validAccountIds]);

  const resolveTradeAccountId = useCallback((trade: TradeAccountSource) => (
    resolveTradeAccountIds(trade)[0] ?? defaultTradeAccountId
  ), [defaultTradeAccountId, resolveTradeAccountIds]);

  const decorateTrades = useCallback(<T extends TradeAccountSource>(trades: T[]): DecoratedTrade<T>[] => trades.map(trade => ({
    ...trade,
    accountIds: resolveTradeAccountIds(trade),
    accountId: resolveTradeAccountId(trade),
    session: deriveTradeSessionLabel(trade, preferences.sessionTimes),
  })), [preferences.sessionTimes, resolveTradeAccountId, resolveTradeAccountIds]);

  const filterTradesBySelectedAccount = useCallback(<T extends TradeAccountSource>(trades: T[]): DecoratedTrade<T>[] => {
    const decorated = decorateTrades(trades);
    if (selectedAccountId === ALL_ACCOUNTS_ID) {
      return decorated;
    }

    return decorated.filter(trade => trade.accountIds.includes(selectedAccountId) || trade.accountId === selectedAccountId);
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
        target_balance: nextAccount.targetBalance ?? null,
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
    const nextSelectedAccountId = updates.archived === true && selectedAccountIdRef.current === accountId
      ? ALL_ACCOUNTS_ID
      : selectedAccountIdRef.current;
    setAccounts(nextAccounts);
    if (nextSelectedAccountId !== selectedAccountIdRef.current) {
      setSelectedAccountIdState(nextSelectedAccountId);
    }

    // Account lifecycle fields should survive refreshes immediately instead of waiting
    // for the debounce, especially archive/unarchive actions that change navigation.
    const shouldSaveSettingsImmediately = 'startingBalance' in updates || 'archived' in updates;
    if (shouldSaveSettingsImmediately && user && initialLoadDone.current) {
      void saveAppSettingsToSupabase(user.id, {
        accounts: nextAccounts,
        preferences: preferencesRef.current,
        selectedAccountId: nextSelectedAccountId,
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
        ...('targetBalance' in updates ? { target_balance: updates.targetBalance ?? null } : {}),
        ...('archived' in updates ? { archived: !!updates.archived } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', accountId).eq('user_id', user.id).then(({ error }) => {
        if (error && !error.message.includes('starting_balance') && !error.message.includes('target_balance')) {
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
      Object.entries(current).map(([tradeId, mappedAccountIds]) => {
        const rawIds = Array.isArray(mappedAccountIds) ? mappedAccountIds : [mappedAccountIds];
        const nextIds = rawIds.filter(mappedAccountId => mappedAccountId !== accountId);
        return [tradeId, nextIds.length > 0 ? nextIds : [nextDefaultTradeAccountId]];
      })
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

  const setDefaultAccount = useCallback((accountId: string | null) => {
    const nextAccounts = ensureDefaultAccount(
      accountsRef.current.map(account => ({
        ...account,
        ...(accountId !== null && account.id === accountId ? { isDefault: true } : { isDefault: undefined }),
      }))
    );
    setAccounts(nextAccounts);
    if (user && initialLoadDone.current) {
      void saveAppSettingsToSupabase(user.id, {
        accounts: nextAccounts,
        preferences: preferencesRef.current,
        selectedAccountId: selectedAccountIdRef.current,
        tradeAccounts: tradeAccountsRef.current,
        confluenceOptions: confluenceOptionsRef.current,
      });
    }
  }, [user]);

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

  const persistTradeAccount = useCallback((tradeId: string, accountId?: string | string[]) => {
    if (!accountId) return;
    setTradeAccounts(current => ({
      ...current,
      [tradeId]: dedupeAccountIds(Array.isArray(accountId) ? accountId : [accountId], validAccountIds, defaultTradeAccountId),
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
    setDefaultAccount,
    addConfluenceOption,
    updateConfluenceOption,
    deleteConfluenceOption,
    updatePreferences,
    getDefaultTradeAccountId,
    resolveTradeAccountId,
    resolveTradeAccountIds,
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
    setDefaultAccount,
    addConfluenceOption,
    updateConfluenceOption,
    deleteConfluenceOption,
    updatePreferences,
    getDefaultTradeAccountId,
    resolveTradeAccountId,
    resolveTradeAccountIds,
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
