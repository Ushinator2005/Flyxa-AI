import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  CreditCard,
  LayoutGrid,
  List,
  MessageSquare,
  Pencil,
  Plus,
  TrendingDown,
  TrendingUp,
  Trash2,
  X,
} from 'lucide-react';
import { billingApi, type BillingLivePricesResponse } from '../services/api.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { BillingAccount as StoreBillingAccount } from '../store/types.js';
import DatePicker from '../components/common/DatePicker.js';

type AccountStatus = 'Eval 1' | 'Eval 2' | 'Funded' | 'Passed' | 'Blown' | 'Reset';

interface PayoutEntry {
  id: string;
  amount: number;
  date: string;
}

interface BillingAccount {
  id: string;
  firm: string;
  accountType: string;
  size: string;
  listPrice: number;
  discountCode: string;
  discountPct: number;
  actualPrice: number;
  purchaseDate: string;
  status: AccountStatus;
  payoutReceived: number;
  payouts: PayoutEntry[];
  notes: string;
}

interface BillingFormState {
  firm: string;
  accountType: string;
  size: string;
  listPrice: number;
  discountCode: string;
  discountPct: number;
  purchaseDate: string;
  status: AccountStatus;
  payoutReceived: number;
  payouts: PayoutEntry[];
  notes: string;
}

type ViewMode = 'table' | 'pipeline';

const STATUS_OPTIONS: AccountStatus[] = ['Eval 1', 'Eval 2', 'Funded', 'Passed', 'Blown', 'Reset'];

const PIPELINE_COLS: AccountStatus[] = ['Eval 1', 'Eval 2', 'Funded', 'Passed', 'Blown'];

const FIRM_OPTIONS = [
  'Apex Funded',
  'Alpha Futures',
  'FTMO',
  'Lucid',
  'MyFundedFutures',
  'Topstep',
  'The Funded Trader',
  'True Forex Funds',
  'E8 Funding',
  'Other',
] as const;

const FIRM_ACCOUNT_TYPES: Record<string, Array<{ type: string; sizes: string[] }>> = {
  'Apex Funded': [
    { type: 'Evaluation', sizes: ['$25,000', '$50,000', '$100,000', '$150,000', '$250,000', '$300,000'] },
  ],
  'Alpha Futures': [
    { type: 'Standard Plan', sizes: ['$50,000', '$100,000', '$150,000'] },
    { type: 'Advanced Plan', sizes: ['$50,000', '$100,000', '$150,000'] },
    { type: 'Premium Plan', sizes: ['$50,000', '$100,000', '$150,000'] },
  ],
  FTMO: [
    { type: 'Challenge', sizes: ['€10,000', '€25,000', '€50,000', '€100,000', '€200,000'] },
  ],
  Lucid: [
    { type: 'LucidFlex', sizes: ['$25,000', '$50,000', '$100,000', '$150,000'] },
    { type: 'LucidPro', sizes: ['$25,000', '$50,000', '$100,000', '$150,000'] },
    { type: 'LucidDirect', sizes: ['$25,000', '$50,000', '$100,000', '$150,000'] },
    { type: 'LucidMaxx', sizes: ['$50,000', '$100,000', '$150,000'] },
  ],
  MyFundedFutures: [
    { type: 'Starter', sizes: ['$50,000', '$100,000', '$150,000', '$200,000'] },
    { type: 'Expert', sizes: ['$50,000', '$100,000', '$150,000', '$200,000'] },
  ],
  Topstep: [
    { type: 'Trading Combine', sizes: ['$50,000', '$100,000', '$150,000'] },
    { type: 'Express Funded Account', sizes: ['$50,000', '$100,000', '$150,000'] },
  ],
};

const FIRM_PRICES: Record<string, Record<string, number>> = {
  'Apex Funded': {
    '$25,000': 147,
    '$50,000': 167,
    '$100,000': 207,
    '$150,000': 297,
    '$250,000': 497,
    '$300,000': 597,
  },
  'Alpha Futures': {
    '$50,000': 97,
    '$100,000': 167,
    '$150,000': 297,
  },
  FTMO: {
    '€10,000': 155,
    '€25,000': 250,
    '€50,000': 345,
    '€100,000': 540,
    '€200,000': 1080,
  },
  Lucid: {
    '$25,000': 79,
    '$50,000': 149,
    '$100,000': 249,
    '$150,000': 349,
  },
  MyFundedFutures: {
    '$50,000': 165,
    '$100,000': 250,
    '$150,000': 340,
    '$200,000': 430,
  },
  Topstep: {
    '$50,000': 99,
    '$100,000': 149,
    '$150,000': 199,
  },
};

/** Normalise legacy 'Active' status from old data to 'Eval 1'. */
function normalizeStatus(raw: unknown): AccountStatus {
  if (raw === 'Active') return 'Eval 1';
  if (STATUS_OPTIONS.includes(raw as AccountStatus)) return raw as AccountStatus;
  return 'Eval 1';
}

function normalizeBillingAccount(raw: StoreBillingAccount): BillingAccount {
  return {
    id: raw.id,
    firm: raw.firm,
    accountType: typeof (raw as unknown as { accountType?: string }).accountType === 'string'
      ? (raw as unknown as { accountType: string }).accountType
      : getDefaultAccountType(raw.firm),
    size: raw.size,
    listPrice: raw.listPrice,
    discountCode: raw.discountCode,
    discountPct: raw.discountPct,
    actualPrice: raw.actualPrice,
    purchaseDate: raw.purchaseDate,
    status: normalizeStatus((raw as unknown as { status: unknown }).status),
    payoutReceived: raw.payoutReceived,
    payouts: Array.isArray((raw as unknown as { payouts?: PayoutEntry[] }).payouts)
      ? ((raw as unknown as { payouts: PayoutEntry[] }).payouts)
      : [],
    notes: typeof (raw as unknown as { notes?: string }).notes === 'string'
      ? ((raw as unknown as { notes: string }).notes)
      : '',
  };
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function computeActualPrice(listPrice: number, discountPct: number): number {
  const pct = clampPercentage(discountPct);
  const actual = listPrice * (1 - pct / 100);
  return Number(actual.toFixed(2));
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedCurrency(value: number): string {
  const abs = formatCurrency(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

function formatDateLabel(value: string): string {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function getTodayInputDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getAccountTypesForFirm(firm: string): string[] {
  return FIRM_ACCOUNT_TYPES[firm]?.map(item => item.type) ?? [];
}

function getDefaultAccountType(firm: string): string {
  return getAccountTypesForFirm(firm)[0] ?? 'Custom';
}

function getSizesForFirm(firm: string, accountType?: string): string[] {
  const types = FIRM_ACCOUNT_TYPES[firm];
  if (types?.length) {
    const selected = types.find(item => item.type === accountType) ?? types[0];
    return selected.sizes;
  }
  return Object.keys(FIRM_PRICES[firm] ?? {});
}

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `billing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultFormState(): BillingFormState {
  const defaultFirm = 'Apex Funded';
  const defaultAccountType = getDefaultAccountType(defaultFirm);
  const defaultSize = '$100,000';
  const defaultListPrice = FIRM_PRICES[defaultFirm]?.[defaultSize] ?? 0;
  return {
    firm: defaultFirm,
    accountType: defaultAccountType,
    size: defaultSize,
    listPrice: defaultListPrice,
    discountCode: '',
    discountPct: 0,
    purchaseDate: getTodayInputDate(),
    status: 'Eval 1',
    payoutReceived: 0,
    payouts: [],
    notes: '',
  };
}

function getStatusBadgeStyle(status: AccountStatus): CSSProperties {
  switch (status) {
    case 'Eval 1':
      return { background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid var(--amber-border)' };
    case 'Eval 2':
      return { background: 'var(--cobalt-dim)', color: 'var(--cobalt)', border: '1px solid var(--cobalt-border)' };
    case 'Funded':
      return { background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)' };
    case 'Passed':
      return { background: 'var(--green-dim)', color: 'var(--green)', border: '1px solid var(--green-border)' };
    case 'Blown':
      return { background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid var(--red-border)' };
    case 'Reset':
      return { background: 'var(--surface-2)', color: 'var(--txt-3)', border: '1px solid var(--border)' };
    default:
      return { background: 'var(--surface-2)', color: 'var(--txt-3)', border: '1px solid var(--border)' };
  }
}

function getStatusDotColor(status: AccountStatus): string {
  switch (status) {
    case 'Eval 1': return 'var(--amber)';
    case 'Eval 2': return 'var(--cobalt)';
    case 'Funded': return '#818cf8';
    case 'Passed': return 'var(--green)';
    case 'Blown': return 'var(--red)';
    case 'Reset': return 'var(--txt-3)';
    default: return 'var(--txt-3)';
  }
}

export default function Billing() {
  const storeBillingAccounts = useFlyxaStore(state => state.billingAccounts);
  const hydrateSharedData = useFlyxaStore(state => state.hydrateSharedData);
  const [accounts, setAccounts] = useState<BillingAccount[]>(
    () => storeBillingAccounts.map(normalizeBillingAccount)
  );
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [firmFilter, setFirmFilter] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BillingFormState>(getDefaultFormState);
  const [livePricesByFirm, setLivePricesByFirm] = useState<Record<string, BillingLivePricesResponse>>({});
  const [livePricingLoadingFirm, setLivePricingLoadingFirm] = useState<string | null>(null);
  const [livePricingError, setLivePricingError] = useState<string | null>(null);

  useEffect(() => {
    hydrateSharedData({ billingAccounts: accounts as unknown as StoreBillingAccount[] });
  }, [accounts, hydrateSharedData]);

  const getPreferredListPrice = (firm: string, size: string, currentListPrice: number): number => {
    const livePrice = livePricesByFirm[firm]?.prices?.[size];
    if (isFiniteNumber(livePrice)) return livePrice;
    const fallbackPrice = FIRM_PRICES[firm]?.[size];
    if (isFiniteNumber(fallbackPrice)) return fallbackPrice;
    return currentListPrice;
  };

  const fetchLivePricesForFirm = async (firm: string): Promise<BillingLivePricesResponse | null> => {
    if (!firm) return null;
    if (livePricesByFirm[firm]) return livePricesByFirm[firm];
    setLivePricingLoadingFirm(firm);
    setLivePricingError(null);
    try {
      const payload = await billingApi.getLivePrices(firm);
      setLivePricesByFirm(current => ({ ...current, [firm]: payload }));
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to fetch live prices.';
      setLivePricingError(message);
      return null;
    } finally {
      setLivePricingLoadingFirm(current => (current === firm ? null : current));
    }
  };

  const openAddModal = () => {
    const defaults = getDefaultFormState();
    setEditingId(null);
    setForm(defaults);
    setIsModalOpen(true);
    void fetchLivePricesForFirm(defaults.firm).then(payload => {
      const livePrice = payload?.prices?.[defaults.size];
      if (!isFiniteNumber(livePrice)) return;
      setForm(current => (
        current.firm === defaults.firm && current.size === defaults.size
          ? { ...current, listPrice: livePrice }
          : current
      ));
    });
  };

  const openEditModal = (account: BillingAccount) => {
    setEditingId(account.id);
    setForm({
      firm: account.firm,
      accountType: account.accountType ?? getDefaultAccountType(account.firm),
      size: account.size,
      listPrice: account.listPrice,
      discountCode: account.discountCode,
      discountPct: account.discountPct,
      purchaseDate: account.purchaseDate,
      status: account.status,
      payoutReceived: account.payoutReceived,
      payouts: account.payouts ?? [],
      notes: account.notes ?? '',
    });
    setIsModalOpen(true);
    void fetchLivePricesForFirm(account.firm);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
  };

  const actualPricePreview = useMemo(
    () => computeActualPrice(Math.max(0, toNumber(form.listPrice, 0)), clampPercentage(form.discountPct)),
    [form.discountPct, form.listPrice]
  );
  const savingsPreview = useMemo(
    () => Math.max(0, Math.max(0, toNumber(form.listPrice, 0)) - actualPricePreview),
    [actualPricePreview, form.listPrice]
  );

  // Derived payout total from payouts array (falls back to legacy payoutReceived)
  const formPayoutTotal = useMemo(
    () => form.payouts.reduce((sum, p) => sum + Math.max(0, p.amount), 0) || form.payoutReceived,
    [form.payouts, form.payoutReceived]
  );

  const derived = useMemo(() => {
    const totalAccounts = accounts.length;
    const totalSpent = accounts.reduce((sum, a) => sum + a.actualPrice, 0);
    const totalPayouts = accounts.reduce((sum, a) => sum + Math.max(0, a.payoutReceived), 0);
    const totalListPrice = accounts.reduce((sum, a) => sum + a.listPrice, 0);
    const totalSaved = totalListPrice - totalSpent;
    const netPnL = totalPayouts - totalSpent;
    const passedAccounts = accounts.filter(a => a.status === 'Passed').length;
    const fundedAccounts = accounts.filter(a => a.status === 'Funded').length;
    const activeAccounts = accounts.filter(a => a.status === 'Eval 1' || a.status === 'Eval 2').length;
    const blownAccounts = accounts.filter(a => a.status === 'Blown').length;
    const passRate = totalAccounts > 0 ? ((passedAccounts + fundedAccounts) / totalAccounts) * 100 : 0;
    const avgFeePerAccount = totalAccounts > 0 ? totalSpent / totalAccounts : 0;
    const costPerPass = (passedAccounts + fundedAccounts) > 0
      ? totalSpent / (passedAccounts + fundedAccounts)
      : null;

    let monthsActive = 1;
    if (accounts.length > 0) {
      const firstPurchase = accounts
        .map(a => new Date(`${a.purchaseDate}T00:00:00`).getTime())
        .filter(t => Number.isFinite(t))
        .sort((a, b) => a - b)[0];
      if (Number.isFinite(firstPurchase)) {
        const elapsedMs = Math.max(1, Date.now() - firstPurchase);
        monthsActive = Math.max(1, elapsedMs / (1000 * 60 * 60 * 24 * 30.4375));
      }
    }
    const monthlyBurn = totalSpent / monthsActive;

    const byFirmMap = new Map<string, { firm: string; accounts: number; spent: number; payouts: number; passed: number; blown: number }>();
    accounts.forEach(a => {
      const cur = byFirmMap.get(a.firm) ?? { firm: a.firm, accounts: 0, spent: 0, payouts: 0, passed: 0, blown: 0 };
      cur.accounts += 1;
      cur.spent += a.actualPrice;
      cur.payouts += Math.max(0, a.payoutReceived);
      if (a.status === 'Passed' || a.status === 'Funded') cur.passed += 1;
      if (a.status === 'Blown') cur.blown += 1;
      byFirmMap.set(a.firm, cur);
    });

    const roiByFirm = Array.from(byFirmMap.values())
      .map(row => ({
        ...row,
        roi: row.payouts - row.spent,
        recoveredRatio: row.spent > 0 ? Math.min(1, row.payouts / row.spent) : 0,
        passRate: row.accounts > 0 ? (row.passed / row.accounts) * 100 : 0,
        costPerPass: row.passed > 0 ? row.spent / row.passed : null,
      }))
      .sort((a, b) => b.spent - a.spent);

    // Best firm by ROI (only firms with payouts)
    const bestFirm = roiByFirm.find(r => r.payouts > 0 && r.roi > 0) ?? null;

    return {
      totalAccounts, totalSpent, totalPayouts, netPnL, monthlyBurn,
      avgFeePerAccount, passedAccounts, fundedAccounts, activeAccounts, blownAccounts,
      passRate, costPerPass, totalListPrice, totalSaved, roiByFirm, bestFirm,
    };
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    return accounts.filter(a => {
      if (firmFilter !== 'All' && a.firm !== firmFilter) return false;
      if (statusFilter !== 'All' && a.status !== statusFilter) return false;
      return true;
    });
  }, [accounts, firmFilter, statusFilter]);

  const footerTotals = useMemo(() => {
    const totalListPrice = filteredAccounts.reduce((sum, a) => sum + a.listPrice, 0);
    const totalPaid = filteredAccounts.reduce((sum, a) => sum + a.actualPrice, 0);
    const totalSaved = totalListPrice - totalPaid;
    const passedCount = filteredAccounts.filter(a => a.status === 'Passed' || a.status === 'Funded').length;
    return { totalListPrice, totalPaid, totalSaved, count: filteredAccounts.length, passedCount };
  }, [filteredAccounts]);

  const pipelineByStatus = useMemo(() => {
    const map: Record<AccountStatus, BillingAccount[]> = {
      'Eval 1': [], 'Eval 2': [], 'Funded': [], 'Passed': [], 'Blown': [], 'Reset': [],
    };
    accounts.forEach(a => { map[a.status].push(a); });
    return map;
  }, [accounts]);

  const accountTypeOptions = useMemo(() => getAccountTypesForFirm(form.firm), [form.firm]);
  const hasAccountTypeLookup = accountTypeOptions.length > 0;
  const knownSizes = useMemo(() => getSizesForFirm(form.firm, form.accountType), [form.accountType, form.firm]);
  const hasFirmLookup = knownSizes.length > 0;
  const currentLivePricing = livePricesByFirm[form.firm];
  const selectedSizeIsFallback = Boolean(currentLivePricing?.unavailableSizes?.includes(form.size));
  const currentPricingSourceLabel = currentLivePricing?.source
    ? (() => { try { return new URL(currentLivePricing.source).hostname.replace(/^www\./, ''); } catch { return currentLivePricing.source; } })()
    : null;

  const showPayoutSection = form.status === 'Funded' || form.status === 'Passed';

  const saveAccount = () => {
    const listPrice = Math.max(0, toNumber(form.listPrice, 0));
    const discountPct = clampPercentage(form.discountPct);
    const actualPrice = computeActualPrice(listPrice, discountPct);
    const payouts = showPayoutSection ? form.payouts : [];
    const payoutReceived = payouts.reduce((sum, p) => sum + Math.max(0, p.amount), 0)
      || (showPayoutSection ? Math.max(0, toNumber(form.payoutReceived, 0)) : 0);

    const next: BillingAccount = {
      id: editingId ?? createId(),
      firm: form.firm.trim() || 'Other',
      accountType: form.accountType.trim() || getDefaultAccountType(form.firm.trim() || 'Other'),
      size: form.size.trim() || 'Custom',
      listPrice,
      discountCode: form.discountCode.trim().toUpperCase(),
      discountPct,
      actualPrice,
      purchaseDate: form.purchaseDate || getTodayInputDate(),
      status: form.status,
      payoutReceived,
      payouts,
      notes: form.notes.trim(),
    };

    setAccounts(current => editingId
      ? current.map(row => (row.id === editingId ? next : row))
      : [next, ...current]);
    closeModal();
  };

  const deleteAccount = (id: string) => {
    const target = accounts.find(a => a.id === id);
    if (!target) return;
    const confirmed = window.confirm(`Delete billing entry for ${target.firm} ${target.size}?`);
    if (!confirmed) return;
    setAccounts(current => current.filter(a => a.id !== id));
  };

  const setFormField = <K extends keyof BillingFormState>(key: K, value: BillingFormState[K]) => {
    setForm(current => ({ ...current, [key]: value }));
  };

  const applyFirm = (firm: string) => {
    const nextAccountType = getDefaultAccountType(firm);
    const nextSizes = getSizesForFirm(firm, nextAccountType);
    const nextSize = nextSizes[0] ?? form.size;
    const nextListPrice = getPreferredListPrice(firm, nextSize, form.listPrice);
    setForm(current => ({
      ...current, firm,
      accountType: nextAccountType,
      size: nextSizes.length > 0 ? nextSize : current.size,
      listPrice: nextListPrice,
    }));
    void fetchLivePricesForFirm(firm).then(payload => {
      const livePrice = payload?.prices?.[nextSize];
      if (!isFiniteNumber(livePrice)) return;
      setForm(current => (
        current.firm === firm && current.size === nextSize ? { ...current, listPrice: livePrice } : current
      ));
    });
  };

  const applyAccountType = (accountType: string) => {
    const nextSizes = getSizesForFirm(form.firm, accountType);
    const nextSize = nextSizes[0] ?? form.size;
    const nextListPrice = getPreferredListPrice(form.firm, nextSize, form.listPrice);
    setForm(current => ({
      ...current,
      accountType,
      size: nextSizes.length > 0 ? nextSize : current.size,
      listPrice: nextListPrice,
    }));
  };

  const applySize = (size: string) => {
    const selectedFirm = form.firm;
    const lookupPrice = getPreferredListPrice(selectedFirm, size, form.listPrice);
    setForm(current => ({ ...current, size, listPrice: lookupPrice }));
    void fetchLivePricesForFirm(selectedFirm).then(payload => {
      const livePrice = payload?.prices?.[size];
      if (!isFiniteNumber(livePrice)) return;
      setForm(current => (
        current.firm === selectedFirm && current.size === size ? { ...current, listPrice: livePrice } : current
      ));
    });
  };

  const addPayout = () => {
    setFormField('payouts', [...form.payouts, { id: createId(), amount: 0, date: getTodayInputDate() }]);
  };

  const updatePayout = (id: string, field: 'amount' | 'date', value: string | number) => {
    setFormField('payouts', form.payouts.map(p =>
      p.id === id ? { ...p, [field]: field === 'amount' ? Math.max(0, toNumber(value, 0)) : value } : p
    ));
  };

  const removePayout = (id: string) => {
    setFormField('payouts', form.payouts.filter(p => p.id !== id));
  };

  const phaseRail = [
    { label: 'Eval', value: derived.activeAccounts, color: 'var(--amber)' },
    { label: 'Funded', value: derived.fundedAccounts, color: '#818cf8' },
    { label: 'Passed', value: derived.passedAccounts, color: 'var(--green)' },
    { label: 'Blown', value: derived.blownAccounts, color: 'var(--red)' },
  ];
  const netTone = derived.netPnL >= 0 ? 'positive' : 'negative';

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 28px 40px', background: 'var(--app-bg)' }}>
      <style>{`
        .billing-desk { display: grid; grid-template-columns: minmax(320px, 1.15fr) minmax(320px, 1fr); gap: 14px; margin-bottom: 16px; }
        .billing-hero-panel { border: 1px solid var(--border); border-top: 2px solid var(--amber); border-radius: 8px; background: var(--surface-1); padding: 18px; }
        .billing-kicker { margin: 0; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--amber); font-weight: 700; }
        .billing-ledger-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        .billing-stat-card { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); padding: 14px; transition: border-color 140ms ease, transform 140ms ease, background 140ms ease; min-width: 0; }
        .billing-stat-card:hover { border-color: rgba(255,255,255,0.16); transform: translateY(-1px); background: var(--surface-2); }
        .billing-stat-label { margin: 0; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--txt-3); }
        .billing-stat-value { margin: 7px 0 4px; font-family: var(--font-mono); font-size: 20px; font-weight: 500; color: var(--txt); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .billing-stat-note { margin: 0; font-size: 11px; color: var(--txt-3); line-height: 1.45; }
        .billing-phase-rail { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
        .billing-phase-chip { border: 1px solid var(--border); background: rgba(255,255,255,0.025); border-radius: 7px; padding: 9px 10px; min-width: 0; }
        .billing-command-btn { height: 34px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--txt-2); display: inline-flex; align-items: center; gap: 7px; padding: 0 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color 120ms, color 120ms, background 120ms; }
        .billing-command-btn:hover { border-color: rgba(255,255,255,0.18); color: var(--txt); }
        .billing-command-btn.primary { border-color: var(--amber); background: var(--amber); color: var(--bg); }
        .billing-break-even { display: flex; align-items: center; justify-content: space-between; gap: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); padding: 14px 16px; margin-bottom: 18px; flex-wrap: wrap; }
        .billing-table-row:hover td { background: var(--surface-2); }
        .billing-action-icon { border: none; background: transparent; color: var(--txt-3); display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
        .billing-action-icon:hover { color: var(--txt-2); }
        .billing-action-icon.billing-delete:hover { color: var(--red); }
        .billing-status-toggle { border: none; height: 32px; font-size: 11px; font-weight: 500; color: var(--txt-2); background: var(--surface-2); cursor: pointer; }
        .billing-status-toggle.is-active { background: var(--amber); color: var(--bg); }
        .billing-modal-field { width: 100%; height: 38px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-2); color: var(--txt); font-size: 13px; padding: 0 12px; outline: none; }
        .billing-modal-field:focus { border-color: var(--amber-border); }
        .billing-modal-textarea { width: 100%; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-2); color: var(--txt); font-size: 13px; padding: 10px 12px; outline: none; resize: vertical; min-height: 64px; font-family: inherit; box-sizing: border-box; }
        .billing-modal-textarea:focus { border-color: var(--amber-border); }
        .billing-filter-wrap { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; height: 30px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-2); }
        .billing-filter-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--txt-3); }
        .billing-filter-select { border: none; outline: none; background: transparent; color: var(--txt-2); font-size: 12px; height: 100%; }
        .billing-view-btn { height: 30px; padding: 0 10px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-2); color: var(--txt-3); display: inline-flex; align-items: center; gap: 5px; font-size: 12px; cursor: pointer; transition: color 120ms, background 120ms, border-color 120ms; }
        .billing-view-btn.active { background: var(--amber); border-color: var(--amber); color: var(--bg); }
        .billing-view-btn:not(.active):hover { color: var(--txt); border-color: var(--txt-3); }
        .pipeline-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 7px; padding: 12px 14px; cursor: pointer; transition: border-color 140ms, transform 140ms; }
        .pipeline-card:hover { border-color: var(--amber-border); transform: translateY(-1px); }
        .payout-row { display: grid; grid-template-columns: 1fr 140px 28px; gap: 8px; align-items: center; }
        @media (max-width: 1120px) {
          .billing-desk { grid-template-columns: 1fr; }
        }
        @media (max-width: 760px) {
          .billing-ledger-grid, .billing-phase-rail { grid-template-columns: 1fr 1fr; }
        }
      `}</style>

      <section style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <p className="billing-kicker">Funding Desk</p>
          <h1 style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 600, color: 'var(--txt)', letterSpacing: 0 }}>Billing</h1>
          <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--txt-2)', lineHeight: 1.45 }}>
            Track prop firm spend, challenge phases, discounts, payouts, and account ROI.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="billing-command-btn" onClick={() => setViewMode(viewMode === 'table' ? 'pipeline' : 'table')}>
            {viewMode === 'table' ? <LayoutGrid size={14} /> : <List size={14} />}
            {viewMode === 'table' ? 'Pipeline' : 'Ledger'}
          </button>
          <button type="button" className="billing-command-btn primary" onClick={openAddModal}>
            <Plus size={14} />
            Add Account
          </button>
        </div>
      </section>

      <section className="billing-desk">
        <article className="billing-hero-panel">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
            <div>
              <p className="billing-stat-label">Net Position</p>
              <p style={{ margin: '8px 0 6px', fontFamily: 'var(--font-mono)', fontSize: 36, lineHeight: 1, fontWeight: 500, color: netTone === 'positive' ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>
                {formatSignedCurrency(derived.netPnL)}
              </p>
              <p className="billing-stat-note">
                {derived.totalPayouts > 0 ? `${formatCurrency(derived.totalPayouts)} received against ${formatCurrency(derived.totalSpent)} spent.` : `${formatCurrency(derived.totalSpent)} in fees logged before payouts.`}
              </p>
            </div>
            <span style={{ width: 38, height: 38, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: netTone === 'positive' ? 'var(--green-dim)' : 'var(--red-dim)', color: netTone === 'positive' ? 'var(--green)' : 'var(--red)', border: netTone === 'positive' ? '1px solid var(--green-border)' : '1px solid var(--red-border)', flexShrink: 0 }}>
              {netTone === 'positive' ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <div>
              <p className="billing-stat-label">Spent</p>
              <p style={{ margin: '5px 0 0', fontFamily: 'var(--font-mono)', color: 'var(--red)', fontSize: 15 }}>{formatCurrency(derived.totalSpent)}</p>
            </div>
            <div>
              <p className="billing-stat-label">Payouts</p>
              <p style={{ margin: '5px 0 0', fontFamily: 'var(--font-mono)', color: 'var(--green)', fontSize: 15 }}>{formatCurrency(derived.totalPayouts)}</p>
            </div>
            <div>
              <p className="billing-stat-label">Saved</p>
              <p style={{ margin: '5px 0 0', fontFamily: 'var(--font-mono)', color: 'var(--amber)', fontSize: 15 }}>{formatCurrency(derived.totalSaved)}</p>
            </div>
          </div>

          <div className="billing-phase-rail">
            {phaseRail.map(item => (
              <div key={item.label} className="billing-phase-chip">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</span>
                </div>
                <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--txt)' }}>{item.value}</p>
              </div>
            ))}
          </div>
        </article>

        <div className="billing-ledger-grid">
          <article className="billing-stat-card">
            <p className="billing-stat-label">Monthly Burn</p>
            <p className="billing-stat-value" style={{ color: 'var(--amber)' }}>{formatCurrency(derived.monthlyBurn)}</p>
            <p className="billing-stat-note">average account fee pressure</p>
          </article>

          <article className="billing-stat-card">
            <p className="billing-stat-label">Cost Per Pass</p>
            <p className="billing-stat-value">{derived.costPerPass !== null ? formatCurrency(derived.costPerPass) : '—'}</p>
            <p className="billing-stat-note">average spend per funded/pass</p>
          </article>

          <article className="billing-stat-card">
            <p className="billing-stat-label">Best Firm</p>
            <p className="billing-stat-value" style={{ fontSize: 15, fontFamily: 'var(--font-sans)', fontWeight: 600 }}>
              {derived.bestFirm ? derived.bestFirm.firm : '—'}
            </p>
            <p className="billing-stat-note">{derived.bestFirm ? `${formatSignedCurrency(derived.bestFirm.roi)} ROI` : 'no payouts yet'}</p>
          </article>

          <article className="billing-stat-card">
            <p className="billing-stat-label">Pass Rate</p>
            <p className="billing-stat-value">{derived.totalAccounts > 0 ? `${derived.passRate.toFixed(1)}%` : '0.0%'}</p>
            <p className="billing-stat-note">{derived.totalAccounts} accounts purchased</p>
          </article>
        </div>
      </section>

      <section className="billing-break-even">
        <div>
          <p className="billing-stat-label">Break-even pressure</p>
          <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--txt-2)' }}>
            Your first {formatCurrency(derived.monthlyBurn)} of monthly trading profit covers account fees before real upside starts.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>Avg fee <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt)' }}>{formatCurrency(derived.avgFeePerAccount)}</strong></span>
          <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>Funded/pass <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>{derived.passedAccounts + derived.fundedAccounts}</strong></span>
          <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>Blown <strong style={{ fontFamily: 'var(--font-mono)', color: derived.blownAccounts > 0 ? 'var(--red)' : 'var(--txt)' }}>{derived.blownAccounts}</strong></span>
        </div>
      </section>


      <section style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <header style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>Account Ledger</p>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--txt-3)' }}>Every purchase logged</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* View toggle */}
            <div style={{ display: 'flex', gap: 4 }}>
              <button type="button" className={`billing-view-btn${viewMode === 'table' ? ' active' : ''}`} onClick={() => setViewMode('table')}>
                <List size={12} /> Table
              </button>
              <button type="button" className={`billing-view-btn${viewMode === 'pipeline' ? ' active' : ''}`} onClick={() => setViewMode('pipeline')}>
                <LayoutGrid size={12} /> Pipeline
              </button>
            </div>

            {viewMode === 'table' && (
              <>
                <label className="billing-filter-wrap">
                  <span className="billing-filter-label">Firm</span>
                  <select className="billing-filter-select" value={firmFilter} onChange={e => setFirmFilter(e.target.value)}>
                    <option value="All">All Firms</option>
                    {Array.from(new Set(accounts.map(a => a.firm))).map(firm => (
                      <option key={firm} value={firm}>{firm}</option>
                    ))}
                  </select>
                </label>
                <label className="billing-filter-wrap">
                  <span className="billing-filter-label">Status</span>
                  <select className="billing-filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                    <option value="All">All</option>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </>
            )}

            <button
              type="button"
              onClick={openAddModal}
              style={{ height: 30, borderRadius: 5, border: 'none', background: 'var(--amber)', color: 'var(--app-bg)', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 10px', cursor: 'pointer' }}
            >
              <Plus size={12} /> Add
            </button>
          </div>
        </header>

        {/* ── Pipeline (Kanban) view ── */}
        {viewMode === 'pipeline' && (
          <div style={{ overflowX: 'auto', padding: '16px 20px' }}>
            {accounts.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', fontSize: 13, color: 'var(--txt-3)' }}>
                No accounts yet. Add your first prop account.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${PIPELINE_COLS.length}, minmax(200px, 1fr))`, gap: 12, minWidth: 900 }}>
                {PIPELINE_COLS.map(col => {
                  const colAccounts = pipelineByStatus[col];
                  const colStyle = getStatusBadgeStyle(col);
                  return (
                    <div key={col} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                        <span style={{ ...colStyle, borderRadius: 4, fontSize: 10, fontWeight: 700, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: getStatusDotColor(col), flexShrink: 0 }} />
                          {col}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>{colAccounts.length}</span>
                      </div>
                      {colAccounts.length === 0 ? (
                        <div style={{ border: '1px dashed var(--border)', borderRadius: 7, padding: '16px 12px', textAlign: 'center', fontSize: 11, color: 'var(--txt-3)' }}>
                          None
                        </div>
                      ) : (
                        colAccounts.map(a => (
                          <div key={a.id} className="pipeline-card" onClick={() => openEditModal(a)}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, marginBottom: 6 }}>
                              <div style={{ minWidth: 0 }}>
                                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{a.firm}</p>
                                <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--txt-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.accountType}</p>
                              </div>
                              <button
                                type="button"
                                className="billing-action-icon billing-delete"
                                onClick={e => { e.stopPropagation(); deleteAccount(a.id); }}
                                style={{ flexShrink: 0 }}
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                            <p style={{ margin: '0 0 6px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--txt-2)' }}>{a.size}</p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                                Cost: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt-2)' }}>{formatCurrency(a.actualPrice)}</span>
                              </span>
                              {a.payoutReceived > 0 && (
                                <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                                  Payout: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>{formatCurrency(a.payoutReceived)}</span>
                                </span>
                              )}
                              {a.purchaseDate && (
                                <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>{formatDateLabel(a.purchaseDate)}</span>
                              )}
                              {a.notes && (
                                <span style={{ fontSize: 10, color: 'var(--txt-3)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                  <MessageSquare size={9} />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{a.notes}</span>
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Table view ── */}
        {viewMode === 'table' && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1200 }}>
                <thead>
                  <tr>
                    {['Firm', 'Type', 'Size', 'Purchased', 'Status', 'List Price', 'Discount', 'Actual Price', 'Payouts', 'ROI', 'Notes', 'Actions'].map(header => (
                      <th key={header} style={{ textAlign: 'left', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--txt-3)', padding: '10px 14px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.length === 0 ? (
                    <tr>
                      <td colSpan={12} style={{ padding: '26px 24px', textAlign: 'center', fontSize: 12, color: 'var(--txt-3)', borderBottom: '1px solid var(--border-sub)' }}>
                        <div style={{ display: 'grid', placeItems: 'center', gap: 10 }}>
                          <span style={{ width: 36, height: 36, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--amber-dim)', border: '1px solid var(--amber-border)', color: 'var(--amber)' }}>
                            <CreditCard size={16} />
                          </span>
                          <span style={{ color: 'var(--txt-2)', fontSize: 13, fontWeight: 500 }}>No accounts yet</span>
                          <span style={{ color: 'var(--txt-3)', fontSize: 12 }}>Add your first prop account to unlock spend, burn, and ROI tracking.</span>
                          <button type="button" onClick={openAddModal} style={{ marginTop: 4, height: 28, borderRadius: 5, border: 'none', background: 'var(--amber)', color: 'var(--app-bg)', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 10px', cursor: 'pointer' }}>
                            <Plus size={12} /> Add first account
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredAccounts.map((account, index) => {
                      const roiValue = account.payoutReceived > 0 ? account.payoutReceived - account.actualPrice : null;
                      const isLast = index === filteredAccounts.length - 1;
                      const cellStyle: CSSProperties = { padding: '12px 14px', borderBottom: isLast ? 'none' : '1px solid var(--border-sub)' };
                      return (
                        <tr key={account.id} className="billing-table-row">
                          <td style={cellStyle}>
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{account.firm}</p>
                          </td>
                          <td style={{ ...cellStyle, fontSize: 12, color: 'var(--txt-2)', whiteSpace: 'nowrap' }}>{account.accountType}</td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{account.size}</td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt-3)', whiteSpace: 'nowrap' }}>{formatDateLabel(account.purchaseDate)}</td>
                          <td style={cellStyle}>
                            <span style={{ ...getStatusBadgeStyle(account.status), borderRadius: 3, fontSize: 10, fontWeight: 600, padding: '2px 7px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ width: 5, height: 5, borderRadius: '50%', background: getStatusDotColor(account.status), flexShrink: 0 }} />
                              {account.status}
                            </span>
                          </td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--txt-2)', textDecoration: account.discountPct > 0 ? 'line-through' : 'none', whiteSpace: 'nowrap' }}>
                            {formatCurrency(account.listPrice)}
                          </td>
                          <td style={cellStyle}>
                            {account.discountPct > 0 ? (
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green)', background: 'var(--green-dim)', border: '1px solid var(--green-border)', borderRadius: 3, padding: '2px 6px', display: 'inline-flex' }}>
                                {account.discountPct.toFixed(0)}% off
                                {account.discountCode ? ` · ${account.discountCode}` : ''}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>—</span>
                            )}
                          </td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500, color: 'var(--txt)', whiteSpace: 'nowrap' }}>
                            {formatCurrency(account.actualPrice)}
                          </td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {account.payoutReceived > 0 ? (
                              <span style={{ color: 'var(--green)' }}>
                                {formatCurrency(account.payoutReceived)}
                                {account.payouts && account.payouts.length > 1 && (
                                  <span style={{ fontSize: 10, color: 'var(--txt-3)', marginLeft: 5 }}>×{account.payouts.length}</span>
                                )}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--txt-3)' }}>—</span>
                            )}
                          </td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 12, color: roiValue === null ? 'var(--txt-3)' : roiValue >= 0 ? 'var(--green)' : 'var(--red)', whiteSpace: 'nowrap' }}>
                            {roiValue === null ? '—' : formatSignedCurrency(roiValue)}
                          </td>
                          <td style={{ ...cellStyle, maxWidth: 160 }}>
                            {account.notes ? (
                              <span style={{ fontSize: 11, color: 'var(--txt-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }} title={account.notes}>
                                {account.notes}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>—</span>
                            )}
                          </td>
                          <td style={cellStyle}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                              <button type="button" className="billing-action-icon" onClick={() => openEditModal(account)} aria-label={`Edit ${account.firm} account`}>
                                <Pencil size={13} />
                              </button>
                              <button type="button" className="billing-action-icon billing-delete" onClick={() => deleteAccount(account.id)} aria-label={`Delete ${account.firm} account`}>
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                {footerTotals.count} accounts · {footerTotals.passedCount} funded/passed
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                  List: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt-2)', textDecoration: 'line-through' }}>{formatCurrency(footerTotals.totalListPrice)}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                  Saved: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>{formatCurrency(footerTotals.totalSaved)}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                  Paid: <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--txt)' }}>{formatCurrency(footerTotals.totalPaid)}</span>
                </span>
              </span>
            </footer>
          </>
        )}
      </section>

      {/* ── ROI by Firm ──────────────────────────────────────────── */}
      <section style={{ marginTop: 16, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>ROI by Firm</p>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--txt-3)' }}>Which firms have been worth it</p>
        </header>
        {derived.roiByFirm.length === 0 ? (
          <div style={{ padding: '16px 18px', fontSize: 12, color: 'var(--txt-3)' }}>No firms logged yet.</div>
        ) : (
          derived.roiByFirm.map((row, index) => (
            <div key={row.firm} style={{ padding: '14px 18px', borderBottom: index === derived.roiByFirm.length - 1 ? 'none' : '1px solid var(--border-sub)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 140, fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{row.firm}</span>
              <span style={{ fontSize: 11, color: 'var(--txt-3)', fontFamily: 'var(--font-mono)' }}>{row.accounts} accounts</span>
              <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                Pass rate: <span style={{ fontFamily: 'var(--font-mono)', color: row.passRate >= 50 ? 'var(--green)' : 'var(--txt-2)' }}>{row.passRate.toFixed(0)}%</span>
              </span>
              {row.costPerPass !== null && (
                <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                  Cost/pass: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt-2)' }}>{formatCurrency(row.costPerPass)}</span>
                </span>
              )}
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4, fontSize: 10, color: 'var(--txt-3)' }}>
                  <span>Spent: {formatCurrency(row.spent)}</span>
                  <span>Received: {formatCurrency(row.payouts)}</span>
                </div>
                <div style={{ position: 'relative', height: 4, borderRadius: 2, background: 'var(--surface-3)', overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', inset: 0, background: 'var(--red)' }} />
                  <span style={{ position: 'absolute', inset: 0, width: `${row.recoveredRatio * 100}%`, background: 'var(--green)' }} />
                </div>
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, borderRadius: 3, padding: '4px 10px', background: row.roi >= 0 ? 'var(--green-dim)' : 'var(--red-dim)', color: row.roi >= 0 ? 'var(--green)' : 'var(--red)', border: row.roi >= 0 ? '1px solid var(--green-border)' : '1px solid var(--red-border)' }}>
                {formatSignedCurrency(row.roi)}
              </span>
            </div>
          ))
        )}
      </section>

      {/* ── Add / Edit modal ─────────────────────────────────────── */}
      {isModalOpen && (
        <div role="presentation" onClick={closeModal} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.65)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 16 }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? 'Edit Account' : 'Add Account'}
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 520, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', overflow: 'hidden', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
          >
            <header style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--txt)' }}>{editingId ? 'Edit Account' : 'Add Account'}</h2>
              <button type="button" onClick={closeModal} style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} aria-label="Close modal">
                <X size={14} />
              </button>
            </header>

            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              {/* Firm */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Prop Firm</label>
                <select className="billing-modal-field" value={form.firm} onChange={e => applyFirm(e.target.value)}>
                  {FIRM_OPTIONS.map(firm => <option key={firm} value={firm}>{firm}</option>)}
                </select>
              </div>

              {/* Account Type */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Account Type</label>
                {hasAccountTypeLookup ? (
                  <select className="billing-modal-field" value={form.accountType} onChange={e => applyAccountType(e.target.value)}>
                    {accountTypeOptions.map(type => <option key={type} value={type}>{type}</option>)}
                  </select>
                ) : (
                  <input className="billing-modal-field" value={form.accountType} onChange={e => setFormField('accountType', e.target.value)} placeholder="Evaluation, funded, instant..." />
                )}
              </div>

              {/* Size */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Account Size</label>
                {hasFirmLookup ? (
                  <select className="billing-modal-field" value={form.size} onChange={e => applySize(e.target.value)}>
                    {knownSizes.map(size => <option key={size} value={size}>{size}</option>)}
                  </select>
                ) : (
                  <input className="billing-modal-field" value={form.size} onChange={e => setFormField('size', e.target.value)} placeholder="Enter account size" />
                )}
              </div>

              {/* List price */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>List Price (before discount)</label>
                <div style={{ position: 'relative' }}>
                  <span aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>$</span>
                  <input className="billing-modal-field" type="number" min={0} step="0.01" value={Number.isFinite(form.listPrice) ? form.listPrice : 0} onChange={e => setFormField('listPrice', Math.max(0, toNumber(e.target.value, 0)))} style={{ fontFamily: 'var(--font-mono)', textAlign: 'right', paddingLeft: 28 }} />
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 11, color: livePricingLoadingFirm === form.firm ? 'var(--txt-2)' : livePricingError && !currentLivePricing ? 'var(--red)' : selectedSizeIsFallback ? 'var(--amber)' : currentLivePricing?.live ? 'var(--green)' : 'var(--txt-3)' }}>
                  {livePricingLoadingFirm === form.firm ? 'Syncing live prices...'
                    : livePricingError && !currentLivePricing ? `Live pricing unavailable. Using fallback values.`
                    : selectedSizeIsFallback ? `Using fallback value${currentPricingSourceLabel ? ` · ${currentPricingSourceLabel}` : ''}.`
                    : currentLivePricing?.live ? `Live price synced${currentPricingSourceLabel ? ` · ${currentPricingSourceLabel}` : ''}.`
                    : currentLivePricing?.note ?? 'Using configured fallback values.'}
                </p>
              </div>

              {/* Discount */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Discount Code</label>
                  <input className="billing-modal-field" value={form.discountCode} onChange={e => setFormField('discountCode', e.target.value.toUpperCase())} placeholder="e.g. APEX20" style={{ fontFamily: 'var(--font-mono)' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Discount %</label>
                  <div style={{ position: 'relative' }}>
                    <input className="billing-modal-field" type="number" min={0} max={100} step="0.1" value={Number.isFinite(form.discountPct) ? form.discountPct : 0} onChange={e => setFormField('discountPct', clampPercentage(toNumber(e.target.value, 0)))} style={{ fontFamily: 'var(--font-mono)', paddingRight: 30 }} />
                    <span aria-hidden="true" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>%</span>
                  </div>
                </div>
              </div>
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>Actual price paid</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: 'var(--txt)' }}>
                  {formatCurrency(actualPricePreview)}
                  {savingsPreview > 0 && <span style={{ fontSize: 11, color: 'var(--green)', marginLeft: 8 }}>({formatCurrency(savingsPreview)} saved)</span>}
                </span>
              </div>

              {/* Purchase date */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Purchase Date</label>
                <DatePicker
                  className="billing-modal-field"
                  value={form.purchaseDate}
                  onChange={value => setFormField('purchaseDate', value)}
                  fullWidth
                  align="left"
                />
              </div>

              {/* Status — 6-option grid */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Phase / Status</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden' }}>
                  {STATUS_OPTIONS.map(status => (
                    <button
                      key={status}
                      type="button"
                      className={`billing-status-toggle${form.status === status ? ' is-active' : ''}`}
                      onClick={() => setFormField('status', status)}
                      style={form.status === status ? { ...getStatusBadgeStyle(status), height: 32, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none' } : undefined}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>

              {/* Payouts (Funded / Passed only) */}
              {showPayoutSection && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-2)' }}>Payouts Received</label>
                    <button type="button" onClick={addPayout} style={{ height: 24, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-2)', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 8px', cursor: 'pointer' }}>
                      <Plus size={10} /> Add payout
                    </button>
                  </div>
                  {form.payouts.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--txt-3)' }}>No payouts recorded yet.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {form.payouts.map(p => (
                        <div key={p.id} className="payout-row">
                          <div style={{ position: 'relative' }}>
                            <span aria-hidden="true" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>$</span>
                            <input className="billing-modal-field" type="number" min={0} step="0.01" value={p.amount || ''} onChange={e => updatePayout(p.id, 'amount', e.target.value)} style={{ fontFamily: 'var(--font-mono)', paddingLeft: 22 }} placeholder="0.00" />
                          </div>
                          <DatePicker
                            className="billing-modal-field"
                            value={p.date}
                            onChange={value => updatePayout(p.id, 'date', value)}
                            fullWidth
                            align="right"
                            compact
                          />
                          <button type="button" onClick={() => removePayout(p.id)} style={{ width: 28, height: 38, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--green)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                        Total: {formatCurrency(formPayoutTotal)}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Notes */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>
                  Notes <span style={{ color: 'var(--txt-3)', fontWeight: 400 }}>(optional)</span>
                </label>
                <textarea
                  className="billing-modal-textarea"
                  value={form.notes}
                  onChange={e => setFormField('notes', e.target.value)}
                  placeholder="e.g. Blew up on FOMC day. Sized too large in phase 2."
                />
              </div>
            </div>

            <footer style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
              <button type="button" onClick={closeModal} style={{ height: 32, borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-2)', padding: '0 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
              <button type="button" onClick={saveAccount} style={{ height: 32, borderRadius: 5, border: 'none', background: 'var(--amber)', color: 'var(--bg)', padding: '0 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
