import React, { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { useT, LOCALES } from '../i18n.js';
import { HuePicker } from './HueWheel.jsx';
import { PathList } from './FolderPicker.jsx';

const STEPS = ['welcome', 'libraries', 'meta', 'auth', 'email', 'done'];

export default function SetupWizard({ onDone }) {
  const app = useApp();
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  const [appName, setAppName] = useState('NEBULA');
  const [paths, setPaths] = useState({ movies: [], series: [], music: [], images: [] });
  const [tmdbKey, setTmdbKey] = useState('');
  const [keyStatus, setKeyStatus] = useState('');
  const [authEnabled, setAuthEnabled] = useState(false);
  const [allowReg, setAllowReg] = useState(false);
  const [admin, setAdmin] = useState({ username: '', password: '', email: '' });
  const [smtp, setSmtp] = useState({ host: '', port: 587, secure: false, user: '', pass: '', from: '' });

  const testKey = async () => {
    setKeyStatus('…');
    try {
      const r = await api.post('/settings/test-tmdb', { key: tmdbKey });
      setKeyStatus(r.ok ? 'ok' : 'bad');
    } catch { setKeyStatus('bad'); }
  };

  const finish = async () => {
    setBusy(true);
    try {
      const r = await api.post('/setup', {
        appName, defaultLocale: app.locale, defaultHue: app.hue,
        libraryPaths: paths, tmdbApiKey: tmdbKey,
        authEnabled: authEnabled && admin.username && admin.password.length >= 4,
        allowRegistration: allowReg,
        admin: authEnabled ? admin : undefined,
        smtp: smtp.host ? smtp : undefined,
      });
      setStep(STEPS.length - 1);
      setTimeout(() => onDone(r.token), 1600);
    } catch (e) {
      app.toast(t('testFailed', { err: e.message }), 'err');
    }
    setBusy(false);
  };

  const canNext = () => {
    if (STEPS[step] === 'auth' && authEnabled) return admin.username.length >= 2 && admin.password.length >= 4;
    return true;
  };

  const name = STEPS[step];

  return (
    <div className="nb-center">
      <div className="nb-wizard">
        <div className="nb-wizard-steps">
          {STEPS.slice(0, -1).map((s, i) => <i key={s} className={i <= step ? 'on' : ''} />)}
        </div>

        {name === 'welcome' && (
          <>
            <div className="nb-logo" style={{ marginTop: 14 }}><span className="mark" />{appName || 'Nebula'}</div>
            <h1>{t('wizWelcome')}</h1>
            <p className="sub">{t('wizWelcomeSub')}</p>
            <div className="nb-form-row">
              <label>{t('appName')}</label>
              <input className="nb-input grow" value={appName} onChange={(e) => setAppName(e.target.value)} />
            </div>
            <div className="nb-form-row">
              <label>{t('language')}</label>
              <select className="nb-input" value={app.locale} onChange={(e) => app.setLocale(e.target.value, false)}>
                {Object.entries(LOCALES).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
              </select>
            </div>
            <div className="nb-form-row" style={{ alignItems: 'flex-start' }}>
              <label>{t('accentColor')}</label>
              <div style={{ flex: 1 }}><HuePicker hue={app.hue} onChange={(h) => app.setHue(h, false)} /></div>
            </div>
          </>
        )}

        {name === 'libraries' && (
          <>
            <h1>{t('wizLibraries')}</h1>
            <p className="sub">{t('wizLibrariesSub')}</p>
            <PathList label={t('moviesFolders')} paths={paths.movies} onChange={(v) => setPaths({ ...paths, movies: v })} />
            <PathList label={t('seriesFolders')} paths={paths.series} onChange={(v) => setPaths({ ...paths, series: v })} />
            <PathList label={t('musicFolders')} paths={paths.music} onChange={(v) => setPaths({ ...paths, music: v })} />
            <PathList label={t('imagesFolders')} paths={paths.images} onChange={(v) => setPaths({ ...paths, images: v })} />
          </>
        )}

        {name === 'meta' && (
          <>
            <h1>{t('wizMeta')} <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'none' }}>({t('optional')})</span></h1>
            <p className="sub">{t('wizMetaSub')}</p>
            <div className="nb-form-row">
              <input className="nb-input grow" placeholder={t('tmdbKey')} value={tmdbKey} onChange={(e) => { setTmdbKey(e.target.value); setKeyStatus(''); }} />
              <button className="nb-btn ghost sm" disabled={!tmdbKey.trim()} onClick={testKey}>{t('testKey')}</button>
            </div>
            {keyStatus === 'ok' && <div className="nb-note ok">{t('keyOk')}</div>}
            {keyStatus === 'bad' && <div className="nb-note err">{t('keyBad')}</div>}
            {keyStatus === '…' && <div className="nb-note">…</div>}
            <div className="nb-note" style={{ marginTop: 12 }}>{t('tmdbHint')}</div>
          </>
        )}

        {name === 'auth' && (
          <>
            <h1>{t('wizAuth')} <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'none' }}>({t('optional')})</span></h1>
            <p className="sub">{t('wizAuthSub')}</p>
            <div className="nb-form-row">
              <button className={'nb-toggle' + (authEnabled ? ' on' : '')} onClick={() => setAuthEnabled(!authEnabled)}><i /></button>
              <span style={{ fontSize: 14 }}>{t('authEnable')}</span>
            </div>
            {authEnabled && (
              <>
                <div className="nb-form-row"><input className="nb-input grow" placeholder={t('username')}
                  value={admin.username} onChange={(e) => setAdmin({ ...admin, username: e.target.value })} /></div>
                <div className="nb-form-row"><input className="nb-input grow" type="password" placeholder={t('password')}
                  value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} /></div>
                <div className="nb-form-row"><input className="nb-input grow" type="email" placeholder={t('email') + ' (' + t('optional') + ')'}
                  value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} /></div>
                <div className="nb-form-row">
                  <button className={'nb-toggle' + (allowReg ? ' on' : '')} onClick={() => setAllowReg(!allowReg)}><i /></button>
                  <span style={{ fontSize: 14 }}>{t('allowRegistration')}</span>
                </div>
              </>
            )}
          </>
        )}

        {name === 'email' && (
          <>
            <h1>{t('wizEmail')} <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'none' }}>({t('optional')})</span></h1>
            <p className="sub">{t('wizEmailSub')}</p>
            <div className="nb-form-row">
              <input className="nb-input grow" placeholder={t('smtpHost')} value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
              <input className="nb-input" style={{ width: 90 }} type="number" placeholder={t('smtpPort')} value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} />
            </div>
            <div className="nb-form-row">
              <input className="nb-input grow" placeholder={t('smtpUser')} value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />
              <input className="nb-input grow" type="password" placeholder={t('smtpPass')} value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} />
            </div>
            <div className="nb-form-row">
              <input className="nb-input grow" placeholder={t('smtpFrom')} value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
            </div>
            <div className="nb-note">{t('later')}</div>
          </>
        )}

        {name === 'done' && (
          <>
            <h1>{t('wizDone')}</h1>
            <p className="sub">{t('wizDoneSub')}</p>
          </>
        )}

        {name !== 'done' && (
          <div className="nb-wizard-foot">
            {step > 0 && <button className="nb-btn ghost" onClick={() => setStep(step - 1)}>{t('backBtn')}</button>}
            <span className="spacer" />
            {step < STEPS.length - 2
              ? <button className="nb-btn play" disabled={!canNext()} onClick={() => setStep(step + 1)}>
                {step === 0 ? t('getStarted') : t('next')}
              </button>
              : <button className="nb-btn play" disabled={busy || !canNext()} onClick={finish}>{t('finish')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
