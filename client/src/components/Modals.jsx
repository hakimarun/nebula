// UploadModal (file upload with progress) + AddStreamModal (external platforms).
import React, { useState, useRef } from 'react';
import { api, getToken } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';

export function UploadModal({ onClose }) {
  const app = useApp();
  const { t } = useT();
  const [kind, setKind] = useState('movie');
  const [seriesTitle, setSeriesTitle] = useState('');
  const [season, setSeason] = useState(1);
  const [files, setFiles] = useState([]);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState(-1);
  const [done, setDone] = useState(false);
  const inputRef = useRef(null);

  const KINDS = [['movie', 'kindMovie'], ['episode', 'kindEpisode'], ['track', 'kindTrack'], ['image', 'kindImage']];

  const start = () => {
    if (!files.length) return;
    const fd = new FormData();
    fd.append('kind', kind);
    if (kind === 'episode') { fd.append('seriesTitle', seriesTitle); fd.append('season', String(season)); }
    for (const f of files) fd.append('files', f);
    // XHR for upload progress events
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    if (getToken()) xhr.setRequestHeader('Authorization', 'Bearer ' + getToken());
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status < 300) { setDone(true); setProgress(100); app.toast(t('uploadDone')); app.refreshHome(); }
      else app.toast(t('testFailed', { err: xhr.statusText }), 'err');
    };
    xhr.onerror = () => app.toast(t('error'), 'err');
    setProgress(0);
    xhr.send(fd);
  };

  return (
    <div className="nb-modal-bd" onClick={onClose}>
      <div className="nb-modal" style={{ width: 'min(560px,100%)', padding: 28 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontFamily: 'Archivo', fontWeight: 900, fontSize: 20, margin: '0 0 14px' }}>{t('uploadTitle')}</h3>
        <div className="nb-form-row">
          <label>{t('uploadKind')}</label>
          <div className="nb-seasons" style={{ marginBottom: 0 }}>
            {KINDS.map(([k, label]) => (
              <button key={k} className={'nb-season-btn' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{t(label)}</button>
            ))}
          </div>
        </div>
        {kind === 'episode' && (
          <div className="nb-form-row">
            <input className="nb-input grow" placeholder={t('seriesName')} value={seriesTitle} onChange={(e) => setSeriesTitle(e.target.value)} />
            <label style={{ minWidth: 0 }}>{t('seasonNo')}</label>
            <input className="nb-input" type="number" min="0" style={{ width: 80 }} value={season} onChange={(e) => setSeason(e.target.value)} />
          </div>
        )}
        <div className={'nb-drop' + (over ? ' over' : '')}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); setFiles([...e.dataTransfer.files]); }}>
          {files.length
            ? <div>{files.map((f) => <div key={f.name} style={{ fontSize: 13 }}>{f.name} · {(f.size / 1048576).toFixed(1)} MB</div>)}</div>
            : <>{I.upload}<div style={{ marginTop: 8 }}>{t('dropFiles')}</div></>}
          <input ref={inputRef} type="file" multiple hidden onChange={(e) => setFiles([...e.target.files])} />
        </div>
        {progress >= 0 && (
          <>
            <div className="nb-upbar"><i style={{ width: progress + '%' }} /></div>
            <div className="nb-note" style={{ marginTop: 8 }}>{done ? t('uploadDone') : t('uploading', { p: progress })}</div>
          </>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          {!done
            ? <button className="nb-btn play sm" disabled={!files.length || progress >= 0 || (kind === 'episode' && !seriesTitle.trim())} onClick={start}>{I.upload} {t('upload')}</button>
            : null}
          <button className="nb-btn ghost sm" onClick={onClose}>{done ? t('close') : t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

export function AddStreamModal({ onClose }) {
  const app = useApp();
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [url, setUrl] = useState('');
  const [type, setType] = useState('movie');
  const [source, setSource] = useState('auto');
  const [enrich, setEnrich] = useState(true);
  const [busy, setBusy] = useState(false);

  const SOURCES = ['auto', 'youtube', 'vimeo', 'dailymotion', 'streamtape', 'voe', 'vizoa', 'url'];
  const detect = (u) =>
    /youtu/.test(u) ? 'youtube' : /vimeo/.test(u) ? 'vimeo' : /dai(lymotion|\.ly)/.test(u) ? 'dailymotion'
      : /streamtape/.test(u) ? 'streamtape' : /voe\./.test(u) ? 'voe' : /vizoa\./.test(u) ? 'vizoa' : 'url';

  const add = async () => {
    setBusy(true);
    try {
      await api.post('/media', {
        type, title: title.trim() || undefined, year: year ? Number(year) : undefined,
        source: source === 'auto' ? detect(url) : source,
        externalUrl: url.trim(), enrich,
      });
      app.toast('✓ ' + t('add'));
      app.refreshHome();
      onClose();
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
    setBusy(false);
  };

  return (
    <div className="nb-modal-bd" onClick={onClose}>
      <div className="nb-modal" style={{ width: 'min(560px,100%)', padding: 28 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontFamily: 'Archivo', fontWeight: 900, fontSize: 20, margin: '0 0 6px' }}>{t('streamTitle')}</h3>
        <p className="nb-note" style={{ marginBottom: 16 }}>{t('streamHintAuto')}</p>
        <div className="nb-form-row"><input className="nb-input grow" autoFocus placeholder={t('streamUrl')} value={url} onChange={(e) => setUrl(e.target.value)} /></div>
        <div className="nb-form-row">
          <input className="nb-input grow" placeholder={t('titleAuto')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className="nb-input" style={{ width: 110 }} placeholder={t('yearAuto')} value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
        <div className="nb-form-row">
          <label>{t('streamSource')}</label>
          <select className="nb-input" value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label style={{ minWidth: 0 }}>{t('streamKind')}</label>
          <select className="nb-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="movie">{t('kindMovie')}</option>
            <option value="track">{t('kindTrack')}</option>
          </select>
        </div>
        {app.status.hasTmdb && type === 'movie' && (
          <div className="nb-form-row">
            <button className={'nb-toggle' + (enrich ? ' on' : '')} onClick={() => setEnrich(!enrich)}><i /></button>
            <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>{t('fetchMeta')}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="nb-btn play sm" disabled={busy || !url.trim()} onClick={add}>{I.plus} {t('add')}</button>
          <button className="nb-btn ghost sm" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}
