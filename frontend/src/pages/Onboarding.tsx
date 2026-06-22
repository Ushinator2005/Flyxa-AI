import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ProfitabilityStatus, useOnboarding } from '../contexts/OnboardingContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { getEvaluationTemplates } from '../utils/evaluationCoach.js';

type ConversationStep = 'boot' | 'goal' | 'trader' | 'rules' | 'summary' | 'account-setup' | 'done';
type AccountKind = 'eval' | 'live' | 'paper';
type Sender = 'flyxa' | 'user';

interface ChatMessage {
  id: string;
  sender: Sender;
  text: string;
}

const GOAL_OPTIONS = [
  'Stop overtrading',
  'Become consistently profitable',
  'Improve discipline',
  'Refine my strategy',
  'Track performance properly',
  'Other',
] as const;

const TRADER_OPTIONS: Array<{ label: string; value: ProfitabilityStatus }> = [
  { label: 'Beginner (not profitable yet)', value: 'not_profitable' },
  { label: 'Breakeven', value: 'breakeven' },
  { label: 'Consistently profitable', value: 'profitable' },
];

const RULE_OPTIONS = [
  'I only take planned trades',
  'I respect my stop loss',
  "I don't revenge trade",
  'I stop after 2 losses',
  'I follow my trading plan strictly',
];

const FINAL_BULLETS = [
  'Eliminate emotional trades',
  'Track your edge',
  'Build consistency',
  'Improve discipline',
];

const GOAL_RESPONSE: Record<string, string> = {
  'Stop overtrading': "Got it - we'll help you reduce impulsive trades and focus on higher quality decisions.",
  'Become consistently profitable': "Perfect - we'll focus on building repeatable execution and consistency.",
  'Improve discipline': "Great target - we'll tighten your process and reduce rule breaks.",
  'Refine my strategy': "Love that - we'll expose what works and what should be removed from your plan.",
  'Track performance properly': "Excellent - we'll structure your journal so your edge is measurable.",
};

const TRADER_RESPONSE: Record<ProfitabilityStatus, string> = {
  not_profitable: "Thanks for the honesty. We'll help you build a strong foundation and avoid common traps.",
  breakeven: "Nice position to be in. We'll focus on small process upgrades that push you into profitability.",
  profitable: "Strong baseline. We'll optimize consistency, risk control, and performance durability.",
};

function delay(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function typingDelay() {
  return 300 + Math.floor(Math.random() * 500);
}

function ChatContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex h-[calc(100vh-96px)] max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-800 bg-[linear-gradient(180deg,#050912,#020612)] shadow-[0_24px_90px_rgba(2,132,199,0.16)]">
      {children}
    </div>
  );
}

function FlyxaMessageBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[78%] rounded-2xl rounded-bl-md border border-cyan-500/30 bg-[#071224] px-4 py-3 text-sm leading-relaxed text-slate-100 shadow-[0_0_0_1px_rgba(6,182,212,0.08)] animate-fade-in">
      {text}
    </div>
  );
}

function UserSelectedBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md border border-cyan-400/45 bg-cyan-500/18 px-4 py-2.5 text-sm font-medium text-cyan-100 animate-fade-in">
      {text}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="inline-flex w-fit items-center gap-1.5 rounded-2xl rounded-bl-md border border-cyan-500/25 bg-[#071224] px-3 py-2 text-cyan-200/80 animate-fade-in">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300/80" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300/70 [animation-delay:120ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300/60 [animation-delay:240ms]" />
    </div>
  );
}

interface OptionBubbleGroupProps {
  options: string[];
  selected: string[];
  disabled?: boolean;
  lockedSingle?: string | null;
  onSelect: (value: string) => void;
  continueLabel?: string;
  onContinue?: () => void;
}

function OptionBubbleGroup({
  options,
  selected,
  disabled,
  lockedSingle,
  onSelect,
  continueLabel,
  onContinue,
}: OptionBubbleGroupProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-center gap-2">
        {options.map(option => {
          const isSelected = selected.includes(option);
          const faded = lockedSingle && lockedSingle !== option;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(option)}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition-all duration-200 ${
                isSelected
                  ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.22)]'
                  : 'border-slate-700 bg-slate-900/75 text-slate-300 hover:scale-[1.03] hover:border-cyan-500/50 hover:text-white'
              } ${faded ? 'opacity-20 blur-[0.2px]' : 'opacity-100'} ${disabled ? 'cursor-not-allowed' : ''}`}
            >
              {option}
            </button>
          );
        })}
      </div>

      {onContinue && continueLabel && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onContinue}
            disabled={disabled}
            className="rounded-full border border-cyan-400/70 bg-cyan-500/18 px-4 py-2 text-sm font-semibold text-cyan-100 transition-all hover:scale-[1.03] hover:bg-cyan-500/24 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {continueLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Onboarding() {
  const navigate = useNavigate();
  const { completeOnboarding, saveSurvey } = useOnboarding();
  const addAccount = useFlyxaStore(state => state.addAccount);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [step, setStep] = useState<ConversationStep>('boot');
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lockedSingle, setLockedSingle] = useState<string | null>(null);
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherGoalText, setOtherGoalText] = useState('');
  const [selectedGoal, setSelectedGoal] = useState('');
  const [selectedTrader, setSelectedTrader] = useState<ProfitabilityStatus | null>(null);
  const [selectedRules, setSelectedRules] = useState<string[]>([]);
  const [accountKind, setAccountKind] = useState<AccountKind>('eval');
  const [accountFirm, setAccountFirm] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountSize, setAccountSize] = useState(50000);
  const [evaluationPath, setEvaluationPath] = useState<'standard' | 'no_activation_fee'>('no_activation_fee');
  const [dailyLossMode, setDailyLossMode] = useState<'none' | 'purchase_fixed'>('none');

  const canContinueRules = selectedRules.length > 0;

  const appendMessage = (sender: Sender, text: string) => {
    setMessages(current => [
      ...current,
      { id: `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, sender, text },
    ]);
  };

  const sendFlyxa = async (text: string) => {
    setTyping(true);
    await delay(typingDelay());
    setTyping(false);
    appendMessage('flyxa', text);
    await delay(120);
  };

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, typing, step, selectedRules.length, showOtherInput]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const start = async () => {
      await sendFlyxa("Let's build your trading foundation.");
      await sendFlyxa("What's your main goal as a trader?");
      setStep('goal');
    };

    void start();
  }, []);

  const handleGoalChoice = async (choice: string) => {
    if (busy) return;

    if (choice === 'Other') {
      setShowOtherInput(true);
      setLockedSingle('Other');
      return;
    }

    setBusy(true);
    setLockedSingle(choice);
    await delay(220);
    appendMessage('user', choice);
    setSelectedGoal(choice);
    setStep('boot');
    await sendFlyxa(GOAL_RESPONSE[choice] ?? "Great - we'll personalize your plan around that.");
    await sendFlyxa('Which trader are you right now?');
    setLockedSingle(null);
    setShowOtherInput(false);
    setStep('trader');
    setBusy(false);
  };

  const handleOtherGoalSubmit = async () => {
    if (busy) return;

    const label = otherGoalText.trim() ? `Other: ${otherGoalText.trim()}` : 'Other';
    setBusy(true);
    await delay(220);
    appendMessage('user', label);
    setSelectedGoal(label);
    setStep('boot');
    await sendFlyxa("Got it - we'll tailor your journal around that priority.");
    await sendFlyxa('Which trader are you right now?');
    setLockedSingle(null);
    setShowOtherInput(false);
    setStep('trader');
    setBusy(false);
  };

  const handleTraderChoice = async (choice: { label: string; value: ProfitabilityStatus }) => {
    if (busy) return;

    setBusy(true);
    setLockedSingle(choice.label);
    await delay(220);
    appendMessage('user', choice.label);
    setSelectedTrader(choice.value);
    setStep('boot');
    await sendFlyxa(TRADER_RESPONSE[choice.value]);
    await sendFlyxa("Let's set your foundation. Pick your trading rules.");
    setLockedSingle(null);
    setStep('rules');
    setBusy(false);
  };

  const toggleRule = (rule: string) => {
    if (busy) return;
    setSelectedRules(current => (
      current.includes(rule) ? current.filter(item => item !== rule) : [...current, rule]
    ));
  };

  const handleRulesContinue = async () => {
    if (busy || selectedRules.length === 0) return;

    setBusy(true);
    appendMessage('user', `My baseline rules: ${selectedRules.join(', ')}`);
    setStep('summary');
    await sendFlyxa("Here's what your journal will help you do:");
    for (const bullet of FINAL_BULLETS) {
      await sendFlyxa(`- ${bullet}`);
    }
    await sendFlyxa("One last step — set up your first trading account.");
    setStep('account-setup');
    setBusy(false);
  };

  const enterDashboard = () => {
    if (!selectedTrader || !selectedGoal) return;
    const payload = {
      whyJournaling: selectedGoal,
      improvementAreas: [],
      profitabilityStatus: selectedTrader,
      goldenRules: selectedRules,
    };
    saveSurvey(payload);
    completeOnboarding(payload);

    const firm = accountFirm.trim() || 'My Firm';
    const name = accountName.trim() || (firm + ' Account');
    const template = accountKind === 'eval' && firm.toLowerCase() === 'topstep'
      ? getEvaluationTemplates().find(item => item.firm === 'Topstep' && item.accountSize === accountSize && item.path === evaluationPath)
      : undefined;
    const configuredDailyLoss = dailyLossMode === 'purchase_fixed'
      ? template?.optionalDailyLossLimit ?? 0
      : template?.dailyLossLimit ?? 0;
    addAccount({
      id: crypto.randomUUID(),
      name,
      firm,
      size: accountSize,
      type: accountKind,
      phase: accountKind === 'eval' ? 'eval' : 'funded',
      balance: accountSize,
      startingBalance: accountSize,
      dailyLossLimit: configuredDailyLoss,
      maxDrawdown: template?.maxDrawdown ?? 0,
      profitTarget: template?.profitTarget ?? null,
      minimumTradingDays: template?.minimumTradingDays,
      maxContracts: template?.maxContracts,
      consistencyLimitPct: template?.consistencyLimitPct,
      drawdownType: template?.drawdownType,
      evaluationTemplateId: template?.id,
      firmRuleVersionId: template?.id,
      evaluationPath: template?.path === 'no_activation_fee' ? 'no_activation_fee' : template ? 'standard' : undefined,
      dailyLossMode: template ? dailyLossMode : undefined,
      isActive: true,
    });

    navigate('/', { replace: true });
  };

  const optionBlock = useMemo(() => {
    if (step === 'goal') {
      return (
        <div className="space-y-3">
          <OptionBubbleGroup
            options={[...GOAL_OPTIONS]}
            selected={lockedSingle ? [lockedSingle] : []}
            disabled={busy}
            lockedSingle={lockedSingle}
            onSelect={handleGoalChoice}
          />
          {showOtherInput && (
            <div className="mx-auto max-w-xl rounded-2xl border border-slate-700 bg-slate-900/85 p-3">
              <label className="mb-2 block text-xs font-medium uppercase tracking-[0.12em] text-slate-400">Optional detail</label>
              <input
                className="input-field"
                value={otherGoalText}
                onChange={event => setOtherGoalText(event.target.value)}
                placeholder="What goal should we optimize for?"
              />
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={handleOtherGoalSubmit}
                  disabled={busy}
                  className="rounded-full border border-cyan-400/70 bg-cyan-500/18 px-4 py-2 text-sm font-semibold text-cyan-100 transition-all hover:scale-[1.03] hover:bg-cyan-500/24 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Use this answer
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (step === 'trader') {
      return (
        <OptionBubbleGroup
          options={TRADER_OPTIONS.map(option => option.label)}
          selected={lockedSingle ? [lockedSingle] : []}
          disabled={busy}
          lockedSingle={lockedSingle}
          onSelect={value => {
            const matched = TRADER_OPTIONS.find(option => option.label === value);
            if (!matched) return;
            void handleTraderChoice(matched);
          }}
        />
      );
    }

    if (step === 'rules') {
      return (
        <OptionBubbleGroup
          options={RULE_OPTIONS}
          selected={selectedRules}
          disabled={busy}
          onSelect={toggleRule}
          continueLabel={canContinueRules ? 'Continue' : undefined}
          onContinue={canContinueRules ? handleRulesContinue : undefined}
        />
      );
    }

    if (step === 'account-setup') {
      const sizes = [25000, 50000, 100000, 150000, 200000];
      const kindOptions: Array<{ label: string; value: AccountKind }> = [
        { label: 'Evaluation', value: 'eval' },
        { label: 'Live / Funded', value: 'live' },
        { label: 'Paper', value: 'paper' },
      ];
      return (
        <div className="mx-auto max-w-xl rounded-2xl border border-slate-700 bg-slate-900/85 p-4 space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Account type</p>
            <div className="flex flex-wrap gap-2">
              {kindOptions.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAccountKind(opt.value)}
                  className={`rounded-full border px-4 py-1.5 text-xs font-medium transition-all ${
                    accountKind === opt.value
                      ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-100'
                      : 'border-slate-700 bg-slate-900/75 text-slate-300 hover:border-cyan-500/50'
                  }`}
                >{opt.label}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Firm name</label>
              <select
                className="input-field"
                value={accountFirm}
                onChange={e => {
                  setAccountFirm(e.target.value);
                  if (e.target.value === 'Topstep') {
                    setAccountKind('eval');
                    setAccountSize(50000);
                  }
                }}
              >
                <option value="">Select firm</option>
                <option value="Topstep">Topstep</option>
                <option value="Apex Trader Funding">Apex Trader Funding</option>
                <option value="MyFundedFutures">MyFundedFutures</option>
                <option value="FTMO">FTMO</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Account name</label>
              <input
                className="input-field"
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                placeholder="e.g. Phase 1"
              />
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Account size</p>
            <div className="flex flex-wrap gap-2">
              {sizes.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setAccountSize(s)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                    accountSize === s
                      ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-100'
                      : 'border-slate-700 bg-slate-900/75 text-slate-300 hover:border-cyan-500/50'
                  }`}
                >${(s / 1000).toFixed(0)}K</button>
              ))}
            </div>
          </div>
          {accountFirm === 'Topstep' && accountKind === 'eval' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Pricing path</label>
                <select className="input-field" value={evaluationPath} onChange={e => setEvaluationPath(e.target.value as 'standard' | 'no_activation_fee')}>
                  <option value="standard">Standard · $149 activation</option>
                  <option value="no_activation_fee">No Activation Fee</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Daily loss protection</label>
                <select className="input-field" value={dailyLossMode} onChange={e => setDailyLossMode(e.target.value as 'none' | 'purchase_fixed')}>
                  <option value="none">Not added</option>
                  <option value="purchase_fixed">Fixed limit added at purchase</option>
                </select>
              </div>
            </div>
          )}
          {accountFirm === 'Topstep' && accountKind === 'eval' && (() => {
            const template = getEvaluationTemplates().find(item => item.firm === 'Topstep' && item.accountSize === accountSize && item.path === evaluationPath);
            if (!template) return null;
            return (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] leading-5 text-slate-300">
                <strong className="text-emerald-300">Verified Topstep rules:</strong>{' '}
                ${template.profitTarget.toLocaleString()} target, ${template.maxDrawdown.toLocaleString()} trailing MLL,
                {' '}{template.maxContracts} contracts, {template.consistencyLimitPct}% consistency, minimum {template.minimumTradingDays} days.
                {dailyLossMode === 'purchase_fixed' ? ` Fixed $${template.optionalDailyLossLimit?.toLocaleString()} daily loss limit enabled.` : ''}
              </div>
            );
          })()}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => setStep('done')}
              className="inline-flex items-center gap-2 rounded-full border border-cyan-400/70 bg-cyan-500/20 px-5 py-2 text-sm font-semibold text-cyan-100 transition-all hover:scale-[1.02] hover:bg-cyan-500/26"
            >
              Create account <ChevronRight size={13} />
            </button>
          </div>
        </div>
      );
    }

    return null;
  }, [accountFirm, accountKind, accountName, accountSize, busy, canContinueRules, dailyLossMode, evaluationPath, lockedSingle, otherGoalText, selectedRules, showOtherInput, step]);

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#020617,#020a15)] px-4 py-8">
      <ChatContainer>
        <div className="border-b border-slate-800 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">Flyxa Coach</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-100">Onboarding Conversation</h1>
          <p className="mt-1 text-sm text-slate-400">Answer with bubbles and Flyxa will configure your journal.</p>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-3">
            {messages.map(message => (
              <div key={message.id} className={message.sender === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                {message.sender === 'flyxa' ? (
                  <FlyxaMessageBubble text={message.text} />
                ) : (
                  <UserSelectedBubble text={message.text} />
                )}
              </div>
            ))}
            {typing && (
              <div className="flex justify-start">
                <TypingIndicator />
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-slate-800 px-5 py-4">
          {optionBlock}

          {step === 'done' && (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={enterDashboard}
                className="inline-flex items-center gap-2 rounded-full border border-cyan-400/70 bg-cyan-500/20 px-5 py-2.5 text-sm font-semibold text-cyan-100 transition-all hover:scale-[1.02] hover:bg-cyan-500/26"
              >
                Enter Dashboard
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </ChatContainer>
    </div>
  );
}
