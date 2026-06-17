import React, { useEffect, useMemo, useState } from 'react';
import { Bot, MessageSquare, Send, Sparkles, X } from 'lucide-react';
import { aiApi } from '../../services/api.js';
import useFlyxaStore from '../../store/flyxaStore.js';
import { useActiveAccountEntries, useAllTrades, useDashboardStats } from '../../store/selectors.js';
import './FlyxaChatWidget.css';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

const initialMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: 'Ask anything about Flyxa. I can help with features, workflows, and where to find things.',
};

const QUICK_PROMPTS = [
  'Where should I log my daily routine?',
  'How do I review my tilt patterns?',
  'Show me where to edit risk rules.',
] as const;

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });
}

export default function FlyxaChatWidget() {
  const [open, setOpen] = useState(false);

  // Close when the messages panel opens so they don't overlap
  useEffect(() => {
    const handler = () => setOpen(false);
    window.addEventListener('flyxa:open-messages', handler);
    return () => window.removeEventListener('flyxa:open-messages', handler);
  }, []);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([initialMessage]);
  const allTrades = useAllTrades();
  const entries = useActiveAccountEntries();
  const stats = useDashboardStats();
  const riskRules = useFlyxaStore(state => state.riskRules);
  const activeAccountId = useFlyxaStore(state => state.activeAccountId);
  const account = useFlyxaStore(state => state.accounts.find(item => item.id === state.activeAccountId) ?? state.accounts[0]);

  const canSend = input.trim() !== '' && !loading;

  const history = useMemo(
    () => messages
      .filter(message => message.id !== initialMessage.id)
      .slice(-6)
      .map(({ role, content }) => ({ role, content })),
    [messages]
  );

  const activeConversation = messages.filter(message => message.id !== initialMessage.id);

  const aiContext = useMemo(() => {
    const recent = [...allTrades].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).slice(-20);
    const psych = [...entries].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);

    return `
You are Flyxa AI, a personal trading coach for this specific trader.

TRADER DATA (last 30 days):
  Net P&L: ${formatCurrency(stats.netPnL)}
  Win Rate: ${stats.winRate.toFixed(1)}%
  Avg R:R: ${stats.avgRR.toFixed(2)}R
  Total Trades: ${stats.totalTrades}
  Account: ${account?.name ?? 'Unknown'} (${account?.type ?? 'unknown'})
  Daily Loss Limit: ${formatCurrency(account?.dailyLossLimit ?? 0)}
  Active Account ID: ${activeAccountId ?? 'all'}

RECENT TRADES (last 20):
${recent.map(trade =>
`  ${trade.date} ${trade.symbol} ${trade.direction} | Entry ${trade.entry} |
   SL ${trade.sl} | TP ${trade.tp} | Exit ${trade.exit ?? 'OPEN'} |
   P&L ${formatCurrency(trade.pnl - (trade.commission ?? 0))} | R:R ${trade.rr.toFixed(2)} | ${trade.result.toUpperCase()}`
).join('\n')}

PSYCHOLOGY TREND (last 7 days):
${psych.map(entry =>
`  ${entry.date}: Discipline ${entry.psychology.discipline}/5,
   Trade Quality ${entry.psychology.setupQuality}/5,
   Execution ${entry.psychology.execution}/5`
).join('\n')}

CURRENT TRADING RULES:
${riskRules.map(rule => `  ${rule.label}: ${rule.value} ${rule.unit}`).join('\n')}

Use this data to give specific, personalised coaching advice.
Reference actual trades by date and symbol when relevant.
Do not give generic advice - be specific to this trader's patterns.
`.trim();
  }, [account?.dailyLossLimit, account?.name, account?.type, activeAccountId, allTrades, entries, riskRules, stats.avgRR, stats.netPnL, stats.totalTrades, stats.winRate]);

  const sendMessage = async (rawInput?: string) => {
    const question = (rawInput ?? input).trim();
    if (!question || loading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: question,
    };

    setMessages(current => [...current, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await aiApi.flyxaChat(question, history, aiContext);
      setMessages(current => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: response.reply,
        },
      ]);
    } catch (error) {
      setMessages(current => [
        ...current,
        {
          id: `assistant-error-${Date.now()}`,
          role: 'assistant',
          content: error instanceof Error
            ? error.message
            : 'Something went wrong. Please try again.',
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await sendMessage();
  };

  const sendQuickPrompt = async (prompt: string) => {
    await sendMessage(prompt);
  };

  return (
    <div className="flyxa-chat-shell">
      {open && (
        <div className="flyxa-chat-card">
          <div className="flyxa-chat-card-topline" />
          <div className="flyxa-chat-header">
            <div className="flyxa-chat-title-wrap">
              <div className="flyxa-chat-bot-badge">
                <Bot size={17} />
              </div>
              <div>
                <p className="flyxa-chat-title">Ask Flyxa</p>
                <p className="flyxa-chat-sub">Product help, workflows, and shortcuts across Flyxa</p>
              </div>
            </div>
            <span className="flyxa-chat-live">
              <span className="dot" />
              Live assistant
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flyxa-chat-close"
              aria-label="Close chat"
            >
              <X size={17} />
            </button>
          </div>

          <div className="flyxa-chat-body">
            {activeConversation.length === 0 && (
              <div className="flyxa-chat-prompts">
                <p>
                  <Sparkles size={13} />
                  Try one of these:
                </p>
                <div>
                  {QUICK_PROMPTS.map(prompt => (
                    <button key={prompt} type="button" onClick={() => sendQuickPrompt(prompt)}>
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map(message => (
              <div
                key={message.id}
                className={`flyxa-chat-row ${message.role === 'user' ? 'user' : 'assistant'}`}
              >
                {message.role === 'assistant' && <span className="flyxa-msg-avatar"><Bot size={12} /></span>}
                <div className={`flyxa-msg ${message.role === 'user' ? 'user' : 'assistant'}`}>
                  {message.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flyxa-chat-row assistant">
                <span className="flyxa-msg-avatar"><Bot size={12} /></span>
                <div className="flyxa-msg assistant thinking">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="flyxa-chat-input-wrap">
            <div className="flyxa-chat-input-row">
              <textarea
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={1}
                maxLength={240}
                placeholder="Ask about Flyxa..."
                className="flyxa-chat-input"
              />
              <button
                type="submit"
                disabled={!canSend}
                className="flyxa-chat-send"
                aria-label="Send message"
              >
                <Send size={16} />
              </button>
            </div>
            <div className="flyxa-chat-hint">
              <span>Enter to send</span>
              <span>{input.length}/240</span>
            </div>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        className="flyxa-chat-trigger"
      >
        <span className="icon-wrap">
          <MessageSquare size={16} />
        </span>
        Ask Flyxa
      </button>
    </div>
  );
}
