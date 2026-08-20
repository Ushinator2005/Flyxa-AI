import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  CreditCard,
  Download,
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
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { flushSupabaseStoreNow } from '../store/supabaseStorage.js';
import type { BillingAccount as StoreBillingAccount } from '../store/types.js';
import type { TradingAccount } from '../types/index.js';
import DatePicker from '../components/common/DatePicker.js';
import PayoutGallery from '../components/billing/PayoutGallery.js';
import { getEvaluationTemplates, type EvaluationTemplate } from '../utils/evaluationCoach.js';
import { formatUsd } from '../utils/format.js';
import * as XLSX from 'xlsx';

// The three simple tags a row can carry ('Eval' | 'Passed' | 'Activation fee'),
// plus legacy values kept so older/imported data still normalises cleanly.
type AccountStatus = 'Eval' | 'Passed' | 'Activation fee' | 'Eval 1' | 'Eval 2' | 'Funded' | 'Blown' | 'Reset';
type EvaluationOutcome = 'Unknown' | 'Not passed' | 'Passed' | 'Funded';
type OutcomeConfidence = 'low' | 'medium' | 'high';

interface PayoutEntry {
  id: string;
  amount: number;
  date: string;
}

interface BillingAccount {
  id: string;
  sourceAccountId?: string;
  entryKind?: 'account' | 'subscription' | 'reset' | 'activation';
  parentAccountId?: string;
  importedFromFile?: boolean;
  firm: string;
  accountType: string;
  size: string;
  listPrice: number;
  discountCode: string;
  discountPct: number;
  actualPrice: number;
  purchaseDate: string;
  status: AccountStatus;
  evaluationOutcome: EvaluationOutcome;
  outcomeEvidence?: string;
  outcomeConfidence?: OutcomeConfidence;
  payoutReceived: number;
  payouts: PayoutEntry[];
  notes: string;
  pricingPath?: 'standard' | 'no_activation_fee';
  activationFee?: number;
  dailyLossMode?: 'none' | 'purchase_fixed';
  optionalDailyLossLimit?: number | null;
  firmRuleVersionId?: string;
  ruleVerifiedAt?: string;
  ruleSourceUrl?: string;
  responsibleTradingDiscount?: number;
  responsibleTradingBenefit?: string;
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
  evaluationOutcome: EvaluationOutcome;
  outcomeEvidence: string;
  outcomeConfidence: OutcomeConfidence;
  payoutReceived: number;
  payouts: PayoutEntry[];
  notes: string;
  pricingPath: 'standard' | 'no_activation_fee';
  activationFee: number;
  dailyLossMode: 'none' | 'purchase_fixed';
  optionalDailyLossLimit: number | null;
  firmRuleVersionId: string;
  ruleVerifiedAt: string;
  ruleSourceUrl: string;
  responsibleTradingDiscount: number;
  responsibleTradingBenefit: string;
}

interface ParsedCsvRow {
  firm: string;
  size: string;
  accountType: string;
  pricingPath?: 'standard' | 'no_activation_fee';
  status: AccountStatus;
  evaluationOutcome: EvaluationOutcome;
  outcomeEvidence: string;
  outcomeConfidence: OutcomeConfidence;
  purchaseDate: string;
  pricePaid: number | null;
  priceProvided: boolean;
  entryKind: 'account' | 'subscription' | 'reset' | 'activation';
  classificationReason: string;
  discountCode: string;
  payoutReceived: number;
  notes: string;
  warning?: string;
}

type ViewMode = 'table' | 'pipeline';

const SELECTABLE_STATUS_OPTIONS: AccountStatus[] = ['Eval', 'Passed', 'Activation fee'];

const PIPELINE_COLS: AccountStatus[] = ['Eval', 'Passed', 'Activation fee'];

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
};

/** Normalise legacy 'Active' status from old data to 'Eval 1'. */
// Collapse any stored/imported/legacy status to one of the three valid tags, so
// no account can sit under a status that is no longer an option (e.g. Blown) and
// 'Eval 1'/'Eval 2' all read simply as 'Eval'.
function normalizeStatus(raw: unknown): AccountStatus {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'passed' || s === 'funded' || s === 'live') return 'Passed';
  if (s === 'activation fee' || s === 'activation') return 'Activation fee';
  return 'Eval';
}

/** Map the simplified template's single "Type" column to a tag, entry kind, and
 *  a sensible account-type label. Returns null when the cell is empty so the
 *  legacy multi-column inference can take over for older templates. */
function tagFromImportType(raw: string): { status: AccountStatus; entryKind: NonNullable<BillingAccount['entryKind']>; accountType: string } | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (/passed|funded/.test(t)) return { status: 'Passed', entryKind: 'account', accountType: '' };
  if (/activation/.test(t)) return { status: 'Activation fee', entryKind: 'activation', accountType: 'XFA activation fee' };
  if (/reset/.test(t)) return { status: 'Eval', entryKind: 'reset', accountType: 'Account reset' };
  if (/subscription|renewal|recurring/.test(t)) return { status: 'Eval', entryKind: 'subscription', accountType: 'Monthly subscription' };
  return { status: 'Eval', entryKind: 'account', accountType: '' };
}

function inferHistoricalOutcome(
  rawStatus: unknown,
  rawAccountType: unknown,
  rawNotes: unknown
): { outcome: EvaluationOutcome; evidence: string; confidence: OutcomeConfidence } {
  const status = String(rawStatus ?? '').trim().toLowerCase();
  const context = `${String(rawStatus ?? '')} ${String(rawAccountType ?? '')} ${String(rawNotes ?? '')}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (/\b(xfa|express funded|funded activation|activation to funded)\b/.test(context)) {
    return { outcome: 'Funded', evidence: 'XFA or funded activation found in the imported history', confidence: 'high' };
  }
  if (/\b(funded|live)\b/.test(status)) {
    return { outcome: 'Funded', evidence: 'Imported status was Funded', confidence: 'high' };
  }
  if (/\b(passed|complete|completed)\b/.test(status)) {
    return { outcome: 'Passed', evidence: 'Imported status showed the evaluation was passed', confidence: 'high' };
  }
  if (/\b(funded account|became funded|reached funded|funding achieved)\b/.test(context)) {
    return { outcome: 'Funded', evidence: 'Funding language found in the imported history', confidence: 'medium' };
  }
  if (/\b(passed|evaluation passed|combine passed)\b/.test(context)) {
    return { outcome: 'Passed', evidence: 'Pass language found in the imported history', confidence: 'medium' };
  }
  if (/\b(blown|failed|breached|terminated)\b/.test(status)) {
    return { outcome: 'Not passed', evidence: 'Imported status indicated a failed evaluation', confidence: 'medium' };
  }
  if (/\bclosed\b/.test(status)) {
    return { outcome: 'Not passed', evidence: 'Imported status showed the evaluation was closed', confidence: 'medium' };
  }
  return { outcome: 'Unknown', evidence: 'No reliable pass or funding signal was found', confidence: 'low' };
}

function inferStoredEntryKind(raw: StoreBillingAccount): NonNullable<BillingAccount['entryKind']> {
  const current = raw.entryKind ?? 'account';
  const importedFromFile = raw.importedFromFile === true
    || (raw.importedFromFile === undefined && raw.entryKind !== undefined && !raw.sourceAccountId);
  if (!importedFromFile) return current;

  const type = String(raw.accountType ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const notes = String(raw.notes ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  if (/\b(xfa|express funded)\b.*\b(activation|fee)\b|\bactivation fee\b.*\b(xfa|express funded)\b/.test(`${type} ${notes}`)) {
    // A row explicitly stored as a Trading Combine is still the account record;
    // the note may merely explain that its price includes an XFA activation.
    return /\btrading combine\b/.test(type) ? 'account' : 'activation';
  }
  if (/\b(account )?reset\b|\bfree reset\b/.test(type) || /\bfree reset used\b/.test(notes)) return 'reset';
  if (/\btrading combine\b|\bevaluation\b/.test(type)) return 'account';
  if (current === 'subscription' && /\bcombine subscription\b/.test(notes) && !/\bmonthly\b|\brenewal\b|\brebill\b/.test(notes)) {
    return 'account';
  }
  if (/\bmonthly subscription\b|\bsubscription fee\b|\bmonthly fee\b|\brenewal\b|\brebill\b/.test(type)) return 'subscription';
  return current;
}

/** Classify a billing entry from its account type when the user saves an edit.
 *  The entry kind must follow the type the trader chose — changing a row's type
 *  to "Trading Combine" makes it an account (so its status shows), while a type
 *  that still reads as a reset / activation / subscription keeps that charge
 *  classification. Anything not explicitly a charge is an account. */
function deriveEntryKindFromType(accountType: string): NonNullable<BillingAccount['entryKind']> {
  const type = accountType.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/\b(account )?reset\b|\bfree reset\b/.test(type)) return 'reset';
  if (/\bactivation fee\b|\bxfa activation\b/.test(type)) return 'activation';
  if (/\bmonthly subscription\b|\bsubscription fee\b|\bmonthly fee\b|\brenewal\b|\brebill\b/.test(type)) return 'subscription';
  return 'account';
}

function normalizeBillingAccount(raw: StoreBillingAccount): BillingAccount {
  const entryKind = inferStoredEntryKind(raw);
  const isLegacyFileImport = raw.importedFromFile === undefined
    && raw.entryKind !== undefined
    && !raw.sourceAccountId;
  const importedFromFile = raw.importedFromFile === true || isLegacyFileImport;
  const inferredOutcome = inferHistoricalOutcome(
    (raw as unknown as { status?: unknown }).status,
    (raw as unknown as { accountType?: unknown }).accountType,
    (raw as unknown as { notes?: unknown }).notes
  );
  const storedAccountType = typeof (raw as unknown as { accountType?: string }).accountType === 'string'
    ? (raw as unknown as { accountType: string }).accountType
    : getDefaultAccountType(raw.firm);
  const normalizedAccountType = entryKind === 'account' && storedAccountType === 'Monthly subscription'
    ? 'Trading Combine'
    : entryKind === 'activation'
      ? 'XFA activation fee'
      : entryKind === 'reset'
        ? 'Account reset'
        : storedAccountType;
  return {
    id: raw.id,
    sourceAccountId: raw.sourceAccountId,
    entryKind,
    parentAccountId: raw.parentAccountId,
    importedFromFile,
    firm: raw.firm,
    accountType: normalizedAccountType,
    size: raw.size,
    listPrice: raw.listPrice,
    discountCode: raw.discountCode,
    discountPct: raw.discountPct,
    actualPrice: raw.actualPrice,
    purchaseDate: raw.purchaseDate,
    // Collapse to the three valid tags. A funded/passed account (its outcome
    // says it cleared the evaluation) always reads as Passed — in this model a
    // funded account IS a passed account, there is no separate Funded tag.
    status: (() => {
      const s = normalizeStatus((raw as unknown as { status: unknown }).status);
      if (entryKind !== 'account') return s;
      const outcome = (raw.evaluationOutcome ?? inferredOutcome.outcome);
      return outcome === 'Funded' || outcome === 'Passed' ? 'Passed' : s;
    })(),
    evaluationOutcome: raw.evaluationOutcome ?? inferredOutcome.outcome,
    outcomeEvidence: raw.outcomeEvidence ?? inferredOutcome.evidence,
    outcomeConfidence: raw.outcomeConfidence ?? inferredOutcome.confidence,
    payoutReceived: raw.payoutReceived,
    payouts: Array.isArray((raw as unknown as { payouts?: PayoutEntry[] }).payouts)
      ? ((raw as unknown as { payouts: PayoutEntry[] }).payouts)
      : [],
    notes: typeof (raw as unknown as { notes?: string }).notes === 'string'
      ? ((raw as unknown as { notes: string }).notes)
      : '',
    pricingPath: raw.pricingPath,
    activationFee: raw.activationFee,
    dailyLossMode: raw.dailyLossMode,
    optionalDailyLossLimit: raw.optionalDailyLossLimit,
    firmRuleVersionId: raw.firmRuleVersionId,
    ruleVerifiedAt: raw.ruleVerifiedAt,
    ruleSourceUrl: raw.ruleSourceUrl,
    responsibleTradingDiscount: raw.responsibleTradingDiscount,
    responsibleTradingBenefit: raw.responsibleTradingBenefit,
  };
}


function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sizeLabelToNumber(size: string): number {
  const parsed = Number(size.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTopstepTemplate(size: string, path: 'standard' | 'no_activation_fee'): EvaluationTemplate | undefined {
  return getEvaluationTemplates().find(template => (
    template.firm === 'Topstep'
    && template.accountSize === sizeLabelToNumber(size)
    && template.path === path
  ));
}


const formatCurrency = formatUsd;

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

function formatAccountSize(size?: number): string {
  if (!size || !Number.isFinite(size)) return 'Custom';
  return `$${Math.round(size).toLocaleString('en-US')}`;
}

function billingStatusFromTradingAccount(status: TradingAccount['status']): AccountStatus {
  if (status === 'Funded' || status === 'Live') return 'Funded';
  if (status === 'Passed') return 'Passed';
  if (status === 'Blown') return 'Blown';
  return 'Eval 1';
}

function normalizeFirmName(account: TradingAccount): string {
  const broker = account.broker?.trim();
  if (!broker) return 'Other';
  return FIRM_OPTIONS.find(firm => firm.toLowerCase() === broker.toLowerCase()) ?? broker;
}

function accountTypeFromTradingAccount(account: TradingAccount, firm: string): string {
  if (account.evaluationProgram?.trim()) return account.evaluationProgram.trim();
  if (firm === 'Topstep') return 'Trading Combine';
  if (account.status === 'Funded' || account.status === 'Live') return 'Funded';
  return getDefaultAccountType(firm);
}

function catalogPriceForTradingAccount(account: TradingAccount, firm: string, size: string): number {
  if (firm === 'Topstep') {
    return getTopstepTemplate(size, account.evaluationPath ?? 'no_activation_fee')?.monthlyPrice ?? 0;
  }
  return FIRM_PRICES[firm]?.[size] ?? 0;
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
    status: 'Eval',
    evaluationOutcome: 'Unknown',
    outcomeEvidence: 'No outcome recorded yet',
    outcomeConfidence: 'low',
    payoutReceived: 0,
    payouts: [],
    notes: '',
    pricingPath: 'no_activation_fee',
    activationFee: 0,
    dailyLossMode: 'none',
    optionalDailyLossLimit: null,
    firmRuleVersionId: '',
    ruleVerifiedAt: '',
    ruleSourceUrl: '',
    responsibleTradingDiscount: 0,
    responsibleTradingBenefit: '',
  };
}

function getStatusBadgeStyle(status: AccountStatus): CSSProperties {
  switch (status) {
    case 'Eval':
    case 'Eval 1':
      return { background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid var(--amber-border)' };
    case 'Activation fee':
      return { background: 'var(--cobalt-dim)', color: 'var(--cobalt)', border: '1px solid var(--cobalt-border)' };
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
    case 'Eval':
    case 'Eval 1': return 'var(--amber)';
    case 'Activation fee': return 'var(--cobalt)';
    case 'Eval 2': return 'var(--cobalt)';
    case 'Funded': return '#818cf8';
    case 'Passed': return 'var(--green)';
    case 'Blown': return 'var(--red)';
    case 'Reset': return 'var(--txt-3)';
    default: return 'var(--txt-3)';
  }
}


function getEntryKindLabel(entryKind: NonNullable<BillingAccount['entryKind']>): string {
  if (entryKind === 'subscription') return 'Subscription';
  if (entryKind === 'reset') return 'Reset charge';
  if (entryKind === 'activation') return 'Activation fee';
  return 'Account';
}

export default function Billing() {
  const { accounts: tradingAccounts } = useAppSettings();
  const storeBillingAccounts = useFlyxaStore(state => state.billingAccounts);
  const hydrateSharedData = useFlyxaStore(state => state.hydrateSharedData);
  // The ledger is derived STRAIGHT from the store — the single source of truth.
  // There is no local copy and no write-back effect, so nothing can race the
  // cloud hydrate and wipe billing. The store only changes via commitAccounts.
  const accounts = useMemo(
    () => storeBillingAccounts.map(normalizeBillingAccount),
    [storeBillingAccounts]
  );
  // The ONLY writer of billingAccounts on this page. Runs solely from explicit
  // user actions (add / edit / delete / import), never on mount.
  const commitAccounts = useCallback((next: BillingAccount[]) => {
    hydrateSharedData({ billingAccounts: next as unknown as StoreBillingAccount[] });
    void flushSupabaseStoreNow();
  }, [hydrateSharedData]);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [firmFilter, setFirmFilter] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BillingFormState>(getDefaultFormState);
  const [livePricesByFirm, setLivePricesByFirm] = useState<Record<string, BillingLivePricesResponse>>({});
  const [isImportCsvModalOpen, setIsImportCsvModalOpen] = useState(false);
  const [csvParsedRows, setCsvParsedRows] = useState<ParsedCsvRow[]>([]);
  // Indices the trader has unchecked (excluded from import). Everything is
  // checked by default, so a row imports unless its index is in this set.
  const [csvExcluded, setCsvExcluded] = useState<Set<number>>(new Set());
  const [csvParseError, setCsvParseError] = useState('');
  const csvFileInputRef = useRef<HTMLInputElement>(null);

  const importCandidates = useMemo(() => {
    const importedSourceIds = new Set(accounts.map(account => account.sourceAccountId).filter(Boolean));
    return tradingAccounts.filter(account => (
      account.id !== DEFAULT_ACCOUNT_ID
      && !importedSourceIds.has(account.id)
    ));
  }, [accounts, tradingAccounts]);


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
    try {
      const payload = await billingApi.getLivePrices(firm);
      setLivePricesByFirm(current => ({ ...current, [firm]: payload }));
      return payload;
    } catch {
      return null;
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

  const openImportModal = () => {
    setSelectedImportIds(importCandidates.map(account => account.id));
    setImportFeedback(null);
    setIsImportModalOpen(true);
  };

  const importSelectedAccounts = () => {
    const selectedIds = new Set(selectedImportIds);
    const selectedAccounts = importCandidates.filter(account => selectedIds.has(account.id));
    if (selectedAccounts.length === 0) return;

    const imported = selectedAccounts.map((account): BillingAccount => {
      const firm = normalizeFirmName(account);
      const size = formatAccountSize(account.startingBalance);
      const pricingPath = firm === 'Topstep' ? account.evaluationPath ?? 'no_activation_fee' : undefined;
      const template = firm === 'Topstep' && pricingPath ? getTopstepTemplate(size, pricingPath) : undefined;
      const listPrice = catalogPriceForTradingAccount(account, firm, size);
      const responsibleDiscount = firm === 'Topstep'
        && pricingPath === 'no_activation_fee'
        && account.dailyLossMode === 'purchase_fixed'
        ? template?.responsibleTradingDiscount ?? 0
        : 0;
      const createdDate = account.createdAt ? new Date(account.createdAt) : null;
      const purchaseDate = createdDate && !Number.isNaN(createdDate.getTime())
        ? createdDate.toISOString().slice(0, 10)
        : getTodayInputDate();

      // Carry payout history over from the linked trading account so ROI is
      // right on import, previously these were dropped, zeroing recovered ROI.
      const maybePayouts = (account as unknown as { payouts?: Array<{ id?: string; amount?: number; date?: string }> }).payouts;
      const srcPayouts = Array.isArray(maybePayouts) ? maybePayouts : [];
      const importedPayouts = srcPayouts
        .filter(p => Number.isFinite(p?.amount))
        .map(p => ({ id: typeof p.id === 'string' && p.id ? p.id : createId(), amount: Math.max(0, Number(p.amount)), date: typeof p.date === 'string' && p.date ? p.date : purchaseDate }));
      const importedPayoutTotal = importedPayouts.reduce((sum, p) => sum + p.amount, 0);

      return {
        id: createId(),
        sourceAccountId: account.id,
        firm,
        accountType: accountTypeFromTradingAccount(account, firm),
        size,
        listPrice,
        discountCode: '',
        discountPct: 0,
        actualPrice: Math.max(0, listPrice - responsibleDiscount),
        purchaseDate,
        status: billingStatusFromTradingAccount(account.status),
        evaluationOutcome: account.status === 'Funded' || account.status === 'Live'
          ? 'Funded'
          : account.status === 'Passed'
            ? 'Passed'
            : account.status === 'Blown'
              ? 'Not passed'
              : 'Unknown',
        outcomeEvidence: `Imported from linked account status: ${account.status}`,
        outcomeConfidence: 'high',
        payoutReceived: importedPayoutTotal,
        payouts: importedPayouts,
        notes: `Imported from account: ${account.name}${listPrice === 0 ? '. Add the purchase price to complete billing.' : ''}`,
        pricingPath,
        activationFee: template?.activationFee,
        dailyLossMode: firm === 'Topstep'
          ? account.dailyLossMode === 'purchase_fixed' ? 'purchase_fixed' : 'none'
          : undefined,
        optionalDailyLossLimit: template?.optionalDailyLossLimit,
        firmRuleVersionId: account.firmRuleVersionId || template?.id,
        ruleVerifiedAt: account.ruleVerifiedAt || template?.verifiedAt,
        ruleSourceUrl: account.ruleSourceUrl || template?.sourceUrl,
        responsibleTradingDiscount: responsibleDiscount || undefined,
        responsibleTradingBenefit: responsibleDiscount > 0 ? template?.responsibleTradingBenefit : undefined,
      };
    });

    commitAccounts([...imported, ...accounts]);
    setIsImportModalOpen(false);
    setSelectedImportIds([]);
    setImportFeedback(`${imported.length} account${imported.length === 1 ? '' : 's'} imported.`);
  };

  const downloadExcelTemplate = () => {
    // One "Type" column carries the tag (Eval / Passed / Reset / Activation fee).
    // Discount and payouts are omitted — the trader adds those in the app.
    const headers = ['Firm', 'Account Size', 'Type', 'Purchase Date', 'Price Paid', 'Notes'];
    const example1 = ['Topstep', '$50,000', 'Eval', '2026-06-01', 85, 'Trading combine'];
    const example2 = ['Apex', '$50,000', 'Passed', '2026-03-15', 137, 'Passed evaluation'];
    const example3 = ['Topstep', '$50,000', 'Reset', '2026-07-10', 0, 'Account reset'];
    const example4 = ['Topstep', '$50,000', 'Activation fee', '2026-07-18', 149, 'XFA activation'];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, example1, example2, example3, example4]);

    // Column widths
    ws['!cols'] = [{ wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 11 }, { wch: 42 }];

    XLSX.utils.book_append_sheet(wb, ws, 'Accounts');
    XLSX.writeFile(wb, 'flyxa-accounts-template.xlsx');
  };

  const parseBillingCsv = (text: string): ParsedCsvRow[] => {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');

    const parseFields = (line: string): string[] => {
      const fields: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      fields.push(current.trim());
      return fields;
    };

    const headerFields = parseFields(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const col = (name: string) => headerFields.indexOf(name.replace(/[^a-z0-9]/g, '').toLowerCase());
    const iCol = col('firm');
    if (iCol === -1) throw new Error('Could not find a "Firm" column in the CSV header.');

    const colFirm          = iCol;
    const colSize          = col('accountsize');
    const colType          = col('type');
    const colAccountType   = col('accounttype');
    const colEntryType     = col('entrytype');
    const colStatus        = col('status');
    const colDate          = col('purchasedate');
    const colPrice         = col('pricepaid');
    const colDiscount      = col('discountcode');
    const colPayout        = col('payoutreceived');
    const colNotes         = col('notes');

    const rows: ParsedCsvRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseFields(lines[i]);
      const get = (idx: number) => (idx >= 0 && idx < fields.length ? fields[idx] : '');

      const rawFirm        = get(colFirm);
      const rawSize        = get(colSize);
      const rawAccountType = get(colAccountType);
      const rawEntryType   = get(colEntryType);
      const rawStatus      = get(colStatus);
      const rawDate        = get(colDate);
      const rawPrice       = get(colPrice);
      const rawDisc        = get(colDiscount);
      const rawPayout      = get(colPayout);
      const rawNotes       = get(colNotes);

      if (!rawFirm && !rawSize && !rawPrice) continue; // skip blank rows

      const warnings: string[] = [];

      // Firm normalisation
      const firmMatch = FIRM_OPTIONS.find(
        f => f.toLowerCase() === rawFirm.toLowerCase()
      ) ?? 'Other';
      if (firmMatch === 'Other' && rawFirm) warnings.push(`Unknown firm "${rawFirm}", set to Other`);

      // Status normalisation — a single "Type" cell wins when present.
      const typeTag = colType >= 0 ? tagFromImportType(get(colType)) : null;
      const meaning = inferImportMeaning(typeTag ? '' : rawStatus, rawAccountType, rawNotes, rawEntryType);
      const status: AccountStatus = typeTag ? typeTag.status : meaning.status;
      const entryKind = typeTag ? typeTag.entryKind : meaning.entryKind;
      if (!typeTag && meaning.warning) warnings.push(meaning.warning);

      // Date validation
      const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(rawDate);
      const purchaseDate = dateValid ? rawDate : '';
      if (!rawDate) warnings.push('Purchase date is missing, left blank');
      if (!dateValid && rawDate) warnings.push('Date format should be YYYY-MM-DD, date left blank');

      // Numeric fields
      const parsedPrice    = parseOptionalMoney(rawPrice);
      const payoutReceived = parseFloat(rawPayout.replace(/[^0-9.-]/g, '')) || 0;

      // Account type — Type column's label first, then explicit column, then notes.
      const inferHint = `${rawAccountType} ${rawNotes}`.trim();
      const inferred = inferAccountTypeFromText(firmMatch, inferHint);
      const accountType = rawAccountType.trim() || (typeTag?.accountType || inferred.accountType);

      // Size — keep raw but strip leading/trailing spaces
      const size = rawSize || '';

      rows.push({
        firm: firmMatch,
        size,
        accountType,
        pricingPath: inferred.pricingPath,
        status,
        evaluationOutcome: typeTag?.status === 'Passed' ? 'Passed' : meaning.evaluationOutcome,
        outcomeEvidence: meaning.outcomeEvidence,
        outcomeConfidence: meaning.outcomeConfidence,
        purchaseDate,
        pricePaid: parsedPrice.value,
        priceProvided: parsedPrice.provided,
        entryKind,
        classificationReason: typeTag ? 'Set from the Type column' : meaning.classificationReason,
        discountCode: rawDisc,
        payoutReceived,
        notes: rawNotes,
        warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      });
    }

    if (rows.length === 0) throw new Error('No valid rows found in the CSV file.');
    return rows;
  };

  const inferAccountTypeFromText = (firm: string, text: string): { accountType: string; pricingPath?: 'standard' | 'no_activation_fee' } => {
    const lower = text.toLowerCase();
    let accountType = '';
    let pricingPath: 'standard' | 'no_activation_fee' | undefined;

    if (firm === 'Apex Funded') {
      accountType = 'Evaluation';
    } else if (firm === 'FTMO') {
      accountType = 'Challenge';
    } else if (firm === 'Topstep') {
      accountType = 'Trading Combine';
      if (lower.includes('no activation') || lower.includes('no act') || lower.includes('naf') || lower.includes('no_act')) {
        pricingPath = 'no_activation_fee';
      } else if (lower.includes('standard')) {
        pricingPath = 'standard';
      } else {
        pricingPath = 'no_activation_fee'; // most common path
      }
    } else if (firm === 'Lucid') {
      if (lower.includes('maxx')) accountType = 'LucidMaxx';
      else if (lower.includes('direct')) accountType = 'LucidDirect';
      else if (lower.includes('pro')) accountType = 'LucidPro';
      else if (lower.includes('flex')) accountType = 'LucidFlex';
    } else if (firm === 'Alpha Futures') {
      if (lower.includes('premium')) accountType = 'Premium Plan';
      else if (lower.includes('advanced')) accountType = 'Advanced Plan';
      else if (lower.includes('standard')) accountType = 'Standard Plan';
    } else if (firm === 'MyFundedFutures') {
      if (lower.includes('expert')) accountType = 'Expert';
      else if (lower.includes('starter')) accountType = 'Starter';
    }

    return { accountType, pricingPath };
  };

  const inferImportMeaning = (
    rawStatus: string,
    rawAccountType: string,
    rawNotes: string,
    rawEntryType = ''
  ): {
    status: AccountStatus;
    entryKind: ParsedCsvRow['entryKind'];
    classificationReason: string;
    evaluationOutcome: EvaluationOutcome;
    outcomeEvidence: string;
    outcomeConfidence: OutcomeConfidence;
    warning?: string;
  } => {
    const statusText = rawStatus.trim().toLowerCase();
    const accountTypeText = rawAccountType.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const explicitEntryType = rawEntryType.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const notesText = rawNotes.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const context = `${rawStatus} ${rawAccountType} ${rawNotes}`.toLowerCase();
    const normalized = context.replace(/[^a-z0-9]+/g, ' ').trim();
    const historical = inferHistoricalOutcome(rawStatus, rawAccountType, rawNotes);

    let entryKind: ParsedCsvRow['entryKind'] = 'account';
    let classificationReason = 'Defaulted to an account purchase';

    if (/\bactivation\b/.test(explicitEntryType)) {
      entryKind = 'activation';
      classificationReason = 'Entry Type explicitly says Activation';
    } else if (/\breset\b/.test(explicitEntryType)) {
      entryKind = 'reset';
      classificationReason = 'Entry Type explicitly says Reset';
    } else if (/\b(subscription|renewal|recurring)\b/.test(explicitEntryType)) {
      entryKind = 'subscription';
      classificationReason = 'Entry Type explicitly says Subscription';
    } else if (/\b(account|combine|evaluation)\b/.test(explicitEntryType)) {
      entryKind = 'account';
      classificationReason = 'Entry Type explicitly says Account';
    } else if (/\b(xfa|express funded)\b.*\b(activation|fee)\b|\bactivation fee\b.*\b(xfa|express funded)\b/.test(accountTypeText)) {
      entryKind = 'activation';
      classificationReason = 'Account Type identifies an XFA/Express Funded activation fee';
    } else if (/\b(account )?reset\b/.test(accountTypeText) || /\b(free )?reset\b/.test(notesText)) {
      entryKind = 'reset';
      classificationReason = 'Reset event found in the account type or note';
    } else if (/\bmonthly subscription\b|\bsubscription fee\b|\bmonthly fee\b|\brenewal\b|\brebill\b|\brecurring charge\b/.test(`${accountTypeText} ${notesText}`)) {
      entryKind = 'subscription';
      classificationReason = 'A recurring monthly charge was found in the account type or note';
    } else if (/\btrading combine\b|\bevaluation\b/.test(accountTypeText)) {
      entryKind = 'account';
      classificationReason = `Account Type "${rawAccountType}" identifies a trading account`;
    } else if (/\b(xfa|express funded)\b.*\b(activation|fee)\b|\bactivation fee\b.*\b(xfa|express funded)\b/.test(notesText)) {
      entryKind = 'activation';
      classificationReason = 'XFA/Express Funded activation fee found in the note';
    }
    const result = (
      status: AccountStatus,
      resolvedEntryKind: ParsedCsvRow['entryKind'] = entryKind,
      warning?: string
    ) => ({
      status,
      entryKind: resolvedEntryKind,
      classificationReason,
      evaluationOutcome: historical.outcome,
      outcomeEvidence: historical.evidence,
      outcomeConfidence: historical.confidence,
      warning,
    });

    if (/\b(xfa|express funded|funded activation|activation to funded)\b/.test(normalized)) {
      return result('Funded');
    }
    if (/\b(blown|failed|breached|terminated)\b/.test(statusText)) {
      return result('Blown');
    }
    if (/\b(funded|xfa)\b/.test(statusText)) {
      return result('Funded');
    }
    if (/\b(passed|complete|completed)\b/.test(statusText)) {
      return result('Passed');
    }
    if (/\b(reset)\b/.test(statusText)) {
      return result('Reset', 'reset');
    }
    if (/\b(eval 2|phase 2|step 2)\b/.test(statusText)) {
      return result('Eval 2');
    }
    if (entryKind === 'subscription' && (!statusText || /\b(in progress|active|current|subscription)\b/.test(statusText))) {
      return result('Eval 1');
    }
    if (/\b(in progress|active|current|evaluation|eval|combine)\b/.test(statusText)) {
      return result('Eval 1');
    }
    if (!statusText && entryKind === 'account') {
      return result('Eval');
    }

    return {
      status: 'Eval',
      entryKind,
      classificationReason,
      evaluationOutcome: historical.outcome,
      outcomeEvidence: historical.evidence,
      outcomeConfidence: historical.confidence,
      warning: rawStatus ? `Unknown status "${rawStatus}", tagged as Eval` : undefined,
    };
  };

  const parseOptionalMoney = (raw: string): { value: number | null; provided: boolean } => {
    const trimmed = raw.trim();
    if (trimmed === '') return { value: null, provided: false };
    const parsed = Number(trimmed.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed)
      ? { value: parsed, provided: true }
      : { value: null, provided: false };
  };

  const lookupCatalogPrice = (firm: string, size: string, pricingPath?: 'standard' | 'no_activation_fee'): { price: number; activationFee: number; canonicalSize: string } => {
    const sizeNum = parseFloat(size.replace(/[^0-9.]/g, ''));

    // Topstep — price comes from evaluation templates (monthly price + optional activation fee)
    if (firm === 'Topstep') {
      const path = pricingPath ?? 'no_activation_fee';
      const topstepSizes = getSizesForFirm('Topstep', 'Trading Combine');
      const canonicalSize = topstepSizes.find(s => parseFloat(s.replace(/[^0-9.]/g, '')) === sizeNum) ?? size;
      const template = getTopstepTemplate(canonicalSize, path);
      return {
        price: template?.monthlyPrice ?? 0,
        activationFee: template?.activationFee ?? 0,
        canonicalSize,
      };
    }

    const firmPrices = FIRM_PRICES[firm];
    if (!firmPrices) return { price: 0, activationFee: 0, canonicalSize: size };
    // Exact match first
    if (firmPrices[size] !== undefined) return { price: firmPrices[size], activationFee: 0, canonicalSize: size };
    // Numeric match
    if (!sizeNum) return { price: 0, activationFee: 0, canonicalSize: size };
    for (const [key, price] of Object.entries(firmPrices)) {
      const keyNum = parseFloat(key.replace(/[^0-9.]/g, ''));
      if (keyNum === sizeNum) return { price, activationFee: 0, canonicalSize: key };
    }
    return { price: 0, activationFee: 0, canonicalSize: size };
  };

  const csvRowToBillingAccount = (row: ParsedCsvRow, parentAccountId?: string): BillingAccount => {
    const { price: catalogPrice, activationFee, canonicalSize } = lookupCatalogPrice(row.firm, row.size, row.pricingPath);
    const accountType = row.accountType || getDefaultAccountType(row.firm);
    const autoPricePaid = row.priceProvided
      ? Math.max(0, row.pricePaid ?? 0)
      : row.entryKind === 'account'
        ? catalogPrice + activationFee
        : 0;
    const displayListPrice = row.entryKind === 'account'
      ? (catalogPrice > 0 ? catalogPrice : autoPricePaid)
      : autoPricePaid;
    return {
      id: createId(),
      entryKind: row.entryKind,
      parentAccountId,
      importedFromFile: true,
      firm: row.firm,
      accountType: row.entryKind === 'subscription'
        ? 'Monthly subscription'
        : row.entryKind === 'reset'
          ? 'Account reset'
          : row.entryKind === 'activation'
            ? 'XFA activation fee'
          : accountType,
      size: canonicalSize,
      listPrice: displayListPrice,
      discountCode: row.discountCode,
      discountPct: 0,
      actualPrice: autoPricePaid,
      purchaseDate: row.purchaseDate,
      // Respect the imported tag — normalizeStatus already collapsed it to one of
      // the three (Eval / Passed / Activation fee); no more defaulting to Blown.
      status: normalizeStatus(row.status),
      evaluationOutcome: row.entryKind === 'account' ? row.evaluationOutcome : 'Unknown',
      outcomeEvidence: row.outcomeEvidence,
      outcomeConfidence: row.outcomeConfidence,
      payoutReceived: row.payoutReceived,
      payouts: [],
      notes: row.notes,
      pricingPath: row.pricingPath,
      activationFee: row.entryKind === 'account' && activationFee > 0 ? activationFee : undefined,
    };
  };

  const parseExcelWorkbook = (buffer: ArrayBuffer): ParsedCsvRow[] => {
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
    if (raw.length < 2) throw new Error('Spreadsheet must have a header row and at least one data row.');

    const headers = (raw[0] as unknown[]).map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, ''));
    const col = (name: string) => headers.indexOf(name.replace(/[^a-z0-9]/g, '').toLowerCase());

    const colFirm        = col('firm');
    const colSize        = col('accountsize');
    const colType        = col('type');
    const colAccountType = col('accounttype');
    const colEntryType   = col('entrytype');
    const colStatus      = col('status');
    const colDate        = col('purchasedate');
    const colPrice       = col('pricepaid');
    const colDiscount    = col('discountcode');
    const colPayout      = col('payoutreceived');
    const colNotes       = col('notes');

    if (colFirm === -1) throw new Error('Could not find a "Firm" column in the spreadsheet header.');

    const rows: ParsedCsvRow[] = [];

    for (let i = 1; i < raw.length; i++) {
      const rowData = raw[i] as unknown[];
      const get = (idx: number): string => {
        if (idx < 0 || idx >= rowData.length) return '';
        const v = rowData[idx];
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return String(v ?? '').trim();
      };

      const rawFirm        = get(colFirm);
      const rawSize        = get(colSize);
      const rawAccountType = get(colAccountType);
      const rawEntryType   = get(colEntryType);
      const rawPrice       = get(colPrice);

      if (!rawFirm && !rawSize && !rawPrice) continue;

      const warnings: string[] = [];

      const firmMatch = FIRM_OPTIONS.find(f => f.toLowerCase() === rawFirm.toLowerCase()) ?? 'Other';
      if (firmMatch === 'Other' && rawFirm) warnings.push(`Unknown firm "${rawFirm}", set to Other`);

      const rawStatus = get(colStatus);
      const rawNotes = get(colNotes);
      // New simplified template: a single "Type" cell decides the tag + kind.
      // Older templates (no Type column) fall back to the multi-column inference.
      const typeTag = colType >= 0 ? tagFromImportType(get(colType)) : null;
      const meaning = inferImportMeaning(typeTag ? '' : rawStatus, rawAccountType, rawNotes, rawEntryType);
      const status: AccountStatus = typeTag ? typeTag.status : meaning.status;
      const entryKind = typeTag ? typeTag.entryKind : meaning.entryKind;
      if (!typeTag && meaning.warning) warnings.push(meaning.warning);

      const rawDate = get(colDate);
      const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(rawDate);
      const purchaseDate = dateValid ? rawDate : '';
      if (!rawDate) warnings.push('Purchase date is missing, left blank');
      if (!dateValid && rawDate) warnings.push('Date format should be YYYY-MM-DD, date left blank');

      const parsedPrice    = parseOptionalMoney(rawPrice);
      const rawPayout      = get(colPayout);
      const payoutReceived = parseFloat(rawPayout.replace(/[^0-9.-]/g, '')) || 0;

      // Account type — Type column's label first, then explicit column, then notes.
      const inferHint = `${rawAccountType} ${rawNotes}`.trim();
      const inferred = inferAccountTypeFromText(firmMatch, inferHint);
      const accountType = rawAccountType.trim() || (typeTag?.accountType || inferred.accountType);

      rows.push({
        firm: firmMatch,
        size: rawSize,
        accountType,
        pricingPath: inferred.pricingPath,
        status,
        evaluationOutcome: typeTag?.status === 'Passed' ? 'Passed' : meaning.evaluationOutcome,
        outcomeEvidence: meaning.outcomeEvidence,
        outcomeConfidence: meaning.outcomeConfidence,
        purchaseDate,
        pricePaid: parsedPrice.value,
        priceProvided: parsedPrice.provided,
        entryKind,
        classificationReason: typeTag ? 'Set from the Type column' : meaning.classificationReason,
        discountCode: get(colDiscount),
        payoutReceived,
        notes: rawNotes,
        warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      });
    }

    if (rows.length === 0) throw new Error('No valid rows found in the spreadsheet.');
    return rows;
  };

  const handleFileImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    setCsvParseError('');

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const rows = parseExcelWorkbook(e.target?.result as ArrayBuffer);
          setCsvParsedRows(rows);
          setCsvExcluded(new Set());
          setIsImportCsvModalOpen(true);
        } catch (err) {
          setCsvParseError(err instanceof Error ? err.message : 'Failed to parse spreadsheet.');
          setCsvParsedRows([]);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const rows = parseBillingCsv(e.target?.result as string);
          setCsvParsedRows(rows);
          setCsvExcluded(new Set());
          setIsImportCsvModalOpen(true);
        } catch (err) {
          setCsvParseError(err instanceof Error ? err.message : 'Failed to parse CSV.');
          setCsvParsedRows([]);
        }
      };
      reader.readAsText(file);
    }
  };

  const confirmCsvImport = () => {
    const knownAccounts = accounts.filter(account => (account.entryKind ?? 'account') === 'account');
    const newAccounts: BillingAccount[] = [];
    const fundedParentIds = new Set<string>();
    for (let idx = 0; idx < csvParsedRows.length; idx++) {
      if (csvExcluded.has(idx)) continue; // trader unchecked this row
      const row = csvParsedRows[idx];
      const candidates = [...knownAccounts, ...newAccounts.filter(account => (account.entryKind ?? 'account') === 'account')];
      const parent = row.entryKind === 'account'
        ? undefined
        : [...candidates].reverse().find(account => (
          account.firm === row.firm
          && sizeLabelToNumber(account.size) === sizeLabelToNumber(row.size)
          && (!row.purchaseDate || !account.purchaseDate || account.purchaseDate <= row.purchaseDate)
        ));
      const imported = csvRowToBillingAccount(row, parent?.id);
      if (row.entryKind !== 'account') {
        imported.notes = [
          row.notes,
          parent ? `Attached to ${parent.firm} ${parent.size} account.` : 'Billing event imported without a matched parent account.',
        ].filter(Boolean).join(' ');
        if (row.entryKind === 'activation' && parent) {
          fundedParentIds.add(parent.id);
        }
      }
      newAccounts.push(imported);
    }
    commitAccounts([...newAccounts, ...accounts].map(account => (
      fundedParentIds.has(account.id)
        ? {
            ...account,
            evaluationOutcome: 'Funded',
            outcomeEvidence: 'A linked XFA/Express Funded activation fee was imported',
            outcomeConfidence: 'high',
          }
        : account
    )));
    setIsImportCsvModalOpen(false);
    setCsvParsedRows([]);
    const accountCount = newAccounts.filter(account => (account.entryKind ?? 'account') === 'account').length;
    const chargeCount = newAccounts.length - accountCount;
    setImportFeedback(`${accountCount} account${accountCount === 1 ? '' : 's'} and ${chargeCount} billing event${chargeCount === 1 ? '' : 's'} imported.`);
  };

  const openEditModal = (account: BillingAccount) => {
    const inferredPath = account.pricingPath
      ?? (account.activationFee === 149 ? 'standard' : 'no_activation_fee');
    const topstepTemplate = account.firm === 'Topstep'
      ? getTopstepTemplate(account.size, inferredPath)
      : undefined;
    setEditingId(account.id);
    setForm({
      firm: account.firm,
      accountType: account.accountType ?? getDefaultAccountType(account.firm),
      size: account.size,
      // Load the price actually paid, never a template/live price, so opening a
      // row to change its tag can't rewrite what was paid.
      listPrice: account.actualPrice || account.listPrice,
      discountCode: account.discountCode,
      discountPct: account.discountPct,
      purchaseDate: account.purchaseDate,
      status: account.status,
      evaluationOutcome: account.evaluationOutcome,
      outcomeEvidence: account.outcomeEvidence ?? 'Outcome set manually',
      outcomeConfidence: account.outcomeConfidence ?? 'medium',
      payoutReceived: account.payoutReceived,
      payouts: account.payouts ?? [],
      notes: account.notes ?? '',
      pricingPath: inferredPath,
      activationFee: topstepTemplate?.activationFee ?? account.activationFee ?? 0,
      dailyLossMode: account.dailyLossMode ?? 'none',
      optionalDailyLossLimit: topstepTemplate?.optionalDailyLossLimit ?? account.optionalDailyLossLimit ?? null,
      firmRuleVersionId: topstepTemplate?.id ?? account.firmRuleVersionId ?? '',
      ruleVerifiedAt: topstepTemplate?.verifiedAt ?? account.ruleVerifiedAt ?? '',
      ruleSourceUrl: topstepTemplate?.sourceUrl ?? account.ruleSourceUrl ?? '',
      responsibleTradingDiscount: topstepTemplate?.responsibleTradingDiscount ?? account.responsibleTradingDiscount ?? 0,
      responsibleTradingBenefit: topstepTemplate?.responsibleTradingBenefit ?? account.responsibleTradingBenefit ?? '',
    });
    setIsModalOpen(true);
    void fetchLivePricesForFirm(account.firm);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
  };

  const responsibleDiscount = form.firm === 'Topstep'
    && form.pricingPath === 'no_activation_fee'
    && form.dailyLossMode === 'purchase_fixed'
    ? form.responsibleTradingDiscount
    : 0;
  const priceAfterResponsibleDiscount = Math.max(0, toNumber(form.listPrice, 0) - responsibleDiscount);

  // Derived payout total from payouts array (falls back to legacy payoutReceived)
  const formPayoutTotal = useMemo(
    () => form.payouts.reduce((sum, p) => sum + Math.max(0, p.amount), 0) || form.payoutReceived,
    [form.payouts, form.payoutReceived]
  );

  const derived = useMemo(() => {
    const accountEntries = accounts.filter(account => (account.entryKind ?? 'account') === 'account');
    const totalAccounts = accountEntries.length;
    const totalSpent = accounts.reduce((sum, a) => sum + a.actualPrice, 0);
    const totalPayouts = accounts.reduce((sum, a) => sum + Math.max(0, a.payoutReceived), 0);
    const netPnL = totalPayouts - totalSpent;
    // Count by the tag, not the entry kind: a row tagged Passed/Eval counts even
    // when its notes ("resets", "subscription", "XFA activation") made the entry
    // classifier read it as a charge. The tag is the source of truth.
    const passedAccounts = accounts.filter(a => a.status === 'Passed').length;
    const activeAccounts = accounts.filter(a => a.status === 'Eval').length;
    // Pass rate = passed evaluations over every evaluation attempt (Eval + Passed).
    const attemptedAccounts = passedAccounts + activeAccounts;
    const passRate = attemptedAccounts > 0 ? (passedAccounts / attemptedAccounts) * 100 : 0;
    const avgFeePerAccount = totalAccounts > 0 ? totalSpent / totalAccounts : 0;
    const costPerPass = passedAccounts > 0 ? totalSpent / passedAccounts : null;

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
      if ((a.entryKind ?? 'account') === 'account') cur.accounts += 1;
      cur.spent += a.actualPrice;
      cur.payouts += Math.max(0, a.payoutReceived);
      if (
        (a.entryKind ?? 'account') === 'account'
        && (a.status === 'Passed' || a.evaluationOutcome === 'Passed' || a.evaluationOutcome === 'Funded')
      ) cur.passed += 1;
      if ((a.entryKind ?? 'account') === 'account' && a.status === 'Blown') cur.blown += 1;
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
      avgFeePerAccount, passedAccounts, activeAccounts,
      passRate, costPerPass, attemptedAccounts, roiByFirm, bestFirm,
    };
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    return accounts.filter(a => {
      if (firmFilter !== 'All' && a.firm !== firmFilter) return false;
      if (statusFilter !== 'All' && a.status !== statusFilter) return false;
      return true;
    }).sort((a, b) => {
      // Newest purchase first; rows without a date sink to the bottom. Dates are
      // ISO strings (YYYY-MM-DD), so a plain string compare orders them correctly.
      if (!a.purchaseDate) return 1;
      if (!b.purchaseDate) return -1;
      return b.purchaseDate.localeCompare(a.purchaseDate);
    });
  }, [accounts, firmFilter, statusFilter]);

  const footerTotals = useMemo(() => {
    const totalListPrice = filteredAccounts.reduce((sum, a) => sum + a.listPrice, 0);
    const totalPaid = filteredAccounts.reduce((sum, a) => sum + a.actualPrice, 0);
    const totalSaved = Math.max(0, totalListPrice - totalPaid);
    const passedCount = filteredAccounts.filter(a => (
      (a.entryKind ?? 'account') === 'account'
      && (a.status === 'Passed' || a.evaluationOutcome === 'Passed' || a.evaluationOutcome === 'Funded')
    )).length;
    const accountCount = filteredAccounts.filter(account => (account.entryKind ?? 'account') === 'account').length;
    const chargeCount = filteredAccounts.length - accountCount;
    return { totalListPrice, totalPaid, totalSaved, count: accountCount, chargeCount, passedCount };
  }, [filteredAccounts]);

  const pipelineByStatus = useMemo(() => {
    const map: Record<AccountStatus, BillingAccount[]> = {
      'Eval': [], 'Passed': [], 'Activation fee': [],
      'Eval 1': [], 'Eval 2': [], 'Funded': [], 'Blown': [], 'Reset': [],
    };
    accounts.filter(account => (account.entryKind ?? 'account') === 'account').forEach(a => { map[a.status].push(a); });
    return map;
  }, [accounts]);

  const accountTypeOptions = useMemo(() => getAccountTypesForFirm(form.firm), [form.firm]);
  const hasAccountTypeLookup = accountTypeOptions.length > 0;
  const knownSizes = useMemo(() => getSizesForFirm(form.firm, form.accountType), [form.accountType, form.firm]);
  const hasFirmLookup = knownSizes.length > 0;

  const showPayoutSection = form.status === 'Passed';

  const saveAccount = () => {
    // "Price paid" is the single source of truth (held in form.listPrice). Store
    // it as both list and actual price so nothing — status changes, templates, or
    // live pricing — can ever silently rewrite what the trader entered.
    const pricePaid = Math.max(0, toNumber(form.listPrice, 0));
    const listPrice = pricePaid;
    const actualPrice = pricePaid;
    const discountPct = 0;
    const catalogDiscount = 0;
    const payouts = showPayoutSection ? form.payouts : [];
    const payoutReceived = payouts.reduce((sum, p) => sum + Math.max(0, p.amount), 0)
      || (showPayoutSection ? Math.max(0, toNumber(form.payoutReceived, 0)) : 0);

    const next: BillingAccount = {
      id: editingId ?? createId(),
      sourceAccountId: editingId ? accounts.find(account => account.id === editingId)?.sourceAccountId : undefined,
      // Reclassify from the chosen account type so a row edited to a real combine
      // stops showing a stale "Reset charge"/"Subscription" badge and shows its status.
      entryKind: deriveEntryKindFromType(form.accountType),
      parentAccountId: editingId ? accounts.find(account => account.id === editingId)?.parentAccountId : undefined,
      importedFromFile: editingId ? accounts.find(account => account.id === editingId)?.importedFromFile : false,
      firm: form.firm.trim() || 'Other',
      accountType: form.accountType.trim() || getDefaultAccountType(form.firm.trim() || 'Other'),
      size: form.size.trim() || 'Custom',
      listPrice,
      discountCode: form.discountCode.trim().toUpperCase(),
      discountPct,
      actualPrice,
      purchaseDate: form.purchaseDate || getTodayInputDate(),
      status: form.status,
      // The chosen tag is authoritative: sync the outcome to it so the load-time
      // "funded/passed -> Passed" promotion can't override a manual re-tag. Only a
      // Passed tag records a passed outcome; anything else clears it.
      evaluationOutcome: form.status === 'Passed' ? 'Passed' : 'Unknown',
      outcomeEvidence: form.outcomeEvidence.trim() || 'Outcome set manually',
      outcomeConfidence: form.outcomeConfidence,
      payoutReceived,
      payouts,
      notes: form.notes.trim(),
      pricingPath: form.firm === 'Topstep' ? form.pricingPath : undefined,
      activationFee: form.firm === 'Topstep' ? form.activationFee : undefined,
      dailyLossMode: form.firm === 'Topstep' ? form.dailyLossMode : undefined,
      optionalDailyLossLimit: form.firm === 'Topstep' ? form.optionalDailyLossLimit : undefined,
      firmRuleVersionId: form.firm === 'Topstep' ? form.firmRuleVersionId : undefined,
      ruleVerifiedAt: form.firm === 'Topstep' ? form.ruleVerifiedAt : undefined,
      ruleSourceUrl: form.firm === 'Topstep' ? form.ruleSourceUrl : undefined,
      responsibleTradingDiscount: form.firm === 'Topstep' ? catalogDiscount : undefined,
      responsibleTradingBenefit: form.firm === 'Topstep' ? form.responsibleTradingBenefit : undefined,
    };

    commitAccounts(editingId
      ? accounts.map(row => (row.id === editingId ? next : row))
      : [next, ...accounts]);
    closeModal();
  };

  const deleteAccount = (id: string) => {
    const target = accounts.find(a => a.id === id);
    if (!target) return;
    const confirmed = window.confirm(`Delete billing entry for ${target.firm} ${target.size}?`);
    if (!confirmed) return;
    commitAccounts(accounts.filter(a => a.id !== id));
  };

  const setFormField = <K extends keyof BillingFormState>(key: K, value: BillingFormState[K]) => {
    setForm(current => ({ ...current, [key]: value }));
  };

  const applyFirm = (firm: string) => {
    const nextAccountType = getDefaultAccountType(firm);
    const nextSizes = getSizesForFirm(firm, nextAccountType);
    const nextSize = nextSizes[0] ?? form.size;
    const topstepTemplate = firm === 'Topstep' ? getTopstepTemplate(nextSize, 'no_activation_fee') : undefined;
    const nextListPrice = topstepTemplate?.monthlyPrice ?? getPreferredListPrice(firm, nextSize, form.listPrice);
    setForm(current => ({
      ...current, firm,
      accountType: nextAccountType,
      size: nextSizes.length > 0 ? nextSize : current.size,
      listPrice: nextListPrice,
      pricingPath: firm === 'Topstep' ? 'no_activation_fee' : current.pricingPath,
      activationFee: topstepTemplate?.activationFee ?? 0,
      dailyLossMode: firm === 'Topstep' ? 'none' : current.dailyLossMode,
      optionalDailyLossLimit: topstepTemplate?.optionalDailyLossLimit ?? null,
      firmRuleVersionId: topstepTemplate?.id ?? '',
      ruleVerifiedAt: topstepTemplate?.verifiedAt ?? '',
      ruleSourceUrl: topstepTemplate?.sourceUrl ?? '',
      responsibleTradingDiscount: topstepTemplate?.responsibleTradingDiscount ?? 0,
      responsibleTradingBenefit: topstepTemplate?.responsibleTradingBenefit ?? '',
    }));
    if (firm === 'Topstep') return;
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
    const topstepTemplate = form.firm === 'Topstep' ? getTopstepTemplate(nextSize, form.pricingPath) : undefined;
    const nextListPrice = topstepTemplate?.monthlyPrice ?? getPreferredListPrice(form.firm, nextSize, form.listPrice);
    setForm(current => ({
      ...current,
      accountType,
      size: nextSizes.length > 0 ? nextSize : current.size,
      listPrice: nextListPrice,
      activationFee: topstepTemplate?.activationFee ?? current.activationFee,
      optionalDailyLossLimit: topstepTemplate?.optionalDailyLossLimit ?? current.optionalDailyLossLimit,
      firmRuleVersionId: topstepTemplate?.id ?? current.firmRuleVersionId,
      ruleVerifiedAt: topstepTemplate?.verifiedAt ?? current.ruleVerifiedAt,
      ruleSourceUrl: topstepTemplate?.sourceUrl ?? current.ruleSourceUrl,
      responsibleTradingDiscount: topstepTemplate?.responsibleTradingDiscount ?? current.responsibleTradingDiscount,
      responsibleTradingBenefit: topstepTemplate?.responsibleTradingBenefit ?? current.responsibleTradingBenefit,
    }));
  };

  const applySize = (size: string) => {
    const selectedFirm = form.firm;
    const topstepTemplate = selectedFirm === 'Topstep' ? getTopstepTemplate(size, form.pricingPath) : undefined;
    const lookupPrice = topstepTemplate?.monthlyPrice ?? getPreferredListPrice(selectedFirm, size, form.listPrice);
    setForm(current => ({
      ...current,
      size,
      listPrice: lookupPrice,
      activationFee: topstepTemplate?.activationFee ?? current.activationFee,
      optionalDailyLossLimit: topstepTemplate?.optionalDailyLossLimit ?? current.optionalDailyLossLimit,
      firmRuleVersionId: topstepTemplate?.id ?? current.firmRuleVersionId,
      ruleVerifiedAt: topstepTemplate?.verifiedAt ?? current.ruleVerifiedAt,
      ruleSourceUrl: topstepTemplate?.sourceUrl ?? current.ruleSourceUrl,
      responsibleTradingDiscount: topstepTemplate?.responsibleTradingDiscount ?? current.responsibleTradingDiscount,
      responsibleTradingBenefit: topstepTemplate?.responsibleTradingBenefit ?? current.responsibleTradingBenefit,
    }));
    if (selectedFirm === 'Topstep') return;
    void fetchLivePricesForFirm(selectedFirm).then(payload => {
      const livePrice = payload?.prices?.[size];
      if (!isFiniteNumber(livePrice)) return;
      setForm(current => (
        current.firm === selectedFirm && current.size === size ? { ...current, listPrice: livePrice } : current
      ));
    });
  };

  const applyTopstepPath = (pricingPath: 'standard' | 'no_activation_fee') => {
    const template = getTopstepTemplate(form.size, pricingPath);
    setForm(current => ({
      ...current,
      pricingPath,
      listPrice: template?.monthlyPrice ?? current.listPrice,
      activationFee: template?.activationFee ?? current.activationFee,
      optionalDailyLossLimit: template?.optionalDailyLossLimit ?? current.optionalDailyLossLimit,
      firmRuleVersionId: template?.id ?? current.firmRuleVersionId,
      ruleVerifiedAt: template?.verifiedAt ?? current.ruleVerifiedAt,
      ruleSourceUrl: template?.sourceUrl ?? current.ruleSourceUrl,
      responsibleTradingDiscount: template?.responsibleTradingDiscount ?? current.responsibleTradingDiscount,
      responsibleTradingBenefit: template?.responsibleTradingBenefit ?? current.responsibleTradingBenefit,
    }));
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
    { label: 'Passed', value: derived.passedAccounts, color: 'var(--green)' },
  ];
  const netTone = derived.netPnL >= 0 ? 'positive' : 'negative';

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 28px 40px', background: 'var(--surface-1)' }}>
      <style>{`
        .billing-kicker { margin: 0; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--amber); font-weight: 700; }
        .billing-stat-label { margin: 0; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--txt-2); }
        .billing-stat-note { margin: 0; font-size: 11px; color: var(--txt-3); line-height: 1.45; }
        .billing-command-btn { height: 34px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--txt-2); display: inline-flex; align-items: center; gap: 7px; padding: 0 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color 120ms, color 120ms, background 120ms; }
        .billing-command-btn:hover { border-color: rgba(255,255,255,0.18); color: var(--txt); }
        .billing-command-btn.primary { border-color: var(--amber); background: var(--amber); color: var(--bg); }
        .billing-table-row:hover td { background: rgba(255,255,255,0.02); }
        .billing-action-icon { border: none; background: transparent; color: var(--txt-3); display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
        .billing-action-icon:hover { color: var(--txt-2); }
        .billing-action-icon.billing-delete:hover { color: var(--red); }
        .billing-status-toggle { border: none; height: 32px; font-size: 11px; font-weight: 500; color: var(--txt-2); background: var(--surface-2); cursor: pointer; }
        .billing-status-toggle.is-active { background: var(--amber); color: var(--bg); }
        .billing-modal-field { width: 100%; height: 38px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-2); color: var(--txt); font-size: 13px; padding: 0 12px; outline: none; }
        .billing-modal-field:focus { border-color: var(--amber-border); }
        .billing-number-sharp {
          font-family: var(--font-sans) !important;
          font-weight: 500 !important;
          font-variant-numeric: tabular-nums lining-nums;
          letter-spacing: -0.01em;
          text-shadow: none !important;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
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
      `}</style>

      <section data-tour-id="billing-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <p className="billing-kicker">Funding Desk</p>
          <h1 style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 600, color: 'var(--txt)', letterSpacing: 0 }}>Billing</h1>
          <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--txt-2)', lineHeight: 1.45 }}>
            Track prop firm spend, challenge phases, discounts, payouts, and account ROI.
          </p>
        </div>
        <div data-tour-id="billing-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="billing-command-btn" onClick={() => setViewMode(viewMode === 'table' ? 'pipeline' : 'table')}>
            {viewMode === 'table' ? <LayoutGrid size={14} /> : <List size={14} />}
            {viewMode === 'table' ? 'Pipeline' : 'Ledger'}
          </button>
          <button type="button" className="billing-command-btn" onClick={downloadExcelTemplate}>
            <Download size={14} />
            Download Template
          </button>
          <button type="button" className="billing-command-btn" onClick={() => { setCsvParseError(''); csvFileInputRef.current?.click(); }}>
            <Plus size={14} />
            Import from Excel
          </button>
          <input
            ref={csvFileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={handleFileImport}
          />
          <button type="button" className="billing-command-btn" onClick={openImportModal}>
            <Download size={14} />
            Import Accounts
          </button>
          <button type="button" className="billing-command-btn primary" onClick={openAddModal}>
            <Plus size={14} />
            Add Account
          </button>
        </div>
      </section>
      {importFeedback && (
        <div style={{ margin: '-6px 0 14px', fontSize: 11, color: 'var(--green)' }}>{importFeedback}</div>
      )}
      {csvParseError && (
        <div style={{ margin: '-6px 0 14px', fontSize: 11, color: 'var(--red)' }}>{csvParseError}</div>
      )}

      {/* ── Flat stat strip ── */}
      <section data-tour-id="billing-overview" style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '14px 0', marginBottom: 0 }}>
        <div style={{ marginBottom: 12, borderLeft: '2px solid var(--amber)', paddingLeft: 10 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--txt-2)' }}>Overview</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, flexWrap: 'wrap' }}>
        {/* Net Position — prominent anchor */}
        <div style={{ paddingRight: 28, marginRight: 28, borderRight: '1px solid var(--border)', flexShrink: 0 }}>
          <p className="billing-stat-label">Net Position</p>
          <div style={{ margin: '6px 0 4px', fontFamily: 'var(--font-mono)', fontSize: 28, lineHeight: 1, fontWeight: 500, color: netTone === 'positive' ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: 8 }}>
            {formatSignedCurrency(derived.netPnL)}
            {netTone === 'positive' ? <TrendingUp size={15} style={{ opacity: 0.55 }} /> : <TrendingDown size={15} style={{ opacity: 0.55 }} />}
          </div>
          <p className="billing-stat-note">
            {derived.totalPayouts > 0
              ? `${formatCurrency(derived.totalPayouts)} received vs ${formatCurrency(derived.totalSpent)} spent`
              : `${formatCurrency(derived.totalSpent)} in fees, no payouts yet`}
          </p>
        </div>

        {/* Secondary stats */}
        <div style={{ display: 'flex', gap: 28, flex: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <p className="billing-stat-label">Spent</p>
            <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', color: 'var(--red)', fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(derived.totalSpent)}</p>
          </div>
          <div>
            <p className="billing-stat-label">Payouts</p>
            <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', color: 'var(--green)', fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(derived.totalPayouts)}</p>
          </div>
          <div>
            <p className="billing-stat-label">Monthly Burn</p>
            <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', color: 'var(--amber)', fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(derived.monthlyBurn)}</p>
          </div>
          <div>
            <p className="billing-stat-label">Best Firm</p>
            <p style={{ margin: '6px 0 2px', fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>
              {derived.bestFirm ? derived.bestFirm.firm : '—'}
            </p>
            {derived.bestFirm && (
              <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11, color: derived.bestFirm.roi >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {formatSignedCurrency(derived.bestFirm.roi)} ROI
              </p>
            )}
          </div>
          <div>
            <p className="billing-stat-label">Pass Rate</p>
            <p style={{ margin: '6px 0 2px', fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>
              {derived.attemptedAccounts > 0 ? `${derived.passRate.toFixed(1)}%` : '0.0%'}
            </p>
            <p style={{ margin: 0, fontSize: 10, color: 'var(--txt-3)' }}>
              {derived.passedAccounts} of {derived.attemptedAccounts} passed
            </p>
          </div>
          <div>
            <p className="billing-stat-label">Cost / Pass</p>
            <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>
              {derived.costPerPass !== null ? formatCurrency(derived.costPerPass) : '—'}
            </p>
          </div>
        </div>
        </div>
      </section>

      {/* ── Phase rail ── */}
      <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
        <div style={{ marginBottom: 8, borderLeft: '2px solid var(--amber)', paddingLeft: 10 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--txt-2)' }}>Pipeline</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 24 }}>
        {phaseRail.map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--txt)' }}>{item.value}</span>
          </div>
        ))}
        </div>
      </div>

      {/* ── Break-even flat strip ── */}
      <div style={{ padding: '9px 0', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        <div style={{ marginBottom: 8, borderLeft: '2px solid var(--amber)', paddingLeft: 10 }}>
          <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--txt-2)', fontWeight: 700 }}>Break-even</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--txt-2)', marginRight: 4 }}>
          First {formatCurrency(derived.monthlyBurn)} of monthly profit covers fees before upside starts
        </span>
        <span style={{ width: 1, height: 12, background: 'var(--border)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>Avg fee <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt)', fontWeight: 500 }}>{formatCurrency(derived.avgFeePerAccount)}</strong></span>
        <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>Ever passed <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--green)', fontWeight: 500 }}>{derived.passedAccounts}</strong></span>
        </div>
      </div>

      <div data-tour-id="billing-payouts">
        <PayoutGallery
          total={derived.totalPayouts}
          payoutCount={accounts.reduce((count, account) => (
            count + (account.payouts?.length || (account.payoutReceived > 0 ? 1 : 0))
          ), 0)}
        />
      </div>

      <section data-tour-id="billing-ledger" style={{ borderTop: '1px solid var(--border)' }}>
        <header style={{ padding: '12px 0', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ borderLeft: '2px solid var(--amber)', paddingLeft: 10 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>Account Ledger</p>
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
                    {SELECTABLE_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
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
                                <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--txt-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {a.accountType}{a.firm === 'Topstep' && a.pricingPath ? ` · ${a.pricingPath === 'no_activation_fee' ? 'No activation fee' : 'Standard'}` : ''}
                                </p>
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
                    {['Firm', 'Type', 'Size', 'Purchased', 'Status', 'Price paid', 'Payouts', 'ROI', 'Notes', 'Actions'].map(header => (
                      <th key={header} style={{ textAlign: 'left', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--txt-3)', padding: '10px 14px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.length === 0 ? (
                    <tr>
                      <td colSpan={10} style={{ padding: '26px 24px', textAlign: 'center', fontSize: 12, color: 'var(--txt-3)', borderBottom: '1px solid var(--border-sub)' }}>
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
                      // ROI mirrors the payouts taken — the cost is already shown
                      // separately in the Price paid column, so it isn't netted here.
                      const roiValue = account.payoutReceived > 0 ? account.payoutReceived : null;
                      const isLast = index === filteredAccounts.length - 1;
                      const cellStyle: CSSProperties = { padding: '12px 14px', borderBottom: isLast ? 'none' : '1px solid var(--border-sub)' };
                      return (
                        <tr key={account.id} className="billing-table-row">
                          <td style={cellStyle}>
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{account.firm}</p>
                          </td>
                          <td style={{ ...cellStyle, fontSize: 12, color: 'var(--txt-2)', whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'block' }}>{account.accountType}</span>
                            {account.firm === 'Topstep' && account.pricingPath && (
                              <span style={{ display: 'block', marginTop: 3, fontSize: 9, color: 'var(--txt-3)' }}>
                                {account.pricingPath === 'no_activation_fee' ? 'No Activation Fee' : `Standard · ${formatCurrency(account.activationFee ?? 149)} activation`}
                                {account.dailyLossMode === 'purchase_fixed' ? ` · ${formatCurrency(account.optionalDailyLossLimit ?? 0)} DLL` : ''}
                              </span>
                            )}
                          </td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{account.size}</td>
                          <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt-3)', whiteSpace: 'nowrap' }}>{formatDateLabel(account.purchaseDate)}</td>
                          <td style={cellStyle}>
                            <span style={{ ...getStatusBadgeStyle(account.status), borderRadius: 3, fontSize: 10, fontWeight: 600, padding: '2px 7px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ width: 5, height: 5, borderRadius: '50%', background: getStatusDotColor(account.status), flexShrink: 0 }} />
                              {account.status}
                            </span>
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
            <footer style={{ padding: '10px 0', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                {footerTotals.count} accounts · {footerTotals.chargeCount} billing events · {footerTotals.passedCount} funded/passed
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                  Paid: <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--txt)' }}>{formatCurrency(footerTotals.totalPaid)}</span>
                </span>
              </span>
            </footer>
          </>
        )}
      </section>

      {/* ── ROI by Firm ──────────────────────────────────────────── */}
      <section style={{ marginTop: 20, borderTop: '1px solid var(--border)' }}>
        <header style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ borderLeft: '2px solid var(--amber)', paddingLeft: 10 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>ROI by Firm</p>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--txt-3)' }}>Which firms have been worth it</p>
          </div>
        </header>
        {derived.roiByFirm.length === 0 ? (
          <div style={{ padding: '14px 0', fontSize: 12, color: 'var(--txt-3)' }}>No firms logged yet.</div>
        ) : (
          derived.roiByFirm.map((row, index) => (
            <div key={row.firm} style={{ padding: '12px 0', borderBottom: index === derived.roiByFirm.length - 1 ? 'none' : '1px solid var(--border-sub)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
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
                <div style={{ position: 'relative', height: 3, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', inset: 0, background: 'var(--red)', opacity: 0.5 }} />
                  <span style={{ position: 'absolute', inset: 0, width: `${row.recoveredRatio * 100}%`, background: 'var(--green)' }} />
                </div>
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: row.roi >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {formatSignedCurrency(row.roi)}
              </span>
            </div>
          ))
        )}
      </section>

      {isImportModalOpen && (
        <div role="presentation" onClick={() => setIsImportModalOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.65)', display: 'grid', placeItems: 'center', zIndex: 121, padding: 16 }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Import accounts into billing"
            onClick={event => event.stopPropagation()}
            style={{ width: '100%', maxWidth: 560, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', overflow: 'hidden' }}
          >
            <header style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--txt)' }}>Import existing accounts</h2>
                <p style={{ margin: '5px 0 0', color: 'var(--txt-3)', fontSize: 11 }}>Bring account details into Billing. Existing imports are automatically excluded.</p>
              </div>
              <button type="button" onClick={() => setIsImportModalOpen(false)} style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} aria-label="Close import modal">
                <X size={14} />
              </button>
            </header>

            <div style={{ padding: 16, maxHeight: '55vh', overflowY: 'auto' }}>
              {importCandidates.length === 0 ? (
                <div style={{ padding: '24px 12px', textAlign: 'center' }}>
                  <p style={{ margin: 0, color: 'var(--txt-2)', fontSize: 13 }}>All existing accounts are already in Billing.</p>
                  <p style={{ margin: '6px 0 0', color: 'var(--txt-3)', fontSize: 11 }}>Add another trading account first, then return here to import it.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {importCandidates.map(account => {
                    const checked = selectedImportIds.includes(account.id);
                    return (
                      <label key={account.id} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr) auto', gap: 12, alignItems: 'center', border: checked ? '1px solid var(--amber)' : '1px solid var(--border)', background: 'var(--surface-2)', borderRadius: 7, padding: '12px 13px', cursor: 'pointer', transition: 'border-color .1s' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedImportIds(current => (
                            current.includes(account.id)
                              ? current.filter(id => id !== account.id)
                              : [...current, account.id]
                          ))}
                          style={{ accentColor: 'var(--amber)' }}
                        />
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ display: 'block', color: 'var(--txt)', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{account.name}</strong>
                          <span style={{ display: 'block', marginTop: 3, color: 'var(--txt-3)', fontSize: 10 }}>
                            {account.broker || 'Firm not set'} · {account.evaluationProgram || account.type}
                          </span>
                        </span>
                        <span style={{ textAlign: 'right' }}>
                          <strong style={{ display: 'block', color: 'var(--txt-2)', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{formatAccountSize(account.startingBalance)}</strong>
                          <span style={{ display: 'block', marginTop: 3, color: account.status === 'Blown' ? 'var(--red)' : account.status === 'Funded' || account.status === 'Live' ? 'var(--green)' : 'var(--txt-3)', fontSize: 10 }}>{account.status}{account.archived ? ' · Archived' : ''}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <footer style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>{selectedImportIds.length} selected</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setIsImportModalOpen(false)} className="billing-command-btn">Cancel</button>
                <button type="button" onClick={importSelectedAccounts} className="billing-command-btn primary" disabled={selectedImportIds.length === 0} style={selectedImportIds.length === 0 ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}>
                  <Download size={13} />
                  Import selected
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {/* ── CSV import preview modal ──────────────────────────────── */}
      {isImportCsvModalOpen && (
        <div role="presentation" onClick={() => setIsImportCsvModalOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.65)', display: 'grid', placeItems: 'center', zIndex: 122, padding: 16 }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Import accounts from CSV"
            onClick={event => event.stopPropagation()}
            style={{ width: '100%', maxWidth: 940, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            <header style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--txt)' }}>Import accounts from CSV</h2>
                <p style={{ margin: '5px 0 0', color: 'var(--txt-3)', fontSize: 11 }}>{csvParsedRows.length} row{csvParsedRows.length === 1 ? '' : 's'} detected. Review before importing.</p>
              </div>
              <button type="button" onClick={() => setIsImportCsvModalOpen(false)} style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }} aria-label="Close CSV import modal">
                <X size={14} />
              </button>
            </header>

            <div style={{ overflowX: 'hidden', overflowY: 'auto', maxHeight: '55vh' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: 34 }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '10%' }} />
                  <col />
                  <col style={{ width: 30 }} />
                </colgroup>
                <thead>
                  <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <th style={{ padding: '8px 6px', textAlign: 'center', borderBottom: '1px solid var(--border)' }}>
                      <input type="checkbox" checked={csvExcluded.size === 0}
                        onChange={() => setCsvExcluded(csvExcluded.size === 0 ? new Set(csvParsedRows.map((_, i) => i)) : new Set())}
                        style={{ cursor: 'pointer', accentColor: 'var(--amber)' }} aria-label="Select all rows" />
                    </th>
                    {['Firm', 'Source Type', 'Imported As', 'Size', 'Status', 'Purchase Date', 'Price Paid', 'Notes', ''].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--txt-2)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvParsedRows.map((row, idx) => {
                    const { price: catalogPrice, activationFee } = lookupCatalogPrice(row.firm, row.size, row.pricingPath);
                    const displayPrice = row.priceProvided
                      ? Math.max(0, row.pricePaid ?? 0)
                      : row.entryKind === 'account'
                        ? catalogPrice + activationFee
                        : 0;
                    const checked = !csvExcluded.has(idx);
                    return (
                    <tr key={idx} style={{ borderBottom: '1px solid var(--border)', opacity: checked ? 1 : 0.4, background: row.warning ? 'rgba(var(--amber-rgb, 255, 180, 0), 0.05)' : undefined }}>
                      <td style={{ padding: '9px 6px', textAlign: 'center' }}>
                        <input type="checkbox" checked={checked}
                          onChange={() => setCsvExcluded(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; })}
                          style={{ cursor: 'pointer', accentColor: 'var(--amber)' }} aria-label={`Include ${row.firm} ${row.size}`} />
                      </td>
                      <td style={{ padding: '9px 12px', color: 'var(--txt)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.firm}>{row.firm}</td>
                      <td style={{ padding: '9px 12px', color: 'var(--txt-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.accountType}>{row.accountType || <span style={{ color: 'var(--txt-3)' }}>—</span>}</td>
                      <td title={row.classificationReason} style={{ padding: '9px 12px', color: row.entryKind === 'account' ? 'var(--green)' : 'var(--amber)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {getEntryKindLabel(row.entryKind)}
                      </td>
                      <td style={{ padding: '9px 12px', color: 'var(--txt-2)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{row.size}</td>
                      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                        {(() => { const tag = normalizeStatus(row.status); return (
                          <span style={{ ...getStatusBadgeStyle(tag), borderRadius: 3, fontSize: 10, fontWeight: 600, padding: '2px 7px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 5, height: 5, borderRadius: '50%', background: getStatusDotColor(tag), flexShrink: 0 }} />
                            {tag}
                          </span>
                        ); })()}
                      </td>
                      <td style={{ padding: '9px 12px', color: 'var(--txt-2)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{row.purchaseDate}</td>
                      <td style={{ padding: '9px 12px', color: displayPrice > 0 ? 'var(--txt-2)' : 'var(--txt-3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                        {displayPrice > 0 ? `$${displayPrice.toFixed(2)}` : '—'}
                      </td>
                      <td style={{ padding: '9px 12px', color: 'var(--txt-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.notes}>{row.notes || '—'}</td>
                      <td style={{ padding: '9px 6px', textAlign: 'center' }}>
                        {row.warning && (
                          <span title={row.warning} style={{ color: 'var(--amber)', cursor: 'help', fontSize: 13 }}>⚠</span>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {csvParsedRows.some(r => r.warning) && (
              <div style={{ padding: '8px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 10, color: 'var(--amber)' }}>
                ⚠ Rows with warnings will still be imported. Hover the ⚠ icon to see details. You can edit any account after import.
              </div>
            )}

            <footer style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
              <button type="button" onClick={() => setIsImportCsvModalOpen(false)} className="billing-command-btn">Cancel</button>
              {(() => { const selected = csvParsedRows.length - csvExcluded.size; return (
                <button type="button" onClick={confirmCsvImport} className="billing-command-btn primary" disabled={selected === 0} style={selected === 0 ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
                  <Download size={13} />
                  Import {selected} account{selected === 1 ? '' : 's'}
                </button>
              ); })()}
            </footer>
          </div>
        </div>
      )}

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

              {form.firm === 'Topstep' && form.accountType === 'Trading Combine' && (
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Pricing Path</label>
                  <select className="billing-modal-field" value={form.pricingPath} onChange={e => applyTopstepPath(e.target.value as 'standard' | 'no_activation_fee')}>
                    <option value="standard">Standard · lower monthly price · $149 activation</option>
                    <option value="no_activation_fee">No Activation Fee · higher monthly price</option>
                  </select>
                </div>
              )}

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

              {form.firm === 'Topstep' && form.accountType === 'Trading Combine' && (
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Daily Loss Limit at Purchase</label>
                  <select className="billing-modal-field" value={form.dailyLossMode} onChange={e => setFormField('dailyLossMode', e.target.value as 'none' | 'purchase_fixed')}>
                    <option value="none">Not added</option>
                    <option value="purchase_fixed">Added · {formatCurrency(form.optionalDailyLossLimit ?? 0)} fixed limit</option>
                  </select>
                </div>
              )}

              {form.firm === 'Topstep' && form.accountType === 'Trading Combine' && (
                <div style={{ border: '1px solid var(--green-border)', background: 'var(--green-dim)', borderRadius: 6, padding: '11px 13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                    <strong style={{ fontSize: 11, color: 'var(--txt)' }}>Verified Topstep product</strong>
                    <span style={{ fontSize: 9, color: 'var(--green)' }}>
                      {form.ruleVerifiedAt ? `Checked ${formatDateLabel(form.ruleVerifiedAt.slice(0, 10))}` : 'Verified catalog'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, marginTop: 10 }}>
                    <div>
                      <span style={{ display: 'block', fontSize: 9, color: 'var(--txt-3)' }}>Monthly</span>
                      <strong className="billing-number-sharp" style={{ fontSize: 12 }}>
                        {formatCurrency(priceAfterResponsibleDiscount)}
                        {responsibleDiscount > 0 && <span style={{ marginLeft: 6, color: 'var(--txt-3)', fontSize: 9, textDecoration: 'line-through' }}>{formatCurrency(form.listPrice)}</span>}
                      </strong>
                    </div>
                    <div><span style={{ display: 'block', fontSize: 9, color: 'var(--txt-3)' }}>Activation</span><strong className="billing-number-sharp" style={{ fontSize: 12 }}>{form.activationFee ? formatCurrency(form.activationFee) : '$0'}</strong></div>
                    <div><span style={{ display: 'block', fontSize: 9, color: 'var(--txt-3)' }}>Fixed DLL</span><strong className="billing-number-sharp" style={{ fontSize: 12 }}>{form.dailyLossMode === 'purchase_fixed' ? formatCurrency(form.optionalDailyLossLimit ?? 0) : 'Not added'}</strong></div>
                  </div>
                  {responsibleDiscount > 0 && (
                    <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--green-border)', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ padding: '3px 7px', borderRadius: 999, background: 'rgba(34,197,94,.12)', border: '1px solid rgba(34,197,94,.28)', color: 'var(--green)', fontSize: 9, fontWeight: 600 }}>
                        Save {formatCurrency(responsibleDiscount)}/month
                      </span>
                      {form.responsibleTradingBenefit && (
                        <span style={{ padding: '3px 7px', borderRadius: 999, background: 'rgba(34,197,94,.12)', border: '1px solid rgba(34,197,94,.28)', color: 'var(--green)', fontSize: 9, fontWeight: 600 }}>
                          Double payout caps
                        </span>
                      )}
                    </div>
                  )}
                  {form.ruleSourceUrl && (
                    <a href={form.ruleSourceUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 9, color: '#60a5fa', fontSize: 9, textDecoration: 'none' }}>
                      Open official Topstep rules
                    </a>
                  )}
                </div>
              )}

              {/* Price paid — the single amount the trader actually paid. */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--txt-2)', marginBottom: 6 }}>Price paid</label>
                <div style={{ position: 'relative' }}>
                  <span aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--txt-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>$</span>
                  <input className="billing-modal-field billing-number-sharp" type="number" min={0} step="0.01" value={Number.isFinite(form.listPrice) ? form.listPrice : 0} onChange={e => setFormField('listPrice', Math.max(0, toNumber(e.target.value, 0)))} style={{ textAlign: 'right', paddingLeft: 28 }} />
                </div>
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
                  {SELECTABLE_STATUS_OPTIONS.map(status => (
                    <button
                      key={status}
                      type="button"
                      className={`billing-status-toggle${form.status === status ? ' is-active' : ''}`}
                      // Purely organisational: set the tag and nothing else — the
                      // price paid and every other field are left exactly as they are.
                      onClick={() => setFormField('status', status)}
                      style={form.status === status ? { ...getStatusBadgeStyle(status), height: 32, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none' } : undefined}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>

              {/* Payouts (Passed only) */}
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
