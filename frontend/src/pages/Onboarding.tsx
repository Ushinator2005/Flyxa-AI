import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ProfitabilityStatus, useOnboarding } from '../contexts/OnboardingContext.js';

type ConversationStep = 'boot' | 'goal' | 'trader' | 'rules' | 'summary' | 'done';
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
    setStep('done');
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

    return null;
  }, [busy, canContinueRules, lockedSingle, otherGoalText, selectedRules, showOtherInput, step]);

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
