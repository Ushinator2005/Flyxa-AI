import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, MessageSquare, Send, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.js';
import { rivalsApi, rivalMessagesApi, type RivalMessage } from '../../services/api.js';
import './GlobalMessagesPanel.css';

interface InboxRival {
  userId: string;
  username: string;
  displayName: string;
  avatarInitials: string;
  avatarColor: string;
  avatarUrl?: string | null;
}

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(isoString).toLocaleDateString();
}

export default function GlobalMessagesPanel() {
  const { user } = useAuth();
  const myUserId = user?.id ?? null;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'inbox' | 'chat'>('inbox');
  const [rivals, setRivals] = useState<InboxRival[]>([]);
  const [selectedRival, setSelectedRival] = useState<InboxRival | null>(null);

  const [messages, setMessages] = useState<RivalMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Listen for open event dispatched from Header
  useEffect(() => {
    const handler = () => {
      setOpen(true);
      setView('inbox');
      setSelectedRival(null);
    };
    window.addEventListener('flyxa:open-messages', handler);
    return () => window.removeEventListener('flyxa:open-messages', handler);
  }, []);

  // Fetch accepted rivals whenever the panel opens
  useEffect(() => {
    if (!open) return;
    rivalsApi
      .getAll()
      .then(requests => {
        const accepted: InboxRival[] = requests
          .filter(r => r.status === 'accepted' && r.profile)
          .map(r => {
            const p = r.profile!;
            return {
              userId: p.userId,
              username: p.username,
              displayName: p.displayName,
              avatarInitials: p.avatarInitials,
              avatarColor: p.avatarColor,
              avatarUrl: p.avatarUrl,
            };
          });
        setRivals(accepted);
      })
      .catch(() => {});
  }, [open]);

  // Poll messages while chat view is active
  useEffect(() => {
    if (!open || view !== 'chat' || !selectedRival?.userId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const fetchMsgs = () => {
      rivalMessagesApi
        .get(selectedRival.userId)
        .then(msgs => { if (!cancelled) setMessages(msgs); })
        .catch(() => {});
    };
    fetchMsgs();
    const id = window.setInterval(fetchMsgs, 4_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, view, selectedRival?.userId]);

  // Auto-scroll to latest message
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when switching to chat view
  useEffect(() => {
    if (view === 'chat') {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [view]);

  const openChat = (rival: InboxRival) => {
    setSelectedRival(rival);
    setDraft('');
    setView('chat');
  };

  const handleSend = async () => {
    if (!selectedRival?.userId || !draft.trim() || sending) return;
    const content = draft.trim();
    setDraft('');
    setSending(true);
    const optimistic: RivalMessage = {
      id: `optimistic-${Date.now()}`,
      senderId: myUserId ?? '',
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
    try {
      const saved = await rivalMessagesApi.send(selectedRival.userId, content);
      setMessages(prev => prev.map(m => (m.id === optimistic.id ? saved : m)));
    } catch {
      setMessages(prev => prev.filter(m => m.id !== optimistic.id));
      setDraft(content);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const close = () => {
    setOpen(false);
    setView('inbox');
    setSelectedRival(null);
  };

  return (
    <>
      <div className={`gmp-overlay${open ? ' open' : ''}`} onClick={close} />

      <div className={`gmp-panel${open ? ' open' : ''}`}>
        <div className="gmp-topline" />

        {view === 'inbox' ? (
          <>
            {/* Inbox header */}
            <div className="gmp-header">
              <div className="gmp-header-info">
                <p className="gmp-header-label">Messages</p>
                <p className="gmp-header-name">
                  {rivals.length > 0
                    ? `${rivals.length} rival${rivals.length !== 1 ? 's' : ''}`
                    : 'No rivals yet'}
                </p>
              </div>
              <button className="gmp-close" onClick={close} aria-label="Close messages">
                <X size={14} />
              </button>
            </div>

            {/* Inbox list */}
            <div className="gmp-inbox-body">
              {rivals.length === 0 ? (
                <div className="gmp-empty">
                  <MessageSquare size={28} />
                  <span>No rivals yet, add someone on the Rivals page to start chatting</span>
                </div>
              ) : (
                rivals.map(rival => (
                  <button
                    key={rival.userId}
                    className="gmp-inbox-row"
                    onClick={() => openChat(rival)}
                  >
                    <div
                      className="gmp-inbox-avatar"
                      style={{
                        background: `${rival.avatarColor}14`,
                        border: `1px solid ${rival.avatarColor}38`,
                        color: rival.avatarColor,
                      }}
                    >
                      {rival.avatarUrl ? (
                        <img src={rival.avatarUrl} alt="" />
                      ) : (
                        rival.avatarInitials
                      )}
                    </div>
                    <div className="gmp-inbox-info">
                      <p className="gmp-inbox-name">{rival.displayName}</p>
                      <p className="gmp-inbox-sub">@{rival.username}</p>
                    </div>
                    <ChevronRight size={13} className="gmp-inbox-arrow" />
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            {/* Chat header */}
            <div className="gmp-header">
              <button
                className="gmp-back"
                onClick={() => setView('inbox')}
                aria-label="Back to inbox"
              >
                <ArrowLeft size={14} />
              </button>
              {selectedRival && (
                <div
                  className="gmp-chat-avatar"
                  style={{
                    background: `${selectedRival.avatarColor}18`,
                    border: `1.5px solid ${selectedRival.avatarColor}55`,
                    color: selectedRival.avatarColor,
                  }}
                >
                  {selectedRival.avatarUrl ? (
                    <img src={selectedRival.avatarUrl} alt="" />
                  ) : (
                    selectedRival.avatarInitials
                  )}
                </div>
              )}
              <div className="gmp-header-info">
                <p className="gmp-header-name">{selectedRival?.displayName ?? '—'}</p>
                <p className="gmp-header-sub">@{selectedRival?.username ?? '—'}</p>
              </div>
              <button className="gmp-close" onClick={close} aria-label="Close messages">
                <X size={14} />
              </button>
            </div>

            {/* Chat body */}
            <div className="gmp-chat-body" ref={bodyRef}>
              {messages.length === 0 ? (
                <div className="gmp-empty">
                  <MessageSquare size={28} />
                  <span>No messages yet, say something!</span>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const isMe = msg.senderId === myUserId;
                  const showTime =
                    i === messages.length - 1 ||
                    messages[i + 1]?.senderId !== msg.senderId ||
                    new Date(messages[i + 1]?.createdAt).getTime() -
                      new Date(msg.createdAt).getTime() >
                      5 * 60 * 1000;
                  return (
                    <div key={msg.id} className={`gmp-msg-row ${isMe ? 'me' : 'them'}`}>
                      <div className={`gmp-msg ${isMe ? 'me' : 'them'}`}>{msg.content}</div>
                      {showTime && (
                        <span className="gmp-msg-time">{relativeTime(msg.createdAt)}</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Chat footer */}
            <div className="gmp-chat-footer">
              <div className="gmp-input-row">
                <textarea
                  ref={inputRef}
                  className="gmp-input"
                  placeholder={
                    selectedRival ? `Message ${selectedRival.displayName}…` : 'Select a rival…'
                  }
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={!selectedRival?.userId || sending}
                  rows={1}
                />
                <button
                  className="gmp-send"
                  onClick={handleSend}
                  disabled={!draft.trim() || !selectedRival?.userId || sending}
                  aria-label="Send message"
                >
                  <Send size={15} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
