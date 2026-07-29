import { useState, useEffect, useRef } from 'react';
import './AuthModal.css';

/**
 * AuthModal — Login / Register / Guest mode sheet.
 *
 * Props:
 *   onAuth(user)  — called with { id, username, is_guest } on success
 */
export default function AuthModal({ onAuth }) {
  const [tab, setTab]           = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, [tab]);

  /** Parse a Response safely — never throws on empty or non-JSON bodies. */
  async function safeJson(res) {
    const text = await res.text();
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch { return { _raw: text }; }
  }

  async function submit(e) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    const endpoint = tab === 'login' ? '/auth/login' : '/auth/register';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        throw new Error(data.error || `Server error (${res.status})`);
      }
      if (!data.user) throw new Error('Server returned no user data');
      onAuth(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function enterAsGuest() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/auth/guest', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await safeJson(res);
      if (!res.ok) {
        throw new Error(data.error || `Server error (${res.status})`);
      }
      if (!data.user) throw new Error('Server returned no user data');
      onAuth(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-backdrop" role="dialog" aria-modal="true" aria-label="Sign in to Throughline">
      <div className="auth-card">
        {/* Brand */}
        <div className="auth-brand">
          <svg className="auth-brand__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 6 C6 6,7 10,10 10 C13 10,14 6,17 6 C20 6,21 10,21 10"
              stroke="#5b5bd6" strokeWidth="2" strokeLinecap="round"/>
            <path d="M3 12 C5 12,8 8,12 12 C16 16,19 12,21 12"
              stroke="#7c5cd8" strokeWidth="2" strokeLinecap="round"/>
            <path d="M3 18 C6 18,7 14,10 14 C13 14,14 18,17 18 C20 18,21 14,21 14"
              stroke="#3b82d4" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span className="auth-brand__name">Throughline</span>
        </div>

        <p className="auth-tagline">Every choice, a branch. Every branch, a story.</p>

        {/* Guest mode — most prominent CTA */}
        <button
          className="auth-guest-btn"
          onClick={enterAsGuest}
          disabled={loading}
        >
          {loading ? 'Starting…' : '⚡ Enter as Guest / Judge — one click, no account'}
        </button>

        <div className="auth-divider"><span>or sign in</span></div>

        {/* Tab toggle */}
        <div className="auth-tabs">
          <button
            className={`auth-tab${tab === 'login' ? ' auth-tab--active' : ''}`}
            onClick={() => { setTab('login'); setError(null); }}
          >Log in</button>
          <button
            className={`auth-tab${tab === 'register' ? ' auth-tab--active' : ''}`}
            onClick={() => { setTab('register'); setError(null); }}
          >Sign up</button>
        </div>

        {/* Form */}
        <form className="auth-form" onSubmit={submit} noValidate>
          <label className="auth-label">
            Username
            <input
              ref={inputRef}
              className="auth-input"
              type="text"
              autoComplete={tab === 'login' ? 'username' : 'new-username'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your_username"
              required
              minLength={2}
              disabled={loading}
            />
          </label>
          <label className="auth-label">
            Password
            <input
              className="auth-input"
              type="password"
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={tab === 'register' ? 'At least 6 characters' : '••••••••'}
              required
              minLength={6}
              disabled={loading}
            />
          </label>

          {error && <p className="auth-error" role="alert">{error}</p>}

          <button className="auth-submit-btn" type="submit" disabled={loading || !username || !password}>
            {loading ? 'Please wait…' : tab === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
