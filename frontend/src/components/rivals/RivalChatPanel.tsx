import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, X } from 'lucide-react';
import type { Rival } from '../../types/rivals.js';
import { rivalMessagesApi, type RivalMessage } from '../../services/api.js';
import './RivalChatPanel.css';

interface RivalChatPanelProps {
  open: boolean;
  rival: Rival | null;
  myUserId: string | null;
  onClose: () => void;
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

export default function RivalChatPanel({ open, rival, myUserId, onClose }: RivalChatPanelProps) {
  const [messages, setMessages] = useState<RivalMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fetch messages + start polling while panel is open
  useEffect(() => {
    if (!open || !rival?.userId) {
      setMessages([]);
      return;
    }

    let cancelled = false;

    const fetch = () => {
      rivalMessagesApi.get(rival.userId!).then(msgs => {
        if (!cancelled) setMessages(msgs);
      }).catch(() => {});
    };

    fetch();
    const id = window.setInterval(fetch, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, rival?.userId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 280);
    }
  }, [open]);

  const handleSend = async () => {
    if (!rival?.userId || !draft.trim() || sending) return;
    const content = draft.trim();
    setDraft('');
    setSending(true);

    // Optimistic update
    const optimistic: RivalMessage = {
      id: `optimistic-${Date.now()}`,
      senderId: myUserId ?? '',
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);

    try {
      const saved = await rivalMessagesApi.send(rival.userId, content);
      // Replace optimistic with saved
      setMessages(prev => prev.map(m => m.id === optimistic.id ? saved : m));
    } catch {
      // Remove optimistic on failure
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

  return (
    <>
      <div className={`rival-chat-panel${open ? ' open' : ''}`}>
        <div className="rival-chat-topline" />

        {/* Header */}
        <div className="rival-chat-header">
          {rival && (
            <div
              className="rival-chat-avatar"
              style={{
                background: `${rival.avatarColor}18`,
                border: `1.5px solid ${rival.avatarColor}55`,
                color: rival.avatarColor,
              }}
            >
              {rival.avatarUrl
                ? <img src={rival.avatarUrl} alt="" />
                : rival.avatarInitials}
            </div>
          )}
          <div className="rival-chat-header-info">
            <p className="rival-chat-header-name">{rival?.displayName ?? '—'}</p>
            <p className="rival-chat-header-sub">@{rival?.username ?? '—'}</p>
          </div>
          <button className="rival-chat-close" onClick={onClose} aria-label="Close chat">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="rival-chat-body" ref={bodyRef}>
          {!rival?.userId ? (
            <div className="rival-chat-empty">
              <MessageSquare size={28} />
              <span>Select a rival to start chatting</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="rival-chat-empty">
              <MessageSquare size={28} />
              <span>No messages yet — say something!</span>
            </div>
          ) : (
            messages.map((msg, i) => {
              const isMe = msg.senderId === myUserId;
              const showTime = i === messages.length - 1
                || messages[i + 1]?.senderId !== msg.senderId
                || (new Date(messages[i + 1]?.createdAt).getTime() - new Date(msg.createdAt).getTime()) > 5 * 60 * 1000;
              return (
                <div key={msg.id} className={`rival-chat-row ${isMe ? 'me' : 'them'}`}>
                  <div className={`rival-chat-msg ${isMe ? 'me' : 'them'}`}>
                    {msg.content}
                  </div>
                  {showTime && (
                    <span className="rival-chat-time">{relativeTime(msg.createdAt)}</span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="rival-chat-footer">
          <div className="rival-chat-input-row">
            <textarea
              ref={inputRef}
              className="rival-chat-input"
              placeholder={rival ? `Message ${rival.displayName}…` : 'Select a rival…'}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!rival?.userId || sending}
              rows={1}
            />
            <button
              className="rival-chat-send"
              onClick={handleSend}
              disabled={!draft.trim() || !rival?.userId || sending}
              aria-label="Send message"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
