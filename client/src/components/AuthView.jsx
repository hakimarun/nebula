import React, { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';

export default function AuthView({ onAuth }) {
  const app = useApp();
  const { t } = useT();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (mode === 'register' && password !== password2) { setErr(t('passwordMismatch')); return; }
    setBusy(true);
    try {
      const r = await api.post('/auth/' + (mode === 'login' ? 'login' : 'register'),
        { username, password, email: email || undefined });
      onAuth(r.user, r.token);
    } catch (ex) {
      setErr(ex.status === 401 ? t('badCredentials') : (ex.message || t('error')));
    }
    setBusy(false);
  };

  return (
    <div className="nb-center">
      <form className="nb-wizard" style={{ width: 'min(440px,100%)' }} onSubmit={submit}>
        <div className="nb-logo" style={{ fontSize: 26 }}><span className="mark" />{app.status.appName || 'Nebula'}</div>
        <h1 style={{ fontSize: 24 }}>{mode === 'login' ? t('signInTitle', { app: app.status.appName || 'NEBULA' }) : t('registerTitle')}</h1>
        <p className="sub">{t('authRequired')}</p>
        <div className="nb-form-row"><input className="nb-input grow" autoFocus placeholder={t('username')}
          value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></div>
        <div className="nb-form-row"><input className="nb-input grow" type="password" placeholder={t('password')}
          value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></div>
        {mode === 'register' && (
          <>
            <div className="nb-form-row"><input className="nb-input grow" type="password" placeholder={t('passwordRepeat')}
              value={password2} onChange={(e) => setPassword2(e.target.value)} /></div>
            <div className="nb-form-row"><input className="nb-input grow" type="email" placeholder={t('email') + ' (' + t('optional') + ')'}
              value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          </>
        )}
        {err && <div className="nb-note err" style={{ marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="nb-btn play" type="submit" disabled={busy || !username || !password}>
            {mode === 'login' ? t('login') : t('register')}
          </button>
          {app.status.allowRegistration && (
            <button type="button" className="nb-btn ghost"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
              {mode === 'login' ? t('register') : t('login')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
