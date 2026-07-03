import { useNavigate } from 'react-router-dom';
import FlyxaLogo from './FlyxaLogo.js';
import './FlyxaChatWidget.css';

export default function FlyxaChatWidget() {
  const navigate = useNavigate();

  return (
    <div className="flyxa-chat-shell">
      <button
        type="button"
        onClick={() => navigate('/flyxa-ai/ask')}
        className="flyxa-chat-trigger"
      >
        <span className="icon-wrap" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <FlyxaLogo size={16} />
        </span>
        Ask Flyxa
      </button>
    </div>
  );
}
