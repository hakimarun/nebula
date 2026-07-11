import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api, withToken, thumbUrl } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';
import { parseEmbed, fmtTime } from '../util.js';
import { buildMediaMenu } from './ContextMenu.jsx';

function Cover({ track, size = 42, radius = 8 }) {
  // local generated thumb (if downloaded) -> remote artwork (poster, e.g.
  // SoundCloud/YouTube) -> music icon. Streams without a local file fall back
  // to their artwork instead of showing nothing.
  const chain = [];
  if (track) {
    if (track.path) chain.push(thumbUrl(track.id, track.updatedAt));
    if (track.poster) chain.push(track.poster);
    if (!chain.length) chain.push(thumbUrl(track.id, track.updatedAt));
  }
  const key = chain.join('|');
  const [stage, setStage] = useState(0);
  useEffect(() => { setStage(0); }, [key]);
  if (!track || stage >= chain.length) {
    return <div className="art" style={{ width: size, height: size, borderRadius: radius }}>{I.music}</div>;
  }
  return <img src={chain[stage]} alt="" onError={() => setStage(stage + 1)}
    style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', flex: '0 0 auto' }} />;
}

export default function MusicView() {
  const app = useApp();
  const { t } = useT();
  const [tracks, setTracks] = useState(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState('albums'); // albums | tracks
  const [openAlbum, setOpenAlbum] = useState(null);
  const [queue, setQueue] = useState([]);       // array of track objects
  const [qIndex, setQIndex] = useState(-1);
  const [embed, setEmbed] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState(false);   // fullscreen now-playing (mobile)
  const [playing, setPlaying] = useState(false);
  const [prog, setProg] = useState({ t: 0, d: 0 });
  const audioRef = useRef(null);

  const load = () => api.get('/library?type=track').then(setTracks).catch(() => setTracks([]));
  useEffect(() => { load(); }, [app.mediaVersion]); // reload when media changes (e.g. new thumbnail)

  const filtered = useMemo(() => {
    if (!tracks) return [];
    const n = filter.toLowerCase();
    return tracks.filter((x) =>
      !n || x.title.toLowerCase().includes(n) || (x.artist || '').toLowerCase().includes(n) || (x.album || '').toLowerCase().includes(n));
  }, [tracks, filter]);

  const albums = useMemo(() => {
    const map = new Map();
    for (const tr of filtered) {
      const key = (tr.artist || '?') + '||' + (tr.album || '?');
      if (!map.has(key)) map.set(key, { artist: tr.artist, album: tr.album, tracks: [] });
      map.get(key).tracks.push(tr);
    }
    for (const a of map.values()) a.tracks.sort((x, y) => (x.episode || 0) - (y.episode || 0) || x.title.localeCompare(y.title));
    return [...map.values()].sort((a, b) => String(a.artist).localeCompare(String(b.artist)));
  }, [filtered]);

  const current = qIndex >= 0 ? queue[qIndex] : null;

  // a track plays through the built-in audio element when it is a local file OR
  // an external stream that has been saved offline (source != local, but path set)
  const playsLocally = (x) => x.source === 'local' || !!x.path;

  const playQueue = useCallback((list, startIdx = 0) => {
    const locals = list.filter(playsLocally);
    const target = list[startIdx];
    if (target && !playsLocally(target)) {
      const e = parseEmbed(target.source, target.externalUrl);
      setEmbed(e ? { title: target.title, artist: target.artist, embed: e } : null);
      return;
    }
    const idx = locals.indexOf(target);
    setEmbed(null);
    setQueue(locals);
    setQIndex(Math.max(0, idx));
    setTimeout(() => audioRef.current?.play().catch(() => { }), 120);
  }, []);

  const shuffleAll = () => {
    const locals = filtered.filter(playsLocally);
    const shuffled = [...locals].sort(() => Math.random() - 0.5);
    if (shuffled.length) { setQueue(shuffled); setQIndex(0); setEmbed(null); }
  };

  const step = (dir) => {
    setQIndex((i) => {
      const nx = i + dir;
      return nx >= 0 && nx < queue.length ? nx : i;
    });
    setTimeout(() => audioRef.current?.play().catch(() => { }), 120);
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => { }); else a.pause();
  };
  const seekTo = (frac) => {
    const a = audioRef.current;
    if (a && prog.d) a.currentTime = Math.max(0, Math.min(1, frac)) * prog.d;
  };
  const rowMenu = (tr) => (e) => {
    e.stopPropagation();
    app.openCtxMenu?.(e, buildMediaMenu(app, t, tr, () => { load(); app.refreshHome(); }));
  };

  if (!tracks) return <div className="nb-empty">{t('loading')}</div>;

  return (
    <div className="nb-rows" style={{ paddingTop: 30, minHeight: '60vh', paddingBottom: current ? 150 : undefined }}>
      <div className="nb-row-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h2>{t('musicLib')}</h2>
        <span className="sub">{tracks.length} {t('tracks')}</span>
        <span style={{ flex: 1 }} />
        <div className="nb-seasons" style={{ marginBottom: 0 }}>
          <button className={'nb-season-btn' + (view === 'albums' ? ' on' : '')} onClick={() => { setView('albums'); setOpenAlbum(null); }}>{t('albums')}</button>
          <button className={'nb-season-btn' + (view === 'tracks' ? ' on' : '')} onClick={() => setView('tracks')}>{t('allTracks')}</button>
        </div>
        <button className="nb-btn ghost sm" onClick={shuffleAll}>{I.refresh} {t('shuffle')}</button>
        <input className="nb-input" style={{ width: 170, padding: '8px 12px' }} placeholder={t('search') + '…'}
          value={filter} onChange={(e) => setFilter(e.target.value)} />
        {app.can('editMedia') && (
          <button className="nb-btn ghost sm" onClick={() => setShowAdd(true)}>{I.plus} {t('addMusic')}</button>
        )}
      </div>

      {view === 'albums' && !openAlbum && (
        <div className="nb-imgrid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {albums.map((a) => (
            <div key={(a.artist || '') + (a.album || '')} style={{ cursor: 'pointer' }} onClick={() => setOpenAlbum(a)}>
              <div className="im" style={{ marginBottom: 8 }}>
                <Cover track={a.tracks[0]} size="100%" radius={10} />
              </div>
              <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.album || '—'}</div>
              <div className="nb-note" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.artist || '—'} · {a.tracks.length}</div>
            </div>
          ))}
          {!albums.length && <div className="nb-empty" style={{ gridColumn: '1/-1' }}>{t('emptyLibrary')}</div>}
        </div>
      )}

      {view === 'albums' && openAlbum && (
        <div className="nb-listpad">
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 16 }}>
            <button className="nb-btn ghost sm" onClick={() => setOpenAlbum(null)}>{I.chevL} {t('backBtn')}</button>
            <Cover track={openAlbum.tracks[0]} size={72} radius={12} />
            <div>
              <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 900, fontSize: 20 }}>{openAlbum.album || '—'}</div>
              <div className="nb-note">{openAlbum.artist} · {openAlbum.tracks.length} {t('tracks')}</div>
            </div>
            <button className="nb-btn play sm" onClick={() => playQueue(openAlbum.tracks, 0)}>{I.play} {t('play')}</button>
          </div>
          {openAlbum.tracks.map((tr, i) => (
            <div key={tr.id} className={'nb-music-row' + (current?.id === tr.id ? ' on' : '')} onClick={() => playQueue(openAlbum.tracks, i)}
              onContextMenu={(e) => app.openCtxMenu?.(e, buildMediaMenu(app, t, tr, () => { load(); app.refreshHome(); }))}>
              <span className="no" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: 'var(--muted)', width: 24, textAlign: 'right' }}>{tr.episode || i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div className="t">{tr.title}</div>
              </div>
              <span className={'src' + (tr.path && tr.source !== 'local' ? ' off' : '')} title={tr.path && tr.source !== 'local' ? t('offlineAvailable') : tr.source}>{tr.path && tr.source !== 'local' ? '⬇' : tr.source}</span>
              <button className="nb-rowmenu" title={t('moreInfo')} onClick={rowMenu(tr)}>{I.dots}</button>
            </div>
          ))}
        </div>
      )}

      {view === 'tracks' && (
        <div className="nb-listpad">
          {filtered.map((tr, i) => (
            <div key={tr.id} className={'nb-music-row' + (current?.id === tr.id ? ' on' : '')} onClick={() => playQueue(filtered, i)}
              onContextMenu={(e) => app.openCtxMenu?.(e, buildMediaMenu(app, t, tr, () => { load(); app.refreshHome(); }))}>
              <Cover track={tr} />
              <div style={{ minWidth: 0 }}>
                <div className="t">{tr.title}</div>
                <div className="a">{[tr.artist, tr.album].filter(Boolean).join(' · ') || '—'}</div>
              </div>
              <span className={'src' + (tr.path && tr.source !== 'local' ? ' off' : '')} title={tr.path && tr.source !== 'local' ? t('offlineAvailable') : tr.source}>{tr.path && tr.source !== 'local' ? '⬇' : tr.source}</span>
              <button className="nb-rowmenu" title={t('moreInfo')} onClick={rowMenu(tr)}>{I.dots}</button>
            </div>
          ))}
          {!filtered.length && <div className="nb-empty">{t('emptyLibrary')}</div>}
        </div>
      )}

      {current && (
        <div className="nb-music-bar">
          <div className="np-prog"><i style={{ width: (prog.d ? (prog.t / prog.d) * 100 : 0) + '%' }} /></div>
          <div className="np-lead" onClick={() => setExpanded(true)}>
            <Cover track={current} />
            <div className="np-info">
              <div className="np-t">{current.title}</div>
              <div className="np-a">{current.artist || t('nowPlayingMusic')} · {qIndex + 1}/{queue.length}</div>
            </div>
          </div>
          <div className="np-ctrls">
            <button className="nb-cbtn hide-sm" onClick={() => step(-1)} disabled={qIndex <= 0}>{I.chevL}</button>
            <button className="nb-cbtn big" onClick={togglePlay} title={playing ? t('pause') : t('play')}>{playing ? I.pause : I.play}</button>
            <button className="nb-cbtn hide-sm" onClick={() => step(1)} disabled={qIndex >= queue.length - 1}>{I.chevR}</button>
            <button className="nb-cbtn" title={t('fullscreenView')} onClick={() => setExpanded(true)}>{I.full}</button>
            <button className="nb-cbtn hide-sm" title={t('clearQueue')} onClick={() => { setQueue([]); setQIndex(-1); }}>{I.x}</button>
          </div>
          <audio ref={audioRef} src={api.streamUrl(current.id)} autoPlay style={{ display: 'none' }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setProg({ t: e.target.currentTime || 0, d: e.target.duration || 0 })}
            onLoadedMetadata={(e) => setProg({ t: 0, d: e.target.duration || 0 })}
            onEnded={() => qIndex < queue.length - 1 ? step(1) : setQIndex(-1)} />
        </div>
      )}

      {expanded && current && (
        <div className="nb-nowplaying">
          <div className="np-top">
            <button className="nb-cbtn" title={t('back')} onClick={() => setExpanded(false)}>{I.chevD}</button>
            <span className="np-top-k">{t('nowPlayingMusic')}</span>
            <button className="nb-cbtn" title={t('moreInfo')}
              onClick={(e) => app.openCtxMenu?.(e, buildMediaMenu(app, t, current, () => { load(); app.refreshHome(); }))}>{I.dots}</button>
          </div>
          <div className="np-art"><Cover track={current} size="min(72vw, 340px)" radius={20} /></div>
          <div className="np-meta">
            <div className="np-title">{current.title}</div>
            <div className="np-artist">{[current.artist, current.album].filter(Boolean).join(' · ') || '—'}</div>
          </div>
          <div className="np-seek" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seekTo((e.clientX - r.left) / r.width); }}>
            <div className="rail"><i style={{ width: (prog.d ? (prog.t / prog.d) * 100 : 0) + '%' }} /></div>
          </div>
          <div className="np-times"><span>{fmtTime(prog.t)}</span><span>{fmtTime(prog.d)}</span></div>
          <div className="np-big-ctrls">
            <button className="nb-cbtn" onClick={() => step(-1)} disabled={qIndex <= 0}>{I.chevL}</button>
            <button className="np-bigplay" onClick={togglePlay} title={playing ? t('pause') : t('play')}>{playing ? I.pause : I.play}</button>
            <button className="nb-cbtn" onClick={() => step(1)} disabled={qIndex >= queue.length - 1}>{I.chevR}</button>
          </div>
        </div>
      )}

      {embed && (
        <div className="nb-embed-panel">
          <div className="hd">
            <span style={{ color: 'var(--mint)', display: 'flex' }}>{I.music}</span>
            <b>{embed.title}</b><span style={{ color: 'var(--muted)' }}>{embed.artist}</span>
            <button className="x" onClick={() => setEmbed(null)}>✕</button>
          </div>
          <iframe className={embed.embed.tall ? 'tall' : ''} src={embed.embed.src} title={embed.title}
            allow="autoplay; encrypted-media" />
        </div>
      )}

      {showAdd && <AddMusicModal onClose={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}

function AddMusicModal({ onClose }) {
  const app = useApp();
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const detect = (u) => /spotify/.test(u) ? 'spotify' : /soundcloud/.test(u) ? 'soundcloud' : /youtu/.test(u) ? 'youtube' : 'url';

  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await api.post('/media', { type: 'track', title: title.trim() || undefined, artist: artist.trim() || undefined, source: detect(url), externalUrl: url.trim(), enrich: false });
      app.toast('✓ ' + t('add'));
      onClose();
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
    setBusy(false);
  };

  return (
    <div className="nb-modal-bd" onClick={onClose}>
      <div className="nb-modal" style={{ width: 'min(520px,100%)', padding: 28 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontFamily: 'Archivo', fontWeight: 900, fontSize: 20, margin: '0 0 6px' }}>{t('addMusic')}</h3>
        <p className="nb-note" style={{ marginBottom: 16 }}>{t('streamHintAuto')}</p>
        <div className="nb-form-row"><input className="nb-input grow" autoFocus placeholder="https://open.spotify.com/track/…" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
        <div className="nb-form-row"><input className="nb-input grow" placeholder={t('titleAuto')} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="nb-form-row"><input className="nb-input grow" placeholder={t('artistAuto')} value={artist} onChange={(e) => setArtist(e.target.value)} /></div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="nb-btn play sm" disabled={busy || !url.trim()} onClick={add}>{t('add')}</button>
          <button className="nb-btn ghost sm" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}
