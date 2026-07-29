import { useEffect, useRef } from 'react';
import './Toast.css';

/**
 * Toast — fixed bottom-right notification that auto-dismisses.
 *
 * Props:
 *   message   string   — text to display
 *   onDismiss ()=>void — called when the toast hides (auto or manual)
 *   duration  number   — ms before auto-dismiss (default 4000)
 */
export default function Toast({ message, onDismiss, duration = 4000 }) {
  const timerRef = useRef(null);

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, duration);
    return () => clearTimeout(timerRef.current);
  }, [onDismiss, duration]);

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast__icon" aria-hidden="true">✓</span>
      <span className="toast__message">{message}</span>
      <button
        className="toast__close"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}
