import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { api, withToken, getToken } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';
import { fmtTime, parseEmbed, ep2 } from '../util.js';
import { CastButton } from './Cast.jsx';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const QUALITIES = [[0, 'Original'], [1080, '1080p'], [720, '720p'], [480, '480p']];

export default function Player({ media, onClose, onPlayOther }) {
  // external streams play via embed — unless a local copy was saved for offline,
  // in which case `path` is set and we play the downloaded file directly.
  if (media.source && media.source !== 'local' && !media.path) {
    return <EmbedPlayer media={media} onClose={onClose} />;
  }
  return <LocalPlayer media={media} onClose={onClose} onPlayOther={onPlayOther} />;
}

/* ---------- external platform playback ---------- */
function EmbedPlayer({ media, onClose }) {
  const { t } = useT();
  const embed = parseEmbed(media.source, media.externalUrl);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div className="nb-player">
      <div className="nb-player-top">
        <button className="nb-back" onClick={onClose}>‹ {t('back')}</button>
        <div className="nb-now"><span className="nb-now-k">{t('nowPlaying')}</span><span className="nb-now-t">{media.title}</span></div>
        <div className="nb-now-meta">{media.year || ''} · {media.source}</div>
      </div>
      {embed?.type === 'video'
        ? <video className="nb-video" src={embed.src} controls autoPlay playsInline />
        : embed
          ? <iframe className="nb-embed-frame" src={embed.src} title={media.title}
            allow="autoplay; encrypted-media; fullscreen" allowFullScreen />
          : <div className="nb-empty">{t('error')}</div>}
      <div className="nb-embed-note">{t('externalNote', { src: media.source })}</div>
    </div>
  );
}

/* ---------- local file playback (direct or transcoded HLS) ---------- */
function LocalPlayer({ media, onClose, onPlayOther }) {
  const app = useApp();
  const { t } = useT();
  const vid = useRef(null);
  const wrap = useRef(null);
  const hlsRef = useRef(null);
  const sidRef = useRef(null);       // active HLS session id
  const offsetRef = useRef(0);       // absolute seconds at video.currentTime === 0
  const [mode, setMode] = useState(null); // 'direct' | 'hls'
  const [info, setInfo] = useState(null); // playinfo
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);    // absolute display time
  const [dur, setDur] = useState(media.duration || 0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(Number(localStorage.getItem('nebula_vol') ?? 1));
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [subs, setSubs] = useState([]);
  const [subOn, setSubOn] = useState(-1);
  const [audioTrack, setAudioTrack] = useState(0);
  const [quality, setQuality] = useState(0);
  const [menu, setMenu] = useState(null);
  const [idle, setIdle] = useState(false);
  const [ended, setEnded] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preview, setPreview] = useState(null); // { x, time }
  const [room, setRoom] = useState(null);       // { code, clientId, members, isHost }
  const [osResults, setOsResults] = useState(null);

  const marker = media.introMarker;
  const playback = app.status?.playback || {};
  // auto-skip the intro in the background for reasonably-confident markers (default on);
  // otherwise fall back to the manual "Skip intro" button
  const autoSkipIntro = !!marker && playback.skipIntroAuto !== false && (marker.confidence == null || marker.confidence >= 0.5);
  const lastStable = useRef(0);
  const skipReported = useRef(false);
  const applyingRemote = useRef(false);
  const roomRef = useRef(null);
  roomRef.current = room;

  const absTime = () => offsetRef.current + (vid.current?.currentTime || 0);

  /* ---- start / switch playback ---- */
  const destroySession = useCallback(() => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (sidRef.current) { api.del('/hls/' + sidRef.current).catch(() => { }); sidRef.current = null; }
  }, []);

  const startPlayback = useCallback(async (pi, at, audio, height) => {
    const v = vid.current;
    if (!v) return;
    destroySession();
    const useDirect = pi.direct && audio === 0 && height === 0;
    if (useDirect) {
      setMode('direct');
      offsetRef.current = 0;
      v.src = api.streamUrl(media.id);
      v.currentTime = at || 0;
      v.play().catch(() => setPlaying(false));
      return;
    }
    if (!pi.canTranscode) { // incompatible + no ffmpeg: try direct anyway
      setMode('direct');
      offsetRef.current = 0;
      v.src = api.streamUrl(media.id);
      v.play().catch(() => setPlaying(false));
      return;
    }
    setPreparing(true);
    setMode('hls');
    try {
      const s = await api.post(`/media/${media.id}/hls`, { start: at || 0, audio, height });
      sidRef.current = s.sid;
      offsetRef.current = s.start || 0;
      const url = withToken(s.playlist);
      if (Hls.isSupported()) {
        const hls = new Hls({ maxBufferLength: 30, liveDurationInfinity: false });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => setPlaying(false)); setPreparing(false); });
        hls.on(Hls.Events.ERROR, (e, data) => { if (data.fatal) setPreparing(false); });
      } else {
        v.src = url; // Safari native HLS
        v.play().catch(() => setPlaying(false));
        setPreparing(false);
      }
    } catch {
      setPreparing(false);
      app.toast(t('error'), 'err');
    }
  }, [media.id, destroySession, app, t]);

  /* seek to an absolute position, restarting the transcode when needed */
  const seekAbs = useCallback((target, fromRemote = false) => {
    const v = vid.current;
    if (!v || !dur) return;
    target = Math.max(0, Math.min(dur - 1, target));
    if (!fromRemote && roomRef.current) sendControl(playing ? 'play' : 'pause', target);
    if (mode === 'direct') { v.currentTime = target; return; }
    const local = target - offsetRef.current;
    const seekable = v.seekable?.length ? v.seekable.end(v.seekable.length - 1) : 0;
    if (local >= 0 && local <= seekable + 8) v.currentTime = Math.min(local, Math.max(0, seekable - 0.5));
    else if (info) startPlayback(info, target, audioTrack, quality);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dur, info, audioTrack, quality, playing, startPlayback]);

  /* ---- bootstrap: playinfo ---- */
  useEffect(() => {
    let alive = true;
    api.get(`/media/${media.id}/playinfo`).then((pi) => {
      if (!alive) return;
      setInfo(pi);
      setSubs(pi.subtitles || []);
      if (pi.duration) setDur(pi.duration);
      const pref = playback.defaultSubtitleLang;
      const i = (pi.subtitles || []).findIndex((s) => s.lang === pref);
      if (i >= 0 && localStorage.getItem('nebula_subs_on') === '1') setSubOn(i);
      startPlayback(pi, media.startAt && media.startAt > 5 ? media.startAt : 0, 0, 0);
    }).catch(() => {
      // fallback: plain direct streaming
      const v = vid.current;
      if (v) { v.src = api.streamUrl(media.id); v.play().catch(() => { }); }
      setMode('direct');
    });
    return () => { alive = false; destroySession(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id]);

  /* ---- subtitles track modes ---- */
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    for (const tr of v.textTracks) tr.mode = 'hidden';
    if (subOn >= 0 && v.textTracks[subOn]) v.textTracks[subOn].mode = 'showing';
    localStorage.setItem('nebula_subs_on', subOn >= 0 ? '1' : '0');
  }, [subOn, subs]);

  /* ---- progress ---- */
  const saveProgress = useCallback((pos, d) => {
    if (!d || pos < 5) return;
    api.post('/progress', { mediaId: media.id, position: pos, duration: d }).catch(() => { });
  }, [media.id]);

  useEffect(() => {
    const iv = setInterval(() => {
      const v = vid.current;
      if (v && !v.paused) saveProgress(offsetRef.current + v.currentTime, dur || v.duration);
    }, 10000);
    return () => {
      clearInterval(iv);
      const v = vid.current;
      if (v) saveProgress(offsetRef.current + v.currentTime, dur || v.duration);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id, dur]);

  /* ---- video events ---- */
  const onLoaded = () => {
    const v = vid.current;
    if (mode === 'direct') {
      if (v.duration && isFinite(v.duration)) setDur(v.duration);
      v.volume = volume;
    } else v.volume = volume;
  };

  const onTime = () => {
    const v = vid.current;
    if (!v) return;
    const abs = offsetRef.current + v.currentTime;
    setTime(abs);
    if (!v.seeking) lastStable.current = abs;
    try { if (v.buffered.length) setBuffered(offsetRef.current + v.buffered.end(v.buffered.length - 1)); } catch { }
    if (autoSkipIntro && abs >= marker.start && abs < marker.end - 1) seekAbs(marker.end);
  };

  const onSeeked = () => {
    const v = vid.current;
    const from = lastStable.current, to = offsetRef.current + v.currentTime;
    if (media.parentId && to - from >= 10 && to - from <= 180 && from < 300 && !skipReported.current) {
      skipReported.current = true;
      api.post('/skip-event', { mediaId: media.id, from, to }).catch(() => { });
      setTimeout(() => { skipReported.current = false; }, 5000);
    }
    lastStable.current = to;
  };

  const onEnded = () => {
    setEnded(true);
    saveProgress(dur, dur);
    if (media.nextEpisode && playback.autoplayNext !== false && !roomRef.current) onPlayOther(media.nextEpisode.id, {});
  };

  /* ---- watch together ---- */
  const sendControl = (action, position) => {
    const r = roomRef.current;
    if (!r || applyingRemote.current) return;
    api.post('/sync/control', { code: r.code, clientId: r.clientId, action, position }).catch(() => { });
  };

  useEffect(() => {
    if (!room) return;
    const es = new EventSource(withToken(`/api/events?ch=room:${room.code}`));
    es.addEventListener('control', (e) => {
      const d = JSON.parse(e.data);
      const v = vid.current;
      if (!v) return;
      applyingRemote.current = true;
      if (Math.abs(absTime() - d.position) > 1.5) seekAbs(d.position, true);
      if (d.action === 'play') v.play().catch(() => { });
      else v.pause();
      setTimeout(() => { applyingRemote.current = false; }, 400);
    });
    es.addEventListener('members', (e) => {
      setRoom((r) => r ? { ...r, members: JSON.parse(e.data) } : r);
    });
    es.addEventListener('closed', () => setRoom(null));
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.code]);

  useEffect(() => () => {
    const r = roomRef.current;
    if (r) api.post('/sync/leave', { code: r.code, clientId: r.clientId }).catch(() => { });
  }, []);

  const togglePlay = () => {
    const v = vid.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => { }); sendControl('play', absTime()); }
    else { v.pause(); sendControl('pause', absTime()); }
  };

  /* ---- controls visibility / keyboard ---- */
  useEffect(() => {
    let timer;
    const poke = () => { setIdle(false); clearTimeout(timer); timer = setTimeout(() => setIdle(true), 3200); };
    poke();
    const el = wrap.current;
    el.addEventListener('pointermove', poke);
    el.addEventListener('pointerdown', poke);
    return () => { clearTimeout(timer); el?.removeEventListener('pointermove', poke); el?.removeEventListener('pointerdown', poke); };
  }, []);

  useEffect(() => {
    const k = (e) => {
      const v = vid.current;
      if (!v || e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') { if (document.fullscreenElement) document.exitFullscreen(); else onClose(); }
      else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') seekAbs(absTime() + 10);
      else if (e.key === 'ArrowLeft') seekAbs(absTime() - 10);
      else if (e.key === 'ArrowUp') { e.preventDefault(); changeVolume(Math.min(1, v.volume + 0.1)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); changeVolume(Math.max(0, v.volume - 0.1)); }
      else if (e.key === 'f') toggleFull();
      else if (e.key === 'm') { v.muted = !v.muted; setMuted(v.muted); }
      else if (e.key === 's' && marker && absTime() >= marker.start && absTime() < marker.end) seekAbs(marker.end);
    };
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marker, onClose, seekAbs]);

  const changeVolume = (val) => {
    const v = vid.current;
    v.volume = val; v.muted = val === 0;
    setVolume(val); setMuted(v.muted);
    localStorage.setItem('nebula_vol', String(val));
  };

  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.current?.requestFullscreen?.();
  };

  const barFrac = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const changeAudio = (idx) => { setAudioTrack(idx); setMenu(null); if (info) startPlayback(info, absTime(), idx, quality); };
  const changeQuality = (h) => { setQuality(h); setMenu(null); if (info) startPlayback(info, absTime(), audioTrack, h); };

  /* ---- OpenSubtitles ---- */
  const searchOs = async () => {
    setOsResults('loading');
    try {
      const r = await api.get(`/media/${media.id}/opensubs/search`);
      setOsResults(r.length ? r : 'empty');
    } catch { setOsResults('empty'); }
  };
  const downloadOs = async (fileId) => {
    try {
      const r = await api.post(`/media/${media.id}/opensubs/download`, { fileId });
      const entry = { kind: 'opensubs', lang: 'dl', name: 'OpenSubtitles', url: r.url };
      setSubs((s) => { const next = [...s, entry]; setSubOn(next.length - 1); return next; });
      setOsResults(null); setMenu(null);
      app.toast(t('downloadedSub'));
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };

  const showSkipIntro = marker && time >= marker.start && time < marker.end - 1 && !autoSkipIntro;
  const showNextEp = media.nextEpisode && dur > 0 && dur - time <= 30 && !ended;
  const seriesLabel = media.series ? `${media.series.title} · S${ep2(media.season)}E${ep2(media.episode)}` : null;

  return (
    <div className={'nb-player' + (idle && playing ? ' hidecursor' : '')} ref={wrap}>
      <video
        ref={vid}
        className="nb-video"
        poster={media.backdrop || undefined}
        crossOrigin="anonymous"
        autoPlay
        playsInline
        onLoadedMetadata={onLoaded}
        onTimeUpdate={onTime}
        onSeeked={onSeeked}
        onPlay={() => { setPlaying(true); setEnded(false); }}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
        onClick={togglePlay}
      >
        {subs.map((s, i) => (
          <track key={s.url} kind="subtitles" srcLang={s.lang} label={`${s.lang} · ${s.name}`}
            src={withToken(s.url)} default={i === subOn} />
        ))}
      </video>

      {preparing && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, pointerEvents: 'none' }}>
          <div className="nb-badge"><span className="nb-dot" />{t('preparing')}</div>
        </div>
      )}
      {!playing && !ended && !preparing && (
        <button className="nb-bigplay" onClick={togglePlay}>{I.playBig}</button>
      )}

      <div className={'nb-player-top' + (idle && playing ? ' hidden' : '')}>
        <button className="nb-back" onClick={onClose} style={{ pointerEvents: 'auto' }}>‹ {t('back')}</button>
        <div className="nb-now">
          <span className="nb-now-k">
            {t('nowPlaying')}{mode === 'hls' ? ' · ' + t('transcoding') : ''}
            {room ? ' · ' + t('inRoom', { code: room.code, n: room.members?.length || 1 }) : ''}
          </span>
          <span className="nb-now-t">{seriesLabel ? `${seriesLabel} · ${media.title}` : media.title}</span>
        </div>
        <div className="nb-now-meta">{media.year || ''} {media.cert ? '· ' + media.cert : ''}</div>
        <div style={{ pointerEvents: 'auto' }}>
          <CastButton media={media} className="nb-back" onCasting={onClose} />
        </div>
      </div>

      {showSkipIntro && (
        <button className="nb-skip" onClick={() => seekAbs(marker.end)}>{t('skipIntro')} ⏭</button>
      )}
      {showNextEp && (
        <button className="nb-skip nextep" onClick={() => onPlayOther(media.nextEpisode.id, {})}>
          {t('nextEpisode')} ▸ {media.nextEpisode.title}
        </button>
      )}

      <div className={'nb-ctrl' + (idle && playing ? ' hidden' : '')}>
        {preview && dur > 0 && (
          <div style={{
            position: 'absolute', bottom: 74, left: `calc(${(preview.time / dur) * 100}% )`, transform: 'translateX(-50%)',
            background: '#0b0e15', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', pointerEvents: 'none', zIndex: 6,
          }}>
            <img src={withToken(`/api/frame/${media.id}.jpg?at=${Math.floor(preview.time / 10) * 10}`)}
              alt="" style={{ width: 168, aspectRatio: '16/9', objectFit: 'cover', display: 'block' }}
              onError={(e) => { e.target.style.display = 'none'; }} />
            <div style={{ textAlign: 'center', font: "11px 'IBM Plex Mono',monospace", padding: '3px 0', color: 'var(--muted)' }}>
              {fmtTime(preview.time)}
            </div>
          </div>
        )}
        <div className="nb-seek"
          onClick={(e) => seekAbs(barFrac(e) * dur)}
          onMouseMove={(e) => dur && setPreview({ time: barFrac(e) * dur })}
          onMouseLeave={() => setPreview(null)}>
          <div className="rail">
            {marker && dur > 0 && (
              <span className="intro-zone" style={{ left: (marker.start / dur) * 100 + '%', width: ((marker.end - marker.start) / dur) * 100 + '%' }} />
            )}
            <span className="buf" style={{ width: dur ? Math.min(100, (buffered / dur) * 100) + '%' : 0 }} />
            <span className="cur" style={{ width: dur ? (time / dur) * 100 + '%' : 0 }} />
          </div>
          <span className="knob" style={{ left: dur ? (time / dur) * 100 + '%' : 0 }} />
        </div>
        <div className="nb-ctrl-row">
          <button className="nb-cbtn" onClick={togglePlay}>{playing ? I.pause : I.play}</button>
          <button className="nb-cbtn" title="-10s" onClick={() => seekAbs(absTime() - 10)}>{I.back10}</button>
          <button className="nb-cbtn" title="+10s" onClick={() => seekAbs(absTime() + 10)}>{I.fwd10}</button>
          <div className="nb-vol">
            <button className="nb-cbtn" onClick={() => { const v = vid.current; v.muted = !v.muted; setMuted(v.muted); }}>
              {muted || volume === 0 ? I.mute : I.volume}
            </button>
            <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))} />
          </div>
          <span className="nb-time">{fmtTime(time)} / {fmtTime(dur)}</span>
          <span style={{ flex: 1 }} />
          <button className={'nb-cbtn'} title={t('watchTogether')} style={room ? { color: 'var(--mint)' } : undefined}
            onClick={() => setMenu(menu === 'room' ? null : 'room')}>{I.users}</button>
          {(subs.length > 0 || info?.openSubtitlesEnabled) && (
            <button className="nb-cbtn" style={subOn >= 0 ? { color: 'var(--mint)' } : undefined}
              onClick={() => setMenu(menu === 'subs' ? null : 'subs')}>{I.cc}</button>
          )}
          {(info?.audioTracks?.length > 1 || info?.canTranscode) && (
            <button className="nb-cbtn" title={t('quality')} onClick={() => setMenu(menu === 'av' ? null : 'av')}>{I.gear}</button>
          )}
          <button className="nb-cbtn" onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>{I.speed}</button>
          <button className="nb-cbtn" onClick={toggleFull}>{I.full}</button>
        </div>
      </div>

      {menu === 'subs' && (
        <div className="nb-cmenu">
          <div className="k">{t('subtitles')}</div>
          <button className={subOn === -1 ? 'on' : ''} onClick={() => { setSubOn(-1); setMenu(null); }}>
            <span>{t('off')}</span>{subOn === -1 && I.check}
          </button>
          {subs.map((s, i) => (
            <button key={s.url} className={subOn === i ? 'on' : ''} onClick={() => { setSubOn(i); setMenu(null); }}>
              <span>{s.lang.toUpperCase()} · {s.name.slice(0, 22)}</span>{subOn === i && I.check}
            </button>
          ))}
          {info?.openSubtitlesEnabled && (
            <>
              <div className="k">OpenSubtitles</div>
              {osResults === null && <button onClick={searchOs}><span>{t('findSubs')}</span>{I.search}</button>}
              {osResults === 'loading' && <button disabled><span>…</span></button>}
              {osResults === 'empty' && <button disabled><span>{t('noSubsFound')}</span></button>}
              {Array.isArray(osResults) && osResults.slice(0, 6).map((r) => (
                <button key={r.fileId} onClick={() => downloadOs(r.fileId)}>
                  <span>{r.lang} · {String(r.release).slice(0, 20)}</span><span style={{ color: 'var(--muted)' }}>↓{r.downloads}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {menu === 'av' && (
        <div className="nb-cmenu">
          {info?.audioTracks?.length > 1 && (
            <>
              <div className="k">{t('audioTrack')}</div>
              {info.audioTracks.map((a) => (
                <button key={a.index} className={audioTrack === a.index ? 'on' : ''} onClick={() => changeAudio(a.index)}>
                  <span>{a.lang.toUpperCase()} · {a.title || a.codec} {a.channels}ch</span>{audioTrack === a.index && I.check}
                </button>
              ))}
            </>
          )}
          {info?.canTranscode && (
            <>
              <div className="k">{t('quality')}</div>
              {QUALITIES.map(([h, label]) => (
                <button key={h} className={quality === h ? 'on' : ''} onClick={() => changeQuality(h)}>
                  <span>{h === 0 ? t('original') : label}</span>{quality === h && I.check}
                </button>
              ))}
            </>
          )}
          {mode === 'hls' && <div className="k" style={{ paddingBottom: 8 }}>{t('transcodeNote')}</div>}
        </div>
      )}

      {menu === 'speed' && (
        <div className="nb-cmenu">
          <div className="k">{t('speed')}</div>
          {SPEEDS.map((s) => (
            <button key={s} className={rate === s ? 'on' : ''}
              onClick={() => { vid.current.playbackRate = s; setRate(s); setMenu(null); }}>
              <span>{s}×</span>{rate === s && I.check}
            </button>
          ))}
        </div>
      )}

      {menu === 'room' && (
        <RoomMenu media={media} room={room} setRoom={setRoom} absTime={absTime} onDone={() => setMenu(null)} />
      )}
    </div>
  );
}

function RoomMenu({ media, room, setRoom, absTime, onDone }) {
  const app = useApp();
  const { t } = useT();
  const [joinCode, setJoinCode] = useState('');

  const create = async () => {
    try {
      const r = await api.post('/sync/create', { mediaId: media.id });
      setRoom({ code: r.code, clientId: r.clientId, isHost: true, members: [app.user?.username || 'Host'] });
    } catch { app.toast(t('error'), 'err'); }
  };
  const join = async () => {
    try {
      const r = await api.post('/sync/join', { code: joinCode.trim() });
      setRoom({ code: joinCode.trim().toUpperCase(), clientId: r.clientId, isHost: false, members: r.members });
      onDone();
    } catch { app.toast(t('error'), 'err'); }
  };
  const leave = async () => {
    await api.post('/sync/leave', { code: room.code, clientId: room.clientId }).catch(() => { });
    setRoom(null); onDone();
  };

  return (
    <div className="nb-cmenu" style={{ minWidth: 240 }}>
      <div className="k">{t('watchTogether')}</div>
      {room ? (
        <>
          <button onClick={() => { navigator.clipboard?.writeText(room.code); app.toast(t('copied')); }}>
            <span>{t('roomCode')}: <b style={{ color: 'var(--mint)' }}>{room.code}</b></span>{I.check}
          </button>
          <div className="k">{(room.members || []).join(' · ')}</div>
          <button onClick={leave}><span>{t('leaveRoom')}</span>{I.x}</button>
        </>
      ) : (
        <>
          <button onClick={create}><span>{t('createRoom')}</span>{I.plus}</button>
          <div style={{ display: 'flex', gap: 6, padding: '6px 10px' }}>
            <input className="nb-input" style={{ width: 110, padding: '6px 10px', fontSize: 13, textTransform: 'uppercase' }}
              placeholder={t('roomCode')} value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
            <button className="nb-btn play sm" disabled={joinCode.trim().length < 4} onClick={join}>{t('joinRoom')}</button>
          </div>
        </>
      )}
    </div>
  );
}
