'use client';

import { useState } from 'react';

export function LoginForm({ needsCode }: { needsCode: boolean }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      window.location.href = '/';
    } catch (err) {
      setError((err as Error).message);
      setCode('');
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {needsCode && (
        <>
          <label htmlFor="code">Code from your authenticator app</label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </>
      )}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? 'Signing in' : 'Sign in'}
      </button>
      {error && <p className="form-msg">{error}</p>}
      {!needsCode && <p className="field-hint">Two-step sign-in is off. Set DASHBOARD_TOTP_SECRET before putting the dashboard online.</p>}
    </form>
  );
}
