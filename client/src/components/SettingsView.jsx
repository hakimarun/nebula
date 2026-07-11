import React, { useState, useEffect, useCallback } from 'react';
import { api, setToken } from '../api.js';
import { useApp } from '../ctx.js';
import { useT, LOCALES } from '../i18n.js';
import { I } from './Icons.jsx';
import { HuePicker } from './HueWheel.jsx';
import { PathList, FolderBrowser } from './FolderPicker.jsx';
import { fmtBytes } from '../util.js';

const TABS = ['setGeneral', 'setLibrary', 'setMetadata', 'setPlayback', 'setUsers', 'setEmail', 'setBackup', 'statsTab', 'setAdvanced'];

export default function SettingsView() {
  const app = useApp();
  const { t } = useT();
  const [tab, setTab] = useState(0);
  const [s, setS] = useState(null);

  useEffect(() => { api.get('/settings').then(setS).catch(() => { }); }, []);

  const save = useCallback(async (patch) => {
    try {
      const updated = await api.put('/settings', patch);
      setS((prev) => ({ ...prev, ...patch, ...(!patch.smtp ? {} : { smtp: { ...patch.smtp, pass: updated.smtp?.pass ? '••••••' : '' } }) }));
      app.toast('✓ ' + t('save'));
      app.loadStatus();
      return true;
    } catch (e) {
      if (e.message === 'create_admin_first') app.toast(t('createAdminFirst'), 'err');
      else app.toast(t('testFailed', { err: e.message }), 'err');
      return false;
    }
  }, [app, t]);

  if (!s) return <div className="nb-empty">{t('loading')}</div>;

  const Toggle = ({ value, onChange }) => (
    <button className={'nb-toggle' + (value ? ' on' : '')} onClick={() => onChange(!value)}><i /></button>
  );

  const panels = [
    <GeneralTab key="g" s={s} setS={setS} save={save} Toggle={Toggle} />,
    <LibraryTab key="l" s={s} setS={setS} save={save} />,
    <MetaTab key="m" s={s} setS={setS} save={save} />,
    <PlaybackTab key="p" s={s} setS={setS} save={save} Toggle={Toggle} />,
    <UsersTab key="u" s={s} setS={setS} save={save} Toggle={Toggle} />,
    <EmailTab key="e" s={s} setS={setS} save={save} Toggle={Toggle} />,
    <BackupTab key="b" s={s} setS={setS} save={save} Toggle={Toggle} />,
    <StatsTab key="st" />,
    <AdvancedTab key="a" s={s} setS={setS} save={save} Toggle={Toggle} />,
  ];

  return (
    <div className="nb-page">
      <h1>{t('settings')}</h1>
      <div className="nb-tabs">
        {TABS.map((k, i) => (
          <button key={k} className={'nb-tab' + (i === tab ? ' on' : '')} onClick={() => setTab(i)}>{t(k)}</button>
        ))}
      </div>
      {panels[tab]}
    </div>
  );
}

/* ---------- General ---------- */
function GeneralTab({ s, setS, save, Toggle }) {
  const app = useApp();
  const { t } = useT();
  const ui = s.ui || {};
  const setUi = (patch) => { const next = { ...ui, ...patch }; setS({ ...s, ui: next }); save({ ui: next }); };
  return (
    <>
      <div className="nb-panel">
        <h3>{t('setGeneral')}</h3>
        <div className="nb-form-row">
          <label>{t('appName')}</label>
          <input className="nb-input grow" value={s.appName} onChange={(e) => setS({ ...s, appName: e.target.value })}
            onBlur={() => save({ appName: s.appName })} />
        </div>
        <div className="nb-form-row">
          <label>{t('language')}</label>
          <select className="nb-input" value={app.locale}
            onChange={(e) => { app.setLocale(e.target.value); save({ defaultLocale: e.target.value }); }}>
            {Object.entries(LOCALES).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </div>
      </div>
      <div className="nb-panel">
        <h3>{t('accentColor')}</h3>
        <p className="hint">{t('later')}</p>
        <HuePicker hue={app.hue} onChange={(h) => { app.setHue(h); save({ defaultHue: h }); }} />
      </div>
      <div className="nb-panel">
        <h3>{t('uiOptions')}</h3>
        <div className="nb-form-row"><label>{t('showMatch')}</label><Toggle value={ui.showMatch !== false} onChange={(v) => setUi({ showMatch: v })} /></div>
        <div className="nb-form-row"><label>{t('heroEnabled')}</label><Toggle value={ui.heroEnabled !== false} onChange={(v) => setUi({ heroEnabled: v })} /></div>
        <div className="nb-form-row"><label>{t('top10Enabled')}</label><Toggle value={ui.top10Enabled !== false} onChange={(v) => setUi({ top10Enabled: v })} /></div>
        <div className="nb-form-row">
          <label>{t('cardSize')}</label>
          <input type="range" min="180" max="360" step="4" value={ui.cardSize || 268}
            style={{ accentColor: 'var(--mint)', width: 200 }}
            onChange={(e) => {
              const v = Number(e.target.value);
              document.documentElement.style.setProperty('--card-w', v + 'px');
              setS({ ...s, ui: { ...ui, cardSize: v } });
            }}
            onMouseUp={() => save({ ui: { ...ui, cardSize: s.ui.cardSize } })}
            onTouchEnd={() => save({ ui: { ...ui, cardSize: s.ui.cardSize } })} />
          <span className="nb-note">{ui.cardSize || 268}px</span>
        </div>
        <FxRow />
      </div>
    </>
  );
}

/* per-device visual effects mode (localStorage, not a server setting) */
function FxRow() {
  const { t } = useT();
  const [fx, setFx] = useState(localStorage.getItem('nebula_fx') || 'auto');
  return (
    <>
      <div className="nb-form-row">
        <label>{t('fxEffects')}</label>
        <select className="nb-input" value={fx}
          onChange={(e) => { setFx(e.target.value); window.__setNebulaFx?.(e.target.value); }}>
          <option value="auto">{t('fxAuto')}</option>
          <option value="on">{t('fxOn')}</option>
          <option value="off">{t('fxOff')}</option>
        </select>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>{t('fxHint')}</p>
    </>
  );
}

/* ---------- Library ---------- */
function LibraryTab({ s, setS, save }) {
  const app = useApp();
  const { t } = useT();
  const [scan, setScan] = useState(null);
  const paths = s.libraryPaths || { movies: [], series: [], music: [], images: [] };
  const setPaths = (kind, v) => {
    const next = { ...paths, [kind]: v };
    setS({ ...s, libraryPaths: next });
    save({ libraryPaths: next });
  };
  const poll = useCallback(() => api.get('/scan/status').then(setScan).catch(() => { }), []);
  useEffect(() => {
    poll();
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, [poll]);

  const startScan = async () => { await api.post('/scan'); poll(); app.toast(t('scanning')); };

  return (
    <>
      <div className="nb-panel">
        <h3>{t('libraryPaths')}</h3>
        <p className="hint">{t('pathHint')}</p>
        <PathList label={t('moviesFolders')} paths={paths.movies} onChange={(v) => setPaths('movies', v)} />
        <PathList label={t('seriesFolders')} paths={paths.series} onChange={(v) => setPaths('series', v)} />
        <PathList label={t('musicFolders')} paths={paths.music} onChange={(v) => setPaths('music', v)} />
        <PathList label={t('imagesFolders')} paths={paths.images} onChange={(v) => setPaths('images', v)} />
      </div>
      <div className="nb-panel">
        <h3>{t('statsTitle')}</h3>
        {scan && (
          <div className="nb-stats" style={{ marginBottom: 14 }}>
            <div className="nb-stat"><div className="v">{scan.movies}</div><div className="k">{t('stMovies')}</div></div>
            <div className="nb-stat"><div className="v">{scan.series}</div><div className="k">{t('stSeries')}</div></div>
            <div className="nb-stat"><div className="v">{scan.episodes}</div><div className="k">{t('stEpisodes')}</div></div>
            <div className="nb-stat"><div className="v">{scan.tracks}</div><div className="k">{t('stTracks')}</div></div>
            <div className="nb-stat"><div className="v">{scan.images}</div><div className="k">{t('stImages')}</div></div>
            <div className="nb-stat"><div className="v" style={{ fontSize: 20 }}>{fmtBytes(scan.totalBytes)}</div><div className="k">{t('stSize')}</div></div>
          </div>
        )}
        <div className="nb-form-row">
          <button className="nb-btn play sm" disabled={scan?.scanning} onClick={startScan}>
            {I.refresh} {scan?.scanning ? t('scanning') : t('scanNow')}
          </button>
          {scan?.enrich?.running && (
            <span className="nb-note">{t('enriching', { done: scan.enrich.done, total: scan.enrich.total })}</span>
          )}
          {scan?.lastScan ? <span className="nb-note">{t('lastScan')}: {new Date(scan.lastScan).toLocaleString()}</span> : null}
        </div>
        <div className="nb-form-row">
          <label>{t('scanInterval')}</label>
          <input className="nb-input" type="number" min="5" style={{ width: 100 }} value={s.scanIntervalMin}
            onChange={(e) => setS({ ...s, scanIntervalMin: Number(e.target.value) })}
            onBlur={() => save({ scanIntervalMin: s.scanIntervalMin })} />
        </div>
      </div>
      <FfmpegPanel s={s} setS={setS} save={save} />
    </>
  );
}

function FfmpegPanel({ s, setS, save }) {
  const { t } = useT();
  const [status, setStatus] = useState(null);
  const check = useCallback(() => api.get('/ffmpeg/status').then(setStatus).catch(() => { }), []);
  useEffect(() => { check(); }, [check]);
  return (
    <div className="nb-panel">
      <h3>{t('ffmpegStatus')} · {t('transcoding')}</h3>
      <p className="hint" style={{ color: status?.available ? 'var(--mint)' : '#ff9a9a' }}>
        {status ? (status.available ? '✓ ' + t('ffmpegFound') : '✕ ' + t('ffmpegMissing')) : '…'}
      </p>
      <div className="nb-form-row">
        <label>{t('ffmpegPathLbl')}</label>
        <input className="nb-input grow" placeholder="C:\\ffmpeg\\bin" value={s.ffmpegPath || ''}
          onChange={(e) => setS({ ...s, ffmpegPath: e.target.value })}
          onBlur={async () => { await save({ ffmpegPath: s.ffmpegPath }); check(); }} />
        <button className="nb-btn ghost sm" onClick={check}>{I.refresh}</button>
      </div>
    </div>
  );
}

/* ---------- Metadata ---------- */
function MetaTab({ s, setS, save }) {
  const app = useApp();
  const { t } = useT();
  const [keyStatus, setKeyStatus] = useState('');
  const testKey = async () => {
    setKeyStatus('…');
    try { const r = await api.post('/settings/test-tmdb', { key: s.tmdbApiKey }); setKeyStatus(r.ok ? 'ok' : 'bad'); }
    catch { setKeyStatus('bad'); }
  };
  return (
    <div className="nb-panel">
      <h3>TMDB</h3>
      <p className="hint">{t('tmdbHint')}</p>
      <div className="nb-form-row">
        <label>{t('tmdbKey')}</label>
        <input className="nb-input grow" value={s.tmdbApiKey || ''}
          onChange={(e) => { setS({ ...s, tmdbApiKey: e.target.value }); setKeyStatus(''); }}
          onBlur={() => save({ tmdbApiKey: s.tmdbApiKey })} />
        <button className="nb-btn ghost sm" onClick={testKey}>{t('testKey')}</button>
      </div>
      {keyStatus === 'ok' && <div className="nb-note ok" style={{ marginBottom: 10 }}>{t('keyOk')}</div>}
      {keyStatus === 'bad' && <div className="nb-note err" style={{ marginBottom: 10 }}>{t('keyBad')}</div>}
      <div className="nb-form-row">
        <label>{t('tmdbLang')}</label>
        <select className="nb-input" value={s.tmdbLanguage || 'en-US'}
          onChange={(e) => { setS({ ...s, tmdbLanguage: e.target.value }); save({ tmdbLanguage: e.target.value }); }}>
          {['en-US', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'ja-JP'].map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <div className="nb-form-row">
        <label>{t('trendingRefresh')}</label>
        <input className="nb-input" type="number" min="1" style={{ width: 100 }} value={s.trendingRefreshHours}
          onChange={(e) => setS({ ...s, trendingRefreshHours: Number(e.target.value) })}
          onBlur={() => save({ trendingRefreshHours: s.trendingRefreshHours })} />
      </div>
      <div className="nb-form-row">
        <button className="nb-btn ghost sm" onClick={async () => { await api.post('/enrich'); app.toast('✓'); }}>
          {I.refresh} {t('enrichNow')}
        </button>
      </div>
    </div>
  );
}

/* ---------- Playback ---------- */
function PlaybackTab({ s, setS, save, Toggle }) {
  const app = useApp();
  const { t } = useT();
  const p = s.playback || {};
  const os = s.openSubtitles || {};
  const [detect, setDetect] = useState(null);
  const [langsText, setLangsText] = useState((os.langs || ['en']).join(', '));
  const setP = (patch) => { const next = { ...p, ...patch }; setS({ ...s, playback: next }); save({ playback: next }); };
  const setOs = (patch) => setS({ ...s, openSubtitles: { ...os, ...patch } });
  const commitLangs = () => {
    const langs = langsText.split(',').map((x) => x.trim()).filter(Boolean);
    const next = { ...os, langs: langs.length ? langs : ['en'] };
    setS({ ...s, openSubtitles: next });
    save({ openSubtitles: next });
  };

  useEffect(() => {
    const iv = setInterval(() => {
      api.get('/intro/audio-detect-status').then(setDetect).catch(() => { });
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  return (
    <>
      <div className="nb-panel">
        <h3>{t('setPlayback')}</h3>
        <div className="nb-form-row"><label>{t('autoplayNext')}</label><Toggle value={p.autoplayNext !== false} onChange={(v) => setP({ autoplayNext: v })} /></div>
        <div className="nb-form-row"><label>{t('skipIntroAuto')}</label><Toggle value={!!p.skipIntroAuto} onChange={(v) => setP({ skipIntroAuto: v })} /></div>
        <div className="nb-form-row">
          <label>{t('watchedThreshold')}</label>
          <input className="nb-input" type="number" min="50" max="100" style={{ width: 100 }}
            value={Math.round((p.watchedThreshold ?? 0.92) * 100)}
            onChange={(e) => setP({ watchedThreshold: Number(e.target.value) / 100 })} />
        </div>
        <div className="nb-form-row">
          <label>{t('defaultSubLang')}</label>
          <select className="nb-input" value={p.defaultSubtitleLang || 'en'} onChange={(e) => setP({ defaultSubtitleLang: e.target.value })}>
            {['en', 'de', 'fr', 'es', 'it'].map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div className="nb-form-row">
          <label>{t('maxHeight')}</label>
          <select className="nb-input" value={p.maxHeight || 0} onChange={(e) => setP({ maxHeight: Number(e.target.value) })}>
            <option value="0">{t('original')}</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
          </select>
        </div>
        {app.status.ffmpeg && (
          <div className="nb-form-row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <button className="nb-btn ghost sm" disabled={detect?.running}
              onClick={async () => { setDetect({ running: true, done: 0, total: 0 }); await api.post('/intro/audio-detect-all'); }}>
              {I.speed} {detect?.running ? t('introDetecting', { done: detect.done, total: detect.total }) : t('introDetect')}
            </button>
            {detect?.running && (
              <div className="nb-upbar" style={{ flex: 1, minWidth: 160, marginTop: 0 }}>
                <i style={{ width: (detect.total ? Math.round((detect.done / detect.total) * 100) : 0) + '%' }} />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="nb-panel">
        <h3>OpenSubtitles</h3>
        <p className="hint">{t('osHint')}</p>
        <div className="nb-form-row">
          <label>{t('osKey')}</label>
          <input className="nb-input grow" value={os.apiKey || ''}
            onChange={(e) => setOs({ apiKey: e.target.value })}
            onBlur={() => save({ openSubtitles: { ...os } })} />
        </div>
        <div className="nb-form-row">
          <label>{t('osLangs')}</label>
          <input className="nb-input" style={{ width: 180 }} value={langsText}
            onChange={(e) => setLangsText(e.target.value)}
            onBlur={commitLangs} />
        </div>
      </div>
    </>
  );
}

/* ---------- Users ---------- */
const PERMS = ['upload', 'editMedia', 'deleteMedia', 'music', 'images', 'manageUsers', 'settings'];
const PERM_LABELS = { upload: 'permUpload', editMedia: 'permEditMedia', deleteMedia: 'permDeleteMedia', music: 'permMusic', images: 'permImages', manageUsers: 'permManageUsers', settings: 'permSettings' };

function UsersTab({ s, setS, save, Toggle }) {
  const app = useApp();
  const { t } = useT();
  const [users, setUsers] = useState(null);
  const [editing, setEditing] = useState(null); // user object being edited
  const [creating, setCreating] = useState(false);
  const [adminForm, setAdminForm] = useState({ username: '', password: '', email: '' });

  const load = useCallback(() => {
    api.get('/auth/users').then(setUsers).catch(() => setUsers([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const hasAdmin = (users || []).some((u) => u.role === 'admin');

  const toggleAuth = async (v) => {
    if (v && !hasAdmin) { app.toast(t('createAdminFirst'), 'err'); return; }
    setS({ ...s, authEnabled: v });
    await save({ authEnabled: v });
  };

  const createAdmin = async () => {
    try {
      const r = await api.post('/settings/create-admin', adminForm);
      if (r.token) setToken(r.token);
      app.setUser?.(r.user);
      setAdminForm({ username: '', password: '', email: '' });
      load();
      app.toast('✓ ' + t('createAdmin'));
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };

  return (
    <>
      <div className="nb-panel">
        <h3>{t('authEnable')}</h3>
        <p className="hint">{t('authEnableHint')}</p>
        <div className="nb-form-row"><label>{t('authEnable')}</label><Toggle value={!!s.authEnabled} onChange={toggleAuth} /></div>
        <div className="nb-form-row"><label>{t('allowRegistration')}</label>
          <Toggle value={!!s.allowRegistration} onChange={(v) => { setS({ ...s, allowRegistration: v }); save({ allowRegistration: v }); }} /></div>
        {!hasAdmin && (
          <>
            <div className="nb-note" style={{ margin: '10px 0' }}>{t('createAdminFirst')}</div>
            <div className="nb-form-row">
              <input className="nb-input" placeholder={t('username')} value={adminForm.username} onChange={(e) => setAdminForm({ ...adminForm, username: e.target.value })} />
              <input className="nb-input" type="password" placeholder={t('password')} value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} />
              <input className="nb-input" placeholder={t('email')} value={adminForm.email} onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })} />
              <button className="nb-btn play sm" disabled={!adminForm.username || adminForm.password.length < 4} onClick={createAdmin}>{t('createAdmin')}</button>
            </div>
          </>
        )}
      </div>
      <div className="nb-panel">
        <h3>{t('users')}</h3>
        <table className="nb-table">
          <thead><tr><th>{t('username')}</th><th>{t('email')}</th><th>{t('role')}</th><th></th></tr></thead>
          <tbody>
            {(users || []).map((u) => (
              <tr key={u.id}>
                <td><b>{u.username}</b></td>
                <td>{u.email || '—'}</td>
                <td>{u.role === 'admin' ? t('admin') : t('user')}</td>
                <td>
                  <div className="actions">
                    <button className="nb-btn ghost sm" onClick={() => setEditing(u)}>{I.edit}</button>
                    <button className="nb-btn danger sm" disabled={u.id === app.user?.id}
                      onClick={async () => { await api.del('/auth/users/' + u.id); load(); }}>{I.trash}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 14 }}>
          <button className="nb-btn ghost sm" onClick={() => setCreating(true)}>{I.plus} {t('addUser')}</button>
        </div>
      </div>
      {(editing || creating) && (
        <UserEditModal user={editing} onClose={() => { setEditing(null); setCreating(false); load(); }} />
      )}
      {!s.authEnabled && <ProfilesPanel s={s} setS={setS} save={save} Toggle={Toggle} />}
    </>
  );
}

function ProfilesPanel({ s, setS, save, Toggle }) {
  const { t } = useT();
  const [profiles, setProfiles] = useState([]);
  const [name, setName] = useState('');
  const [kid, setKid] = useState(false);
  const load = useCallback(() => api.get('/profiles').then((r) => setProfiles(r.profiles)).catch(() => { }), []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!name.trim()) return;
    await api.post('/profiles', { name: name.trim(), kid, hue: Math.floor(Math.random() * 360) });
    setName(''); setKid(false); load();
  };
  return (
    <div className="nb-panel">
      <h3>{t('manageProfiles')}</h3>
      <p className="hint">{t('profilesHint')} {t('kidHint')}</p>
      <div className="nb-form-row">
        <label>{t('profilesEnable')}</label>
        <Toggle value={!!s.profilesEnabled} onChange={(v) => { setS({ ...s, profilesEnabled: v }); save({ profilesEnabled: v }); }} />
      </div>
      <table className="nb-table">
        <tbody>
          {profiles.map((p) => (
            <tr key={p.id}>
              <td>
                <span style={{
                  display: 'inline-block', width: 22, height: 22, borderRadius: 6, verticalAlign: 'middle', marginRight: 10,
                  background: `oklch(0.82 0.15 ${p.hue})`,
                }} />
                <b>{p.name}</b>
              </td>
              <td>{p.kid ? t('kidProfile') : ''}</td>
              <td>
                <div className="actions">
                  <button className="nb-btn ghost sm" title={t('kidProfile')}
                    onClick={async () => { await api.put('/profiles/' + p.id, { kid: !p.kid }); load(); }}>
                    {p.kid ? I.check : I.user}
                  </button>
                  <button className="nb-btn danger sm" onClick={async () => { await api.del('/profiles/' + p.id); load(); }}>{I.trash}</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="nb-form-row" style={{ marginTop: 12 }}>
        <input className="nb-input" placeholder={t('addProfile')} value={name} onChange={(e) => setName(e.target.value)} />
        <label style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ accentColor: 'var(--mint)' }} checked={kid} onChange={(e) => setKid(e.target.checked)} />
          {t('kidProfile')}
        </label>
        <button className="nb-btn ghost sm" disabled={!name.trim()} onClick={add}>{I.plus} {t('add')}</button>
      </div>
    </div>
  );
}

function UserEditModal({ user, onClose }) {
  const app = useApp();
  const { t } = useT();
  const [form, setForm] = useState({
    username: user?.username || '', email: user?.email || '',
    role: user?.role || 'user', password: '',
    perms: user?.perms || { upload: false, editMedia: false, deleteMedia: false, music: true, images: true, manageUsers: false, settings: false },
  });
  const submit = async () => {
    try {
      if (user) {
        await api.put('/auth/users/' + user.id, {
          role: form.role, perms: form.perms, email: form.email,
          password: form.password || undefined,
        });
      } else {
        await api.post('/auth/users', {
          username: form.username, password: form.password, email: form.email,
          role: form.role, perms: form.perms,
        });
      }
      app.toast('✓ ' + t('save'));
      onClose();
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };
  return (
    <div className="nb-modal-bd" onClick={onClose}>
      <div className="nb-modal" style={{ width: 'min(560px,100%)', padding: 28 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontFamily: 'Archivo', fontWeight: 900, fontSize: 20, margin: '0 0 16px' }}>
          {user ? t('edit') + ': ' + user.username : t('addUser')}
        </h3>
        {!user && (
          <div className="nb-form-row"><input className="nb-input grow" placeholder={t('username')}
            value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
        )}
        <div className="nb-form-row"><input className="nb-input grow" placeholder={t('email')}
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div className="nb-form-row"><input className="nb-input grow" type="password"
          placeholder={user ? t('newPassword') + ' (' + t('optional') + ')' : t('password')}
          value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        <div className="nb-form-row">
          <label>{t('role')}</label>
          <select className="nb-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="user">{t('user')}</option>
            <option value="admin">{t('admin')}</option>
          </select>
        </div>
        {form.role !== 'admin' && (
          <>
            <div className="nb-note" style={{ margin: '10px 0 8px' }}>{t('permissions')}</div>
            <div className="nb-perms">
              {PERMS.map((p) => (
                <label key={p} className="nb-perm" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" style={{ accentColor: 'var(--mint)' }} checked={!!form.perms[p]}
                    onChange={(e) => setForm({ ...form, perms: { ...form.perms, [p]: e.target.checked } })} />
                  {t(PERM_LABELS[p])}
                </label>
              ))}
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="nb-btn play sm" disabled={!user && (!form.username || form.password.length < 4)} onClick={submit}>{t('save')}</button>
          <button className="nb-btn ghost sm" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Email ---------- */
function EmailTab({ s, setS, save, Toggle }) {
  const app = useApp();
  const { t } = useT();
  const smtp = s.smtp || {};
  const [testTo, setTestTo] = useState('');
  const [log, setLog] = useState(null);
  const setSmtp = (patch) => setS({ ...s, smtp: { ...smtp, ...patch } });
  useEffect(() => { api.get('/settings/email-log').then(setLog).catch(() => { }); }, []);

  const sendTest = async () => {
    try {
      const r = await api.post('/settings/test-email', { to: testTo || undefined });
      app.toast(r.ok ? t('testSent') : t('testFailed', { err: r.error }), r.ok ? 'ok' : 'err');
      api.get('/settings/email-log').then(setLog).catch(() => { });
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };

  return (
    <>
      <div className="nb-panel">
        <h3>SMTP</h3>
        <div className="nb-form-row">
          <label>{t('smtpHost')}</label>
          <input className="nb-input grow" value={smtp.host || ''} onChange={(e) => setSmtp({ host: e.target.value })} onBlur={() => save({ smtp })} />
          <input className="nb-input" style={{ width: 90 }} type="number" value={smtp.port || 587}
            onChange={(e) => setSmtp({ port: Number(e.target.value) })} onBlur={() => save({ smtp })} />
        </div>
        <div className="nb-form-row">
          <label>{t('smtpSecure')}</label>
          <Toggle value={!!smtp.secure} onChange={(v) => { setSmtp({ secure: v }); save({ smtp: { ...smtp, secure: v } }); }} />
        </div>
        <div className="nb-form-row">
          <label>{t('smtpUser')}</label>
          <input className="nb-input grow" value={smtp.user || ''} onChange={(e) => setSmtp({ user: e.target.value })} onBlur={() => save({ smtp })} />
        </div>
        <div className="nb-form-row">
          <label>{t('smtpPass')}</label>
          <input className="nb-input grow" type="password" value={smtp.pass || ''} onChange={(e) => setSmtp({ pass: e.target.value })} onBlur={() => save({ smtp })} />
        </div>
        <div className="nb-form-row">
          <label>{t('smtpFrom')}</label>
          <input className="nb-input grow" value={smtp.from || ''} onChange={(e) => setSmtp({ from: e.target.value })} onBlur={() => save({ smtp })} />
        </div>
        <div className="nb-form-row">
          <label>{t('notifyNewMedia')}</label>
          <Toggle value={!!s.notifyOnNewMedia} onChange={(v) => { setS({ ...s, notifyOnNewMedia: v }); save({ notifyOnNewMedia: v }); }} />
        </div>
        <div className="nb-form-row">
          <input className="nb-input" style={{ width: 240 }} placeholder={t('email')} value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button className="nb-btn ghost sm" onClick={sendTest}>{I.mail} {t('sendTest')}</button>
        </div>
      </div>
      {log?.length > 0 && (
        <div className="nb-panel">
          <h3>{t('emailLog')}</h3>
          <table className="nb-table">
            <thead><tr><th>{t('email')}</th><th>Subject</th><th>OK</th><th>Date</th></tr></thead>
            <tbody>
              {log.slice(0, 10).map((l) => (
                <tr key={l.id}>
                  <td>{l.recipient}</td><td>{l.subject}</td>
                  <td>{l.ok ? '✓' : <span style={{ color: '#ff9a9a' }} title={l.error}>✕</span>}</td>
                  <td className="nb-note">{new Date(l.sent_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ---------- Backup ---------- */
function BackupTab({ s, setS, save, Toggle }) {
  const app = useApp();
  const { t } = useT();
  const sched = s.backupSchedule || {};
  const setSched = (patch) => {
    const next = { ...sched, ...patch };
    setS({ ...s, backupSchedule: next });
    save({ backupSchedule: next });
  };
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/backups').then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try { await api.post('/backups'); load(); app.toast('✓ ' + t('createBackup')); }
    catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
    setBusy(false);
  };

  const restore = async (name) => {
    if (!window.confirm(t('restoreConfirm'))) return;
    try {
      await api.post(`/backups/${encodeURIComponent(name)}/restore`);
      app.toast(t('restoreDone'));
      setTimeout(() => location.reload(), 4000);
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };

  const uploadRestore = async (file) => {
    if (!window.confirm(t('restoreConfirm'))) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.post('/backups/upload', fd);
      app.toast(t('restoreDone'));
      setTimeout(() => location.reload(), 4000);
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };

  return (
    <div className="nb-panel">
      <h3>{t('backups')}</h3>
      <p className="hint">{t('backupHint')}</p>
      <div className="nb-form-row">
        <label>{t('autoBackup')}</label>
        <Toggle value={!!sched.enabled} onChange={(v) => setSched({ enabled: v })} />
        <label style={{ minWidth: 0 }}>{t('backupEvery')}</label>
        <input className="nb-input" type="number" min="1" style={{ width: 80 }} value={sched.intervalHours ?? 24}
          onChange={(e) => setSched({ intervalHours: Number(e.target.value) })} />
        <label style={{ minWidth: 0 }}>{t('backupKeep')}</label>
        <input className="nb-input" type="number" min="1" style={{ width: 80 }} value={sched.keep ?? 7}
          onChange={(e) => setSched({ keep: Number(e.target.value) })} />
      </div>
      <div className="nb-form-row">
        <button className="nb-btn play sm" disabled={busy} onClick={create}>{I.db} {t('createBackup')}</button>
        <label className="nb-btn ghost sm" style={{ cursor: 'pointer' }}>
          {I.upload} {t('uploadBackup')}
          <input type="file" accept=".zip" hidden onChange={(e) => e.target.files[0] && uploadRestore(e.target.files[0])} />
        </label>
      </div>
      <table className="nb-table">
        <tbody>
          {(list || []).map((b) => (
            <tr key={b.name}>
              <td style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12 }}>{b.name}</td>
              <td className="nb-note">{fmtBytes(b.size)}</td>
              <td className="nb-note">{new Date(b.createdAt).toLocaleString()}</td>
              <td>
                <div className="actions">
                  <a className="nb-btn ghost sm" href={`/api/backups/${encodeURIComponent(b.name)}/download`} download>{I.download}</a>
                  <button className="nb-btn ghost sm" onClick={() => restore(b.name)}>{I.refresh} {t('restore')}</button>
                  <button className="nb-btn danger sm" onClick={async () => { await api.del('/backups/' + encodeURIComponent(b.name)); load(); }}>{I.trash}</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Statistics ---------- */
function Bar({ frac }) {
  return (
    <div style={{ height: 8, borderRadius: 5, background: 'rgba(255,255,255,.1)', overflow: 'hidden', flex: 1 }}>
      <div style={{ width: Math.max(2, Math.round(frac * 100)) + '%', height: '100%', background: 'var(--mint)' }} />
    </div>
  );
}

function StatsTab() {
  const { t } = useT();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/stats/dashboard').then(setD).catch(() => setD({})); }, []);
  if (!d) return <div className="nb-empty">{t('loading')}</div>;
  const maxWatch = Math.max(1, ...(d.watchTime || []).map((w) => w.secs));
  const maxGenre = Math.max(1, ...(d.topGenres || []).map((g) => g.secs));
  const maxGrowth = Math.max(1, ...(d.growth || []).map((g) => g.added));
  return (
    <>
      {d.watchTime?.length > 0 && (
        <div className="nb-panel">
          <h3>{t('watchTimeBy')}</h3>
          {d.watchTime.map((w) => (
            <div key={w.name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <span style={{ width: 120, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.name}</span>
              <Bar frac={w.secs / maxWatch} />
              <span className="nb-note" style={{ width: 90, textAlign: 'right' }}>{(w.secs / 3600).toFixed(1)} {t('hours')} · {w.titles}</span>
            </div>
          ))}
        </div>
      )}
      {d.mostWatched?.length > 0 && (
        <div className="nb-panel">
          <h3>{t('mostWatched')}</h3>
          <table className="nb-table">
            <tbody>
              {d.mostWatched.map((m, i) => (
                <tr key={m.id}>
                  <td style={{ width: 30, fontFamily: "'Archivo Black',sans-serif", color: 'var(--muted)' }}>{i + 1}</td>
                  <td><b>{m.title}</b></td>
                  <td className="nb-note">{m.type}</td>
                  <td className="nb-note" style={{ textAlign: 'right' }}>{m.plays} {t('plays')} · {m.completions || 0} ✓</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.topGenres?.length > 0 && (
        <div className="nb-panel">
          <h3>{t('topGenres')}</h3>
          {d.topGenres.map((g) => (
            <div key={g.genre} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <span style={{ width: 120, fontSize: 13.5 }}>{g.genre}</span>
              <Bar frac={g.secs / maxGenre} />
              <span className="nb-note" style={{ width: 70, textAlign: 'right' }}>{(g.secs / 3600).toFixed(1)} {t('hours')}</span>
            </div>
          ))}
        </div>
      )}
      {d.growth?.length > 0 && (
        <div className="nb-panel">
          <h3>{t('libGrowth')}</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120, paddingTop: 8 }}>
            {d.growth.map((g) => (
              <div key={g.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
                <span className="nb-note">{g.added}</span>
                <div style={{ width: '100%', maxWidth: 42, borderRadius: '5px 5px 0 0', background: 'var(--mint)', height: Math.max(3, (g.added / maxGrowth) * 80) + 'px', opacity: .85 }} />
                <span className="nb-note" style={{ fontSize: 10 }}>{g.month.slice(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- Offline downloads ---------- */
function OfflinePanel({ s, setS, save, Toggle }) {
  const { t } = useT();
  const [st, setSt] = useState(null);
  const [browsing, setBrowsing] = useState(false);
  const poll = useCallback(() => api.get('/offline/status').then(setSt).catch(() => { }), []);
  useEffect(() => { poll(); const iv = setInterval(poll, 3000); return () => clearInterval(iv); }, [poll]);
  const downloadAll = async () => { try { await api.post('/offline/download-all'); poll(); } catch { } };
  return (
    <div className="nb-panel">
      <h3>{t('offlineTitle')}</h3>
      <p className="hint">{t('offlineHint')}</p>
      <div className="nb-form-row">
        <label>{t('offlineEnable')}</label>
        <Toggle value={!!s.offlineMode} onChange={(v) => { setS({ ...s, offlineMode: v }); save({ offlineMode: v }); }} />
      </div>
      <div className="nb-form-row">
        <label>{t('offlinePathLbl')}</label>
        <input className="nb-input grow" placeholder={st?.dir || 'data/offline'} value={s.offlinePath || ''}
          onChange={(e) => setS({ ...s, offlinePath: e.target.value })}
          onBlur={() => save({ offlinePath: s.offlinePath })} />
        <button className="nb-btn ghost sm" onClick={() => setBrowsing(true)}>{I.folder} {t('browse')}</button>
      </div>
      <div className="nb-form-row">
        <label>{t('ytdlpPathLbl')}</label>
        <input className="nb-input grow" placeholder="yt-dlp  ·  C:\\tools\\yt-dlp.exe" value={s.ytdlpPath || ''}
          onChange={(e) => setS({ ...s, ytdlpPath: e.target.value })}
          onBlur={() => save({ ytdlpPath: s.ytdlpPath })} />
      </div>
      <p className="hint" style={{ color: st?.ytdlp ? 'var(--mint)' : '#ffcf8a' }}>
        {st ? (st.ytdlp ? '✓ ' + t('ytdlpFound') : '• ' + t('ytdlpMissing')) : '…'}
      </p>
      <div className="nb-form-row">
        <button className="nb-btn play sm" onClick={downloadAll}>{I.download} {t('offlineDownloadAll')}</button>
        {st?.running && (
          <span className="nb-note">{t('offlineProgress', {
            title: st.current?.title || '', pct: Math.round(st.current?.pct || 0), pending: st.pending,
          })}</span>
        )}
      </div>
      {browsing && <FolderBrowser onClose={() => setBrowsing(false)}
        onPick={(p) => { setS({ ...s, offlinePath: p }); save({ offlinePath: p }); }} />}
    </div>
  );
}

/* ---------- Advanced ---------- */
function AdvancedTab({ s, setS, save, Toggle }) {
  const { t } = useT();
  const [json, setJson] = useState(() => JSON.stringify({ ui: s.ui, playback: s.playback, introDefault: s.introDefault }, null, 2));
  const [err, setErr] = useState('');
  const apply = () => {
    try {
      const v = JSON.parse(json);
      save(v);
      setErr('');
    } catch (e) { setErr(String(e.message)); }
  };
  const hostClean = String(s.localHostname || 'nebula').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'nebula';
  return (
    <>
      <OfflinePanel s={s} setS={setS} save={save} Toggle={Toggle} />
      <div className="nb-panel">
        <h3>{t('localAccess')}</h3>
        <p className="hint">{t('localAccessHint')}</p>
        <div className="nb-form-row">
          <label>{t('localAccess')}</label>
          <Toggle value={s.mdnsEnabled !== false} onChange={(v) => { setS({ ...s, mdnsEnabled: v }); save({ mdnsEnabled: v }); }} />
        </div>
        <div className="nb-form-row">
          <label>{t('localHostname')}</label>
          <input className="nb-input grow" value={s.localHostname ?? 'nebula'}
            onChange={(e) => setS({ ...s, localHostname: e.target.value })}
            onBlur={() => save({ localHostname: hostClean })} />
          <span className="nb-note">.local</span>
        </div>
        {s.mdnsEnabled !== false && (
          <div className="nb-note ok">→ http://{hostClean}.local{location.port ? ':' + location.port : ''}</div>
        )}
      </div>
      <div className="nb-panel">
        <h3>{t('dlnaEnable')}</h3>
        <p className="hint">{t('dlnaHint')}</p>
        <div className="nb-form-row">
          <label>{t('dlnaEnable')}</label>
          <Toggle value={!!s.dlnaEnabled} onChange={(v) => { setS({ ...s, dlnaEnabled: v }); save({ dlnaEnabled: v }); }} />
        </div>
        <div className="nb-form-row">
          <label>{t('cleanNames')}</label>
          <Toggle value={s.uploadCleanNames !== false} onChange={(v) => { setS({ ...s, uploadCleanNames: v }); save({ uploadCleanNames: v }); }} />
        </div>
      </div>
      <div className="nb-panel">
        <h3>{t('setAdvanced')}</h3>
        <p className="hint">{t('advancedHint')}</p>
        <textarea className="nb-input" style={{ width: '100%', minHeight: 260 }} value={json} onChange={(e) => setJson(e.target.value)} />
        {err && <div className="nb-note err" style={{ margin: '8px 0' }}>{err}</div>}
        <div style={{ marginTop: 10 }}>
          <button className="nb-btn play sm" onClick={apply}>{t('save')}</button>
        </div>
      </div>
    </>
  );
}
