// Cast to a DLNA renderer (TV / speaker). CastButton lists renderers and starts
// playback on the device; CastBar is the global remote (play/pause/seek/stop).
import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';
import { fmtTime } from '../util.js';

export function CastButton({ media, className, onCasting }) {
  const app = useApp();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [renderers, setRenderers] = useState(null);
  const ref = useRef(null);

  const openMenu = async () => {
    setOpen(true);
    setRenderers(null);
    try { setRenderers(await api.get('/cast/renderers')); } catch { setRenderers([]); }
  };
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);

  const pick = async (r) => {
    setOpen(false);
    const ok = await app.startCast(media, r);
    if (ok && onCasting) onCasting();
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button className={className || 'nb-btn ghost'} onClick={openMenu}>{I.cast} {t('cast')}</button>
      {open && (
        <div className="nb-menu nb-castmenu">
          <div className="k">{t('castTo')}</div>
          {renderers === null && <div className="nb-note" style={{ padding: '8px 12px' }}>{t('castSearching')}</div>}
          {renderers && renderers.length === 0 && <div className="nb-note" style={{ padding: '10px 12px', lineHeight: 1.5 }}>{t('castNone')}</div>}
          {(renderers || []).map((r) => (
            <button key={r.id} onClick={() => pick(r)}>
              {I.tv}<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
              <span className="nb-castproto">{r.proto === 'gcast' ? 'Cast' : 'DLNA'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Device picker opened from the context menu's "Play on…". */
export function CastPicker({ media, onClose }) {
  const app = useApp();
  const { t } = useT();
  const [renderers, setRenderers] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/cast/renderers').then((r) => alive && setRenderers(r)).catch(() => alive && setRenderers([]));
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => { alive = false; window.removeEventListener('keydown', key); };
  }, [onClose]);
  const pick = async (r) => { onClose(); await app.startCast(media, r); };
  return (
    <div className="nb-modal-bd" style={{ zIndex: 130 }} onClick={onClose}>
      <div className="nb-modal" style={{ width: 'min(420px,100%)', padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontFamily: 'Archivo', fontWeight: 900, fontSize: 18, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>{I.cast} {t('castTo')}</h3>
        <div className="nb-note" style={{ marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{media.title}</div>
        {renderers === null && <div className="nb-note" style={{ padding: '8px 0' }}>{t('castSearching')}</div>}
        {renderers && !renderers.length && <div className="nb-note" style={{ padding: '8px 0', lineHeight: 1.5 }}>{t('castNone')}</div>}
        <div className="nb-castlist">
          {(renderers || []).map((r) => (
            <button key={r.id} className="nb-castrow" onClick={() => pick(r)}>
              {I.tv}<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
              <span className="nb-castproto">{r.proto === 'gcast' ? 'Cast' : 'DLNA'}</span>
            </button>
          ))}
        </div>
        <div style={{ marginTop: 16 }}><button className="nb-btn ghost sm" onClick={onClose}>{t('cancel')}</button></div>
      </div>
    </div>
  );
}

export function CastBar() {
  const app = useApp();
  const { t } = useT();
  const c = app.casting;
  const [st, setSt] = useState({ state: '', position: 0, duration: 0, volume: null });
  const [vol, setVol] = useState(null);
  const [nextEp, setNextEp] = useState(null);   // next episode to auto-cast when this one ends
  const volTimer = useRef(0);
  const nearEnd = useRef(false);
  const advancing = useRef(false);

  useEffect(() => {
    if (!c) return;
    let alive = true;
    const poll = () => api.get('/cast/status?renderer=' + encodeURIComponent(c.renderer.id))
      .then((s) => { if (alive) setSt(s); }).catch(() => { });
    poll();
    const iv = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [c]);
  // adopt the device's volume the first time we learn it
  useEffect(() => { setVol((v) => (v == null && st.volume != null ? st.volume : v)); }, [st.volume]);

  // learn the next episode (if this is a series episode) for auto-advance
  const castId = c?.media.id;
  useEffect(() => {
    nearEnd.current = false; advancing.current = false; setNextEp(null);
    if (castId == null) return;
    let alive = true;
    api.get('/media/' + castId).then((d) => { if (alive) setNextEp(d.nextEpisode || null); }).catch(() => { });
    return () => { alive = false; };
  }, [castId]);

  // when the casted episode finishes, start the next one on the same device
  useEffect(() => {
    if (!c) return;
    const d = st.duration || 0;
    const isPlaying = st.state === 'PLAYING' || st.state === 'TRANSITIONING';
    if (isPlaying && d > 0 && st.position >= d - 15) nearEnd.current = true;
    const stopped = ['STOPPED', 'IDLE', 'UNKNOWN', ''].includes(st.state);
    const autoNext = app.status?.playback?.autoplayNext !== false;
    if (nearEnd.current && stopped && autoNext && nextEp && !advancing.current) {
      advancing.current = true;
      app.startCast(nextEp, c.renderer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, nextEp]);

  if (!c) return null;
  const playing = st.state === 'PLAYING' || st.state === 'TRANSITIONING';
  const dur = st.duration || 0;
  const ctrl = (action, extra) => api.post('/cast/control', { renderer: c.renderer.id, action, ...extra }).catch(() => { });
  const changeVol = (v) => {
    setVol(v);
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(() => ctrl('volume', { volume: v }), 120); // throttle during drag
  };
  const shownVol = vol == null ? 100 : vol;

  return (
    <div className="nb-cast-bar">
      <span className="ic">{I.cast}</span>
      <div className="np-info">
        <div className="np-t">{c.media.title}</div>
        <div className="np-a">{t('castingTo', { name: c.renderer.name })}{dur ? ` · ${fmtTime(st.position)} / ${fmtTime(dur)}` : ''}</div>
      </div>
      <button className="nb-cbtn" onClick={() => ctrl(playing ? 'pause' : 'play')} title={playing ? t('pause') : t('play')}>
        {playing ? I.pause : I.play}
      </button>
      <input type="range" className="nb-cast-seek" min="0" max={dur || 0} step="1"
        value={Math.min(st.position, dur || 0)} disabled={!dur}
        onChange={(e) => { setSt((s) => ({ ...s, position: Number(e.target.value) })); }}
        onMouseUp={(e) => ctrl('seek', { position: Number(e.target.value) })}
        onTouchEnd={(e) => ctrl('seek', { position: Number(e.target.value) })} />
      {c.renderer.hasVolume !== false && (
        <div className="nb-cast-vol">
          <button className="nb-cbtn" title={t('mute')} onClick={() => changeVol(shownVol > 0 ? 0 : 50)}>{shownVol === 0 ? I.mute : I.volume}</button>
          <input type="range" min="0" max="100" step="1" value={shownVol}
            onChange={(e) => changeVol(Number(e.target.value))} />
        </div>
      )}
      <button className="nb-cbtn" title={t('stopCast')} onClick={() => app.stopCast()}>{I.x}</button>
    </div>
  );
}
