// Funded-stage payout paths for every prop firm Flyxa tracks.
//
// A "path" is a distinct funded/payout ruleset. For most firms the path is the
// funded plan/account-type the trader bought (Tradeify program, Lucid plan,
// FundedNext model, MyFundedFutures plan, Alpha type, Apex drawdown-era); the
// trader picks it when the account is moved to funded. Topstep is the exception:
// it lets a trader choose Standard vs Consistency per payout cycle on one funded
// account. Take Profit Trader has a single path, so no choice is prompted.
//
// Numbers are from each firm's official help center (2026). Only the fields that
// GATE a payout (winning days, min trading days, consistency, safety-net buffer,
// per-cycle profit goal) are modelled here — those drive the readiness view.
// Per-payout dollar caps and exact split tiers live in `note` as context, not as
// gating logic. Verify against the firm dashboard before acting (see disclaimer).

/** A minimum dollar figure that either is flat or varies by account size. The
 *  keys are account sizes as plain numbers (25000, 50000, …). */
export type BySize = Record<number, number>;

export interface PayoutRequirementSpec {
  /** N winning days, each ≥ `winningDayMin`, required per payout cycle. */
  winningDays?: { count: number; min: number | BySize };
  /** Minimum number of trading days (with ≥1 trade) per cycle. */
  minTradingDays?: number;
  /** Largest single day must be ≤ this % of total profit. Omit = no rule. */
  consistencyPct?: number;
  /** A safety-net buffer applies: only profit above (drawdown + `bufferPlus`)
   *  is withdrawable. Modelled as "positive withdrawable profit + intact
   *  buffer" in the readiness engine. */
  buffer?: { plus: number };
  /** Minimum net profit required in the cycle before a payout unlocks. */
  profitGoal?: number | BySize;
}

export interface FundedPath extends PayoutRequirementSpec {
  /** Stable id, e.g. 'topstep-standard'. Stored on the account. */
  id: string;
  /** Display name shown in the picker and readiness header. */
  name: string;
  /** One-line description for the path picker. */
  blurb: string;
  /** Trader's profit split, 0–1 (0.9 = 90%). Context only. */
  profitSplit?: number;
  /** Short human note about payout caps / cadence. Context only. */
  note?: string;
  /** Official source URL for this path's rules. */
  sourceUrl?: string;
  /** True for legacy/older account eras kept for reference. */
  legacy?: boolean;
}

export interface FirmPayoutPaths {
  /** Firm key; matched case-insensitively against account.firm. */
  firm: string;
  /** Aliases that also match this firm. */
  aliases?: string[];
  paths: FundedPath[];
  /** Topstep-style per-cycle switching: the trader may change path between
   *  payouts on the same funded account, so the readiness view offers a live
   *  switch rather than locking to the choice made at funding. */
  switchablePerCycle?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

const FIRMS: FirmPayoutPaths[] = [
  {
    firm: 'Topstep',
    switchablePerCycle: true,
    paths: [
      {
        id: 'topstep-standard',
        name: 'Standard',
        blurb: '5 winning days of $150+, no consistency rule.',
        winningDays: { count: 5, min: 150 },
        profitGoal: 0.01,
        profitSplit: 0.9,
        note: 'Payout up to 50% of balance, cap $2,000–$5,000 by size. Positive net profit since last payout.',
        sourceUrl: 'https://help.topstep.com/en/articles/8284233-topstep-payout-policy',
      },
      {
        id: 'topstep-consistency',
        name: 'Consistency',
        blurb: '3 trading days and a 40% consistency target.',
        minTradingDays: 3,
        consistencyPct: 40,
        profitSplit: 0.9,
        note: 'Payout up to 50% of balance, cap $3,000–$6,000 by size. Largest day ≤ 40% of total profit.',
        sourceUrl: 'https://help.topstep.com/en/articles/8284208-consistency-at-topstep',
      },
    ],
  },
  {
    firm: 'Tradeify',
    paths: [
      {
        id: 'tradeify-growth',
        name: 'Growth Funded',
        blurb: '5 winning days, 35% consistency.',
        winningDays: { count: 5, min: { 25000: 100, 50000: 150, 100000: 200, 150000: 250 } },
        consistencyPct: 35,
        profitSplit: 0.9,
        note: 'Per-payout caps rise with each successful payout. Buffer required to qualify.',
        sourceUrl: 'https://help.tradeify.co/en/articles/11083796-growth-funded-account-payout-policy',
      },
      {
        id: 'tradeify-lightning',
        name: 'Lightning Funded',
        blurb: 'No winning-day count; gradual consistency 20→30% + profit goal.',
        consistencyPct: 30,
        profitGoal: { 25000: 1500, 50000: 3000, 100000: 6000, 150000: 9000 },
        profitSplit: 0.9,
        note: 'Consistency tightens per payout (20% → 25% → 30%). Profit goal resets each cycle; first-payout goal shown.',
        sourceUrl: 'https://help.tradeify.co/en/articles/10495932-lightning-funded-account-payout-policy',
      },
      {
        id: 'tradeify-select-flex',
        name: 'Select Flex',
        blurb: '5 winning days, no consistency rule.',
        winningDays: { count: 5, min: { 25000: 100, 50000: 150, 100000: 200, 150000: 250 } },
        profitSplit: 0.9,
        note: 'Payout up to 50% of profit, cap $1,250–$5,000. Positive net from the 2nd payout on.',
        sourceUrl: 'https://help.tradeify.co/en/articles/12853966-select-flex-and-select-daily-payout-policies',
      },
      {
        id: 'tradeify-select-daily',
        name: 'Select Daily',
        blurb: 'Daily payouts above a buffer, no consistency rule.',
        buffer: { plus: 100 },
        profitGoal: 0.01,
        profitSplit: 0.9,
        note: 'Buffer $1,100–$3,600 by size. Up to 2× profit since last payout, capped $600–$2,500.',
        sourceUrl: 'https://help.tradeify.co/en/articles/12853966-select-flex-and-select-daily-payout-policies',
      },
    ],
  },
  {
    firm: 'Lucid',
    aliases: ['Lucid Trading'],
    paths: [
      {
        id: 'lucid-flex',
        name: 'LucidFlex',
        blurb: '5 winning days, no consistency rule.',
        winningDays: { count: 5, min: { 25000: 100, 50000: 150, 100000: 200, 150000: 250 } },
        profitGoal: 0.01,
        profitSplit: 0.9,
        note: 'Payout 50% of profit, cap $1,000–$3,000. No buffer. Up to 5 payouts, then live.',
        sourceUrl: 'https://support.lucidtrading.com/en/articles/12945796-lucidflex-payouts',
      },
      {
        id: 'lucid-pro',
        name: 'LucidPro',
        blurb: '40% consistency + per-cycle profit goal, above a buffer.',
        consistencyPct: 40,
        buffer: { plus: 100 },
        profitGoal: { 25000: 250, 50000: 500, 100000: 750, 150000: 1000 },
        profitSplit: 0.9,
        note: 'Largest day ≤ 40% of cycle profit. Profits must exceed buffer (drawdown + $100).',
        sourceUrl: 'https://support.lucidtrading.com/en/articles/12890092-lucidpro-payouts',
      },
      {
        id: 'lucid-direct',
        name: 'LucidDirect',
        blurb: '20% consistency + per-cycle profit goal.',
        consistencyPct: 20,
        profitGoal: { 25000: 1500, 50000: 3000, 100000: 6000, 150000: 9000 },
        profitSplit: 0.9,
        note: 'Strict 20% consistency. First-payout profit goal shown; lower thereafter.',
        sourceUrl: 'https://support.lucidtrading.com/en/articles/12890164-luciddirect-payout-objectives',
      },
      {
        id: 'lucid-daily',
        name: 'LucidDaily',
        blurb: 'Daily payouts above a buffer, no consistency rule.',
        buffer: { plus: 100 },
        profitGoal: 0.01,
        profitSplit: 0.9,
        note: 'Withdraw all profit above buffer (drawdown + $100). Max daily profit auto-moves you live.',
        sourceUrl: 'https://support.lucidtrading.com/en/articles/15997266-luciddaily-payouts',
      },
      {
        id: 'lucid-black',
        name: 'LucidBlack',
        blurb: 'Legacy plan: 40% consistency + profit goal.',
        legacy: true,
        consistencyPct: 40,
        profitGoal: { 25000: 1500, 50000: 3000, 100000: 4500 },
        profitSplit: 0.9,
        note: 'Legacy. Largest day ≤ 40% of cycle profit. Optional bonus goal on payouts 2–4.',
        sourceUrl: 'https://support.lucidtrading.com/en/articles/13424897-lucidblack-payout-objectives',
      },
    ],
  },
  {
    firm: 'FundedNext',
    paths: [
      {
        id: 'fundednext-legacy',
        name: 'Legacy',
        blurb: '5 benchmark days, no consistency rule.',
        winningDays: { count: 5, min: { 25000: 100, 50000: 200, 100000: 200 } },
        profitGoal: 500,
        profitSplit: 0.8,
        note: 'Benchmark day = min profit for size. $500 profit after last withdrawal. 80% split.',
        sourceUrl: 'https://helpfutures.fundednext.com/en/articles/14282529-what-are-the-performance-reward-eligibility-criteria-for-legacy-fundednext-account',
      },
      {
        id: 'fundednext-rapid',
        name: 'Rapid',
        blurb: 'No day count; 40% consistency.',
        consistencyPct: 40,
        profitGoal: { 25000: 250, 50000: 250, 100000: 500 },
        profitSplit: 0.8,
        note: 'Daily profit ≤ 40% of total account profit. Cap $800–$2,500 until 5 rewards.',
        sourceUrl: 'https://helpfutures.fundednext.com/en/articles/14283389-what-are-the-performance-reward-eligibility-criteria-for-rapid-fundednext-account',
      },
      {
        id: 'fundednext-rapid-pro',
        name: 'Rapid Pro',
        blurb: 'Reward every 3 days; 40% consistency.',
        consistencyPct: 40,
        profitGoal: 500,
        profitSplit: 0.9,
        note: '90% split. $500 profit in the cycle. Concludes after the 5th reward.',
        sourceUrl: 'https://helpfutures.fundednext.com/en/articles/15877643-what-is-fundednext-futures-rapid-pro-daily-challenge',
      },
      {
        id: 'fundednext-rapid-daily',
        name: 'Rapid Daily',
        blurb: 'Daily payouts above a buffer, no consistency rule.',
        buffer: { plus: 100 },
        profitGoal: 500,
        profitSplit: 0.9,
        note: '90% split. EOD balance must clear buffer (start + max loss + $100). $500 profit per cycle.',
        sourceUrl: 'https://helpfutures.fundednext.com/en/articles/15878210-what-are-the-performance-reward-eligibility-criteria-for-fundednext-futures-rapid-daily-fundednext-account',
      },
      {
        id: 'fundednext-flex',
        name: 'Flex',
        blurb: '5 benchmark days, no consistency on the funded account.',
        winningDays: { count: 5, min: { 50000: 200, 100000: 200, 150000: 250 } },
        profitGoal: 500,
        profitSplit: 0.95,
        note: 'Up to 95% split. 50% of profit, cap $1,500–$4,000. Consistency applies only in the challenge.',
        sourceUrl: 'https://helpfutures.fundednext.com/en/articles/14878865-what-are-the-performance-reward-eligibility-criteria-for-flex-fundednext-account',
      },
      {
        id: 'fundednext-bolt',
        name: 'Bolt',
        blurb: 'No day count; withdraw above a buffer.',
        buffer: { plus: 100 },
        profitGoal: 250,
        profitSplit: 0.8,
        note: '80% split. Withdraw when EOD balance is above buffer. $250 profit per cycle.',
        sourceUrl: 'https://helpfutures.fundednext.com/en/articles/14282044-what-are-the-performance-reward-eligibility-criteria-for-bolt-fundednext-account',
      },
    ],
  },
  {
    firm: 'Take Profit Trader',
    aliases: ['TakeProfitTrader', 'TPT'],
    paths: [
      {
        id: 'tpt-pro',
        name: 'PRO',
        blurb: 'Withdraw any profit above the safety net. No winning-day or consistency rule.',
        buffer: { plus: 0 },
        profitGoal: 0.01,
        profitSplit: 0.8,
        note: 'Safety net = max trailing drawdown. Withdraw above it daily, no cap. 80% split (PRO+ upgrade is 90%).',
        sourceUrl: 'https://takeprofittraderhelp.zendesk.com/hc/en-us/articles/15172219527581-PRO-Account-Profit-Split-Withdrawal-Rules',
      },
    ],
  },
  {
    firm: 'Alpha Futures',
    aliases: ['AlphaFutures'],
    paths: [
      {
        id: 'alpha-standard',
        name: 'Standard Qualified',
        blurb: '5 winning days of $200+, 40% consistency.',
        winningDays: { count: 5, min: 200 },
        consistencyPct: 40,
        profitSplit: 0.9,
        note: '90% split, up to 4 payouts/month. Withdraw up to 50% of profit, cap $3,000–$5,000.',
        sourceUrl: 'https://help.alpha-futures.com/en/articles/9492051-payout-policy',
      },
      {
        id: 'alpha-advanced',
        name: 'Advanced Qualified',
        blurb: '5 winning days of $200+, no consistency rule.',
        winningDays: { count: 5, min: 200 },
        profitSplit: 0.9,
        note: '90% split. No consistency rule. Up to $15,000 per request.',
        sourceUrl: 'https://help.alpha-futures.com/en/articles/11634907-advanced-account-overview',
      },
      {
        id: 'alpha-zero',
        name: 'Zero Qualified',
        blurb: '5 winning days of $200+, 40% consistency.',
        winningDays: { count: 5, min: 200 },
        consistencyPct: 40,
        profitSplit: 0.9,
        note: '90% split. Cap $1,000–$2,500 by size. Min withdrawal $200.',
        sourceUrl: 'https://help.alpha-futures.com/en/articles/9492051-payout-policy',
      },
      {
        id: 'alpha-direct',
        name: 'Direct Qualified',
        blurb: '5 winning days of $200+, strict 20% consistency + profit target.',
        winningDays: { count: 5, min: 200 },
        consistencyPct: 20,
        profitGoal: { 25000: 1500, 50000: 3000, 100000: 6000, 150000: 9000 },
        profitSplit: 0.9,
        note: '90% split. 20% consistency. Per-cycle withdrawal profit target; leftover does not carry.',
        sourceUrl: 'https://help.alpha-futures.com/en/articles/9492051-payout-policy',
      },
    ],
  },
  {
    firm: 'MyFundedFutures',
    aliases: ['My Funded Futures', 'MFFU'],
    paths: [
      {
        id: 'mffu-rapid',
        name: 'Rapid',
        blurb: 'Daily payouts above a buffer, no consistency rule.',
        buffer: { plus: 100 },
        profitGoal: 0.01,
        profitSplit: 0.9,
        note: '90% split. Buffer ~$1,100–$4,600 by size. Daily payouts, $500 minimum.',
        sourceUrl: 'https://help.myfundedfutures.com/en/articles/13745661-payout-policy-overview-best-and-fastest-prop-firm-payouts',
      },
      {
        id: 'mffu-builder',
        name: 'Builder',
        blurb: '2 winning days, 50% consistency (sim stage).',
        winningDays: { count: 2, min: 0.01 },
        consistencyPct: 50,
        profitGoal: 500,
        profitSplit: 0.8,
        note: '80% split. Largest day ≤ 50% of cycle profit. $500 above buffer for the first payout.',
        sourceUrl: 'https://help.myfundedfutures.com/en/articles/14290805-builder-plan-50k-a-comprehensive-guide',
      },
      {
        id: 'mffu-flex',
        name: 'Flex',
        blurb: '5 winning days, no consistency on the funded account.',
        winningDays: { count: 5, min: { 25000: 100, 50000: 150 } },
        profitGoal: 500,
        profitSplit: 0.8,
        note: '80% split. $500 net between payouts. 50% of profit, cap $3,000–$5,000.',
        sourceUrl: 'https://help.myfundedfutures.com/en/articles/13521620-flex-plan-the-path-forward-legacy',
      },
      {
        id: 'mffu-pro',
        name: 'Pro',
        blurb: 'No winning-day count; clear a buffer, payout every 14 days.',
        buffer: { plus: 100 },
        profitGoal: 0.01,
        profitSplit: 0.8,
        note: '80% split. Eligibility opens 14 days after first trade. No payout-stage consistency rule.',
        sourceUrl: 'https://help.myfundedfutures.com/en/articles/11802674-pro-plan-sim-funded-and-live-account-highlights',
      },
    ],
  },
  {
    firm: 'Apex',
    aliases: ['Apex Trader Funding'],
    paths: [
      {
        id: 'apex-eod',
        name: 'EOD Trailing',
        blurb: '5 winning days, 50% consistency, above a permanent safety net.',
        winningDays: { count: 5, min: { 25000: 100, 50000: 250, 100000: 300, 150000: 350 } },
        consistencyPct: 50,
        buffer: { plus: 100 },
        profitSplit: 1,
        note: '100% split. Safety net = drawdown + $100 for the life of the account. Max 6 payouts.',
        sourceUrl: 'https://apextraderfunding.com/help-center/eod-trailing-drawdown-accounts/eod-payouts/',
      },
      {
        id: 'apex-intraday',
        name: 'Intraday Trailing',
        blurb: '5 winning days, 50% consistency, above a permanent safety net.',
        winningDays: { count: 5, min: { 25000: 100, 50000: 200, 100000: 250, 150000: 300 } },
        consistencyPct: 50,
        buffer: { plus: 100 },
        profitSplit: 1,
        note: '100% split. Safety net = drawdown + $100 for the life of the account. Max 6 payouts.',
        sourceUrl: 'https://apextraderfunding.com/help-center/intraday-trailing-drawdown-accounts/intraday-trailing-drawdown-payouts/',
      },
      {
        id: 'apex-legacy',
        name: 'Legacy PA',
        blurb: 'Legacy: 8 trading days (5 of them $50+), 30% consistency.',
        legacy: true,
        winningDays: { count: 5, min: 50 },
        minTradingDays: 8,
        consistencyPct: 30,
        buffer: { plus: 100 },
        profitSplit: 1,
        note: 'Legacy. 100% on the first $25k, 90% above. Safety net for the first 3 payouts only.',
        sourceUrl: 'https://apextraderfunding.com/help-center/legacy-payouts/legacy-pa-payout-parameters/',
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Firm payout config for an account's firm string, or null if not tracked. */
export function getFirmPayoutPaths(firm: string | undefined | null): FirmPayoutPaths | null {
  if (!firm) return null;
  const target = norm(firm);
  for (const entry of FIRMS) {
    if (norm(entry.firm) === target) return entry;
    if (entry.aliases?.some(a => norm(a) === target)) return entry;
    // Loose contains match (e.g. "Topstep Funded August" → Topstep).
    if (target.includes(norm(entry.firm))) return entry;
  }
  return null;
}

/** All paths a firm offers (empty if firm not tracked). */
export function getPaths(firm: string | undefined | null): FundedPath[] {
  return getFirmPayoutPaths(firm)?.paths ?? [];
}

/** Look up a specific path by id within a firm. */
export function getPathById(firm: string | undefined | null, id: string | undefined | null): FundedPath | null {
  if (!id) return null;
  return getPaths(firm).find(p => p.id === id) ?? null;
}

/** Resolve a size-keyed value to the figure for the given account size, using
 *  the nearest defined size at or below it, else the smallest defined. */
export function resolveBySize(value: number | BySize, size: number): number {
  if (typeof value === 'number') return value;
  const sizes = Object.keys(value).map(Number).sort((a, b) => a - b);
  if (sizes.length === 0) return 0;
  let pick = sizes[0];
  for (const s of sizes) { if (size >= s) pick = s; }
  return value[pick];
}
