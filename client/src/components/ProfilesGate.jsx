// Netflix-style "Who's watching?" profile picker (auth-less households).
import React, { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';

export default function ProfilesGate({ onPick }) {
  const app = useApp();
  const { t } = useT();
  const [profiles, setProfiles] = useState(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kid, setKid] = useState(false);

  const load = () => api.get('/profiles').then((r) => setProfiles(r.profiles)).catch(() => setProfiles([]));
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim()) return;
    await api.post('/profiles', { name: name.trim(), kid, hue: Math.floor(Math.random() * 360) });
    setName(''); setKid(false); setAdding(false);
    load();
  };

  if (!profiles) return <div className="nb-center"><div className="nb-badge"><span className="nb-dot" />…</div></div>;

  return (
    <div className="nb-center">
      <div style={{ textAlign: 'center' }}>
        <div className="nb-logo" style={{ justifyContent: 'center', marginBottom: 26 }}>
          <span className="mark" />{app.status.appName || 'Nebula'}
        </div>
        <h1 style={{ fontFamily: "'Archivo Black',sans-serif", fontSize: 34, letterSpacing: '-.03em', textTransform: 'uppercase', margin: '0 0 34px' }}>
          {t('whoWatching')}
        </h1>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 640 }}>
          {profiles.map((p) => (
            <button key={p.id} onClick={() => onPick(p)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink)', font: 'inherit' }}>
              <div style={{
                width: 108, height: 108, borderRadius: 22, margin: '0 auto 10px',
                background: `linear-gradient(135deg, oklch(0.82 0.15 ${p.hue}), oklch(0.6 0.12 ${(p.hue + 40) % 360}))`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'Archivo Black',sans-serif", fontSize: 44, color: '#06120d',
                boxShadow: `0 12px 40px -12px oklch(0.82 0.15 ${p.hue} / .5)`,
              }}>
                {p.name[0]?.toUpperCase()}
              </div>
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              {p.kid && <div className="nb-note">{t('kidProfile')}</div>}
            </button>
          ))}
          <button onClick={() => setAdding(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', font: 'inherit' }}>
            <div style={{
              width: 108, height: 108, borderRadius: 22, margin: '0 auto 10px', border: '2px dashed var(--line)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34,
            }}>{I.plus}</div>
            <div>{t('addProfile')}</div>
          </button>
        </div>
        {!profiles.length && !adding && (
          <button className="nb-btn ghost" style={{ marginTop: 30 }} onClick={() => onPick(null)}>{t('skip')}</button>
        )}
        {adding && (
          <div className="nb-wizard" style={{ width: 'min(380px,92vw)', margin: '30px auto 0', padding: 26 }}>
            <div className="nb-form-row">
              <input className="nb-input grow" autoFocus placeholder={t('username')} value={name}
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            </div>
            <div className="nb-form-row">
              <button className={'nb-toggle' + (kid ? ' on' : '')} onClick={() => setKid(!kid)}><i /></button>
              <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>{t('kidProfile')}</span>
            </div>
            <div className="nb-note" style={{ marginBottom: 12, textAlign: 'left' }}>{t('kidHint')}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="nb-btn play sm" disabled={!name.trim()} onClick={add}>{t('add')}</button>
              <button className="nb-btn ghost sm" onClick={() => setAdding(false)}>{t('cancel')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
