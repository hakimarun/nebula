// PathList — editable list of library folders with a server-side folder browser.
import React, { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';

export function FolderBrowser({ onPick, onClose }) {
  const { t } = useT();
  const [cur, setCur] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/fs?path=' + encodeURIComponent(cur))
      .then((d) => { setData(d); setErr(''); })
      .catch((e) => setErr(e.message));
  }, [cur]);

  return (
    <div className="nb-modal-bd" style={{ zIndex: 110 }} onClick={onClose}>
      <div className="nb-modal" style={{ width: 'min(520px,100%)', padding: 24 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontFamily: 'Archivo', fontWeight: 900, fontSize: 18, margin: '0 0 12px' }}>{t('browse')}</h3>
        <div className="nb-form-row">
          <input className="nb-input grow" value={cur} placeholder="\\NAS\media  ·  D:\movies"
            onChange={(e) => setCur(e.target.value)} />
        </div>
        {err && <div className="nb-note err" style={{ marginBottom: 8 }}>{err}</div>}
        <div className="nb-fs">
          {data?.parent != null && <button onClick={() => setCur(data.parent)}>{I.chevL} ..</button>}
          {cur && <button onClick={() => setCur('')}>{I.chevL} {'(drives)'}</button>}
          {(data?.entries || []).map((e) => (
            <button key={e.path} onClick={() => setCur(e.path)}>{I.folder} {e.name}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className="nb-btn play sm" disabled={!cur} onClick={() => { onPick(cur); onClose(); }}>{t('select')}</button>
          <button className="nb-btn ghost sm" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

export function PathList({ label, paths, onChange }) {
  const { t } = useT();
  const [browsing, setBrowsing] = useState(false);
  const [manual, setManual] = useState('');
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 8 }}>{label}</div>
      <div className="nb-pathlist">
        {(paths || []).map((p) => (
          <div key={p} className="nb-path">
            {I.folder}<span style={{ wordBreak: 'break-all' }}>{p}</span>
            <button className="x" onClick={() => onChange(paths.filter((x) => x !== p))}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="nb-input grow" placeholder={t('pathHint')} value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && manual.trim()) { onChange([...(paths || []), manual.trim()]); setManual(''); } }} />
        <button className="nb-btn ghost sm" onClick={() => {
          if (manual.trim()) { onChange([...(paths || []), manual.trim()]); setManual(''); }
          else setBrowsing(true);
        }}>{manual.trim() ? I.plus : I.folder} {manual.trim() ? t('addPath') : t('browse')}</button>
      </div>
      {browsing && <FolderBrowser onClose={() => setBrowsing(false)}
        onPick={(p) => onChange([...(paths || []), p])} />}
    </div>
  );
}
