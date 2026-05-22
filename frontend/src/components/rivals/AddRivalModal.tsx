import { useState } from 'react';

interface AddRivalModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (username: string) => Promise<void>;
}

export default function AddRivalModal({ open, onClose, onSubmit }: AddRivalModalProps) {
  const [username, setUsername] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const submit = async () => {
    const cleaned = username.trim().replace(/^@/, '');
    if (!cleaned) return;
    setError('');
    setSent(true);
    try {
      await onSubmit(cleaned);
      window.setTimeout(() => {
        setSent(false);
        setUsername('');
        onClose();
      }, 900);
    } catch (err) {
      setSent(false);
      setError(err instanceof Error ? err.message : 'Could not send rival request.');
    }
  };

  return (
    <div className="rv-modal-wrap" onClick={onClose}>
      <div className="rv-modal-backdrop" />
      <div className="rv-modal" onClick={event => event.stopPropagation()}>
        <div className="rv-section-kicker">Rivals</div>
        <h3>Challenge someone</h3>
        <p>Enter their Flyxa username. They will receive a rival request if that username exists.</p>
        <input
          value={username}
          placeholder="@username"
          onChange={event => setUsername(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void submit();
          }}
        />
        {error && <p className="rv-modal-error">{error}</p>}
        <button type="button" disabled={!username.trim() || sent} onClick={() => { void submit(); }}>
          {sent ? 'Sending...' : 'Send request'}
        </button>
      </div>
    </div>
  );
}
