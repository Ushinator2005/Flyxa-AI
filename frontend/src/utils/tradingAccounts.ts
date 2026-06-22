import type { TradingAccount, TradingAccountStatus, TradingAccountType } from '../types/index.js';

export const ALL_ACCOUNTS_ID = 'all';
export const DEFAULT_ACCOUNT_ID = 'default-account';

export const DEFAULT_TRADING_ACCOUNT: TradingAccount = {
  id: DEFAULT_ACCOUNT_ID,
  name: 'Default Account',
  broker: '',
  type: 'Futures',
  status: 'Live',
  color: '#3b82f6',
  createdAt: new Date(0).toISOString(),
};

export function normalizeAccountStatus(
  status: unknown,
  fallbackStatus: TradingAccountStatus = 'Eval'
): TradingAccountStatus {
  return status === 'Eval' || status === 'Funded' || status === 'Live' || status === 'Passed' || status === 'Blown'
    ? status
    : fallbackStatus;
}

export function normalizeAccountType(type: unknown, fallbackType: TradingAccountType = 'Futures'): TradingAccountType {
  return type === 'Futures' || type === 'Forex' || type === 'Stocks'
    ? type
    : fallbackType;
}

export function ensureDefaultAccount(accounts: TradingAccount[]): TradingAccount[] {
  const normalizedAccounts = accounts.map(account => ({
    id: account.id,
    name: account.name,
    broker: account.broker,
    type: normalizeAccountType(account.type),
    status: normalizeAccountStatus(
      account.status,
      account.id === DEFAULT_ACCOUNT_ID ? DEFAULT_TRADING_ACCOUNT.status : 'Eval'
    ),
    color: account.color,
    createdAt: account.createdAt,
    ...(account.startingBalance !== undefined ? { startingBalance: account.startingBalance } : {}),
    ...(account.targetBalance !== undefined ? { targetBalance: account.targetBalance } : {}),
    ...(account.archived === true ? { archived: true } : {}),
    ...(account.isDefault === true ? { isDefault: true } : {}),
    ...(account.firmRuleVersionId !== undefined ? { firmRuleVersionId: account.firmRuleVersionId } : {}),
    ...(account.evaluationProgram !== undefined ? { evaluationProgram: account.evaluationProgram } : {}),
    ...(account.evaluationPath !== undefined ? { evaluationPath: account.evaluationPath } : {}),
    ...(account.dailyLossMode !== undefined ? { dailyLossMode: account.dailyLossMode } : {}),
    ...(account.dailyLossLimit !== undefined ? { dailyLossLimit: account.dailyLossLimit } : {}),
    ...(account.maxDrawdown !== undefined ? { maxDrawdown: account.maxDrawdown } : {}),
    ...(account.profitTarget !== undefined ? { profitTarget: account.profitTarget } : {}),
    ...(account.minimumTradingDays !== undefined ? { minimumTradingDays: account.minimumTradingDays } : {}),
    ...(account.maxContracts !== undefined ? { maxContracts: account.maxContracts } : {}),
    ...(account.maxMicros !== undefined ? { maxMicros: account.maxMicros } : {}),
    ...(account.consistencyLimitPct !== undefined ? { consistencyLimitPct: account.consistencyLimitPct } : {}),
    ...(account.drawdownType !== undefined ? { drawdownType: account.drawdownType } : {}),
    ...(account.ruleVerifiedAt !== undefined ? { ruleVerifiedAt: account.ruleVerifiedAt } : {}),
    ...(account.ruleSourceUrl !== undefined ? { ruleSourceUrl: account.ruleSourceUrl } : {}),
  }));

  const withoutDuplicates = normalizedAccounts.filter((account, index, collection) => (
    collection.findIndex(candidate => candidate.id === account.id) === index
  ));

  if (withoutDuplicates.some(account => account.id === DEFAULT_ACCOUNT_ID)) {
    return withoutDuplicates;
  }

  return [DEFAULT_TRADING_ACCOUNT, ...withoutDuplicates];
}

export function getAccountCreatedAtMs(account: TradingAccount): number {
  const parsed = Date.parse(account.createdAt);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

export function resolveDefaultTradeAccountId(accounts: TradingAccount[]): string {
  const isInactive = (s: TradingAccountStatus) => s === 'Blown' || s === 'Passed';

  // Manually pinned default takes priority
  const manualDefault = accounts.find(account =>
    account.isDefault === true &&
    account.id !== DEFAULT_ACCOUNT_ID &&
    !isInactive(account.status)
  );
  if (manualDefault) return manualDefault.id;

  const oldestRealAccount = accounts
    .filter(account => account.id !== DEFAULT_ACCOUNT_ID && !isInactive(account.status))
    .sort((a, b) => getAccountCreatedAtMs(a) - getAccountCreatedAtMs(b))[0];

  if (oldestRealAccount) return oldestRealAccount.id;

  const builtInDefault = accounts.find(account => account.id === DEFAULT_ACCOUNT_ID && !isInactive(account.status));
  return builtInDefault?.id ?? accounts.find(account => !isInactive(account.status))?.id ?? DEFAULT_ACCOUNT_ID;
}
