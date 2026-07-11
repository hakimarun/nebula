import React, { useState, useEffect } from 'react';
import { api, img, thumbUrl } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';
import { Card } from './Cards.jsx';
import { CastButton } from './Cast.jsx';
import { buildMediaMenu } from './ContextMenu.jsx';
import { matchPct, fmtDuration, ep2 } from '../util.js';

export default function DetailModal({ id, onClose }) {
  const app = useApp();
  const { t } = useT();
  const [item, setItem] = useState(null);
  const [similar, setSimilar] = useState(null);
  const [season, setSeason] = useState(null);
  const [openReview, setOpenReview] = useState(null);
  const [showIntroEdit, setShowIntroEdit] = useState(false);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delFile, setDelFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false); // trailer plays only on demand

  const load = () => {
    setShowTrailer(false);
    api.get('/media/' + id).then((d) => {
      setItem(d);
      if (d.seasons?.length) setSeason((s) => (s != null && d.seasons.includes(s) ? s : d.seasons[0]));
    }).catch(() => onClose());
    api.get('/similar/' + id).then(setSimilar).catch(() => { });
  };
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [onClose]);

  // while an offline download is running, refresh the item so its status ticks
  const offStatus = item?.extra?.offline?.status;
  useEffect(() => {
    if (offStatus !== 'downloading' && offStatus !== 'queued') return;
    const iv = setInterval(() => { api.get('/media/' + id).then(setItem).catch(() => { }); }, 2000);
    return () => clearInterval(iv);
  }, [offStatus, id]);

  if (!item) return null;
  const pct = matchPct(item);
  const playable = item.type !== 'series' ? (item.path || item.externalUrl) : true;
  const resume = item.progress && !item.progress.watched && item.progress.position > 30;

  const off = item.extra?.offline;
  const isExternal = item.externalUrl && item.source && item.source !== 'local';
  const downloaded = isExternal && !!item.path;
  const downloading = !!off && (off.status === 'downloading' || off.status === 'queued');

  const saveOffline = async () => {
    try { await api.post(`/media/${id}/download`); app.toast(t('offlineQueued')); load(); }
    catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };
  const removeOffline = async () => {
    try { await api.del(`/media/${id}/offline`); app.toast('✓'); load(); app.refreshHome(); }
    catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };

  const toggleList = async () => {
    if (item.inMyList) await api.del('/list/' + id); else await api.post('/list/' + id);
    setItem({ ...item, inMyList: !item.inMyList });
    app.refreshHome();
  };

  const refreshMeta = async () => {
    setBusy(true);
    try { await api.post(`/media/${id}/refresh-metadata`); load(); app.refreshHome(); app.toast('✓ ' + t('refreshMetadata')); }
    catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
    setBusy(false);
  };

  const doDelete = async () => {
    try {
      await api.del(`/media/${id}` + (delFile ? '?file=1' : ''));
      app.toast('✓ ' + t('deleteTitle'));
      onClose(); app.refreshHome();
    } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
  };

  const episodes = (item.episodes || []).filter((e) => (e.season || 1) === season);

  return (
    <div className="nb-modal-bd" onClick={onClose}>
      <div className="nb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="player">
          <button className="nb-mclose" onClick={onClose}>✕</button>
          {item.trailerKey && showTrailer ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${item.trailerKey}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
              title={item.title + ' trailer'} allow="autoplay; encrypted-media; fullscreen" allowFullScreen />
          ) : (
            <div className="ph" style={{ backgroundImage: `url(${img(item.backdrop || item.poster) || ''})` }}>
              {item.trailerKey && (
                <button className="nb-trailer-btn" onClick={() => setShowTrailer(true)}>{I.play} {t('playTrailer')}</button>
              )}
            </div>
          )}
        </div>
        <div className="nb-mbody">
          <h1 className="nb-mtitle">{item.title}</h1>
          <div className="nb-meta" style={{ marginBottom: 18 }}>
            {pct && <span className="nb-match">{t('match', { n: pct })}</span>}
            {item.year && <span>{item.year}</span>}
            {item.cert && <span className="nb-chip">{item.cert}</span>}
            {item.duration ? <span>{fmtDuration(item.duration)}</span> : null}
            {item.rating ? <span className="nb-chip">★ {item.rating.toFixed(1)}</span> : null}
            {item.missing && <span className="nb-chip" style={{ color: '#ff9a9a', borderColor: 'rgba(255,120,120,.4)' }}>{t('missingFile')}</span>}
            {downloaded && <span className="nb-chip" style={{ color: 'var(--mint)', borderColor: 'rgba(120,255,200,.35)' }}>⬇ {t('offlineAvailable')}</span>}
          </div>
          <div className="nb-mcta">
            {playable && !item.missing && (
              <button className="nb-btn play" onClick={() => app.playItem(item, resume ? { startAt: item.progress.position } : {})}>
                {I.play} {resume ? t('resume') : t('play')}
              </button>
            )}
            {item.type !== 'series' && item.path && !item.missing && (
              <CastButton media={item} className="nb-btn ghost" />
            )}
            <button className="nb-btn ghost" onClick={toggleList}>
              {item.inMyList ? I.check : I.plus} {item.inMyList ? t('removeList') : t('addList')}
            </button>
            {app.can('editMedia') && (
              <button className="nb-btn ghost" disabled={busy || !app.status.hasTmdb} onClick={refreshMeta}>{I.refresh} {t('refreshMetadata')}</button>
            )}
            {app.can('editMedia') && app.status.hasTmdb && (item.type === 'movie' || item.type === 'series') && (
              <button className="nb-btn ghost" onClick={() => setShowFixMatch(!showFixMatch)}>{I.search} {t('fixMatch')}</button>
            )}
            {app.can('editMedia') && item.path && (
              <button className="nb-btn ghost" onClick={async () => {
                try { const r = await api.post(`/media/${id}/rename-clean`); app.toast('✓ ' + (r.path || '')); load(); }
                catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
              }}>{I.edit} {t('renameClean')}</button>
            )}
            {app.can('editMedia') && item.type === 'series' && (
              <button className="nb-btn ghost" onClick={() => setShowIntroEdit(!showIntroEdit)}>{I.speed} {t('introMarker')}</button>
            )}
            {app.can('editMedia') && isExternal && !downloaded && (
              <button className="nb-btn ghost" disabled={downloading} onClick={saveOffline}>
                {I.download} {downloading
                  ? (off.status === 'downloading' ? t('offlineDownloading', { pct: off.pct || 0 }) : t('offlineQueuedShort'))
                  : t('offlineDownload')}
              </button>
            )}
            {app.can('editMedia') && downloaded && (
              <button className="nb-btn ghost" onClick={removeOffline}>{I.trash} {t('offlineRemove')}</button>
            )}
            {app.can('deleteMedia') && (
              <button className="nb-btn danger" onClick={() => setConfirmDelete(true)}>{I.trash} {t('deleteTitle')}</button>
            )}
          </div>

          {off?.status === 'error' && (
            <div className="nb-note err" style={{ margin: '4px 0 8px' }}>{t('offlineErrorLbl')}: {off.error}</div>
          )}
          {off?.status === 'skipped' && (
            <div className="nb-note" style={{ margin: '4px 0 8px' }}>{t('offlineNeedsYtdlp')}</div>
          )}
          {downloaded && off?.via === 'search' && (
            <div className="nb-note" style={{ margin: '4px 0 8px' }}>↪ {t('offlineViaSearch')}</div>
          )}
          {downloaded && off?.via === 'resolved' && (
            <div className="nb-note" style={{ margin: '4px 0 8px' }}>↪ {t('offlineViaResolved')}</div>
          )}

          {confirmDelete && (
            <div className="nb-panel" style={{ borderColor: 'rgba(255,120,120,.4)' }}>
              <h3>{t('deleteConfirm', { t: item.title })}</h3>
              <div className="nb-form-row" style={{ marginTop: 10 }}>
                <button className={'nb-toggle' + (delFile ? ' on' : '')} onClick={() => setDelFile(!delFile)}><i /></button>
                <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>{t('alsoDeleteFile')}</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="nb-btn danger sm" onClick={doDelete}>{t('confirm')}</button>
                <button className="nb-btn ghost sm" onClick={() => setConfirmDelete(false)}>{t('cancel')}</button>
              </div>
            </div>
          )}

          {showIntroEdit && <IntroEditor item={item} onSaved={() => { setShowIntroEdit(false); load(); }} />}
          {showFixMatch && <FixMatch item={item} onDone={() => { setShowFixMatch(false); load(); app.refreshHome(); }} />}

          <div className="nb-mgrid">
            <div>
              <p className="d">{item.overview || t('noOverview')}</p>
              <div className="nb-genres">{(item.genres || []).map((g) => <span key={g} className="nb-chip">{g}</span>)}</div>
            </div>
            <div className="nb-mside">
              <div><b>{t('type')}:</b> {item.type === 'series' ? t('typeSeries') : item.type === 'track' ? t('typeTrack') : t('typeMovie')}</div>
              {item.year && <div><b>{t('released')}:</b> {item.year}</div>}
              {item.rating ? <div><b>{t('rating')}:</b> {item.cert || '—'} · ★ {item.rating.toFixed(1)}/10 ({item.votes || 0})</div> : null}
              {item.path && <div style={{ wordBreak: 'break-all' }}><b>{t('file')}:</b> {item.path}</div>}
              {item.externalUrl && <div style={{ wordBreak: 'break-all' }}><b>{t('sourceLbl')}:</b> {item.source} · {item.externalUrl}</div>}
              {item.progress?.watched && <div><b>✓</b> {t('watched')}</div>}
            </div>
          </div>

          {item.type === 'series' && item.seasons?.length > 0 && (
            <>
              <div className="nb-sect-title">{t('episodes')}</div>
              <div className="nb-seasons">
                {item.seasons.map((s) => (
                  <button key={s} className={'nb-season-btn' + (s === season ? ' on' : '')} onClick={() => setSeason(s)}>
                    {t('season')} {s}
                  </button>
                ))}
              </div>
              <div>
                {episodes.map((e) => {
                  const openMenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); app.openCtxMenu?.(ev, buildMediaMenu(app, t, e, load)); };
                  return (
                  <div key={e.id} className="nb-ep" onContextMenu={openMenu}
                    onClick={() => app.playItem(e, e.progress && !e.progress.watched ? { startAt: e.progress.position } : {})}>
                    <span className="no">{e.episode != null ? ep2(e.episode) : '—'}</span>
                    <div className="st">
                      <img loading="lazy" alt="" src={e.poster ? img(e.poster) : thumbUrl(e.id, e.updatedAt)}
                        onError={(ev) => { ev.target.style.visibility = 'hidden'; }} />
                      <span className="pl">{I.playBig}</span>
                      {e.progress && !e.progress.watched && e.progress.pct > 0 &&
                        <div className="nb-prog"><i style={{ width: e.progress.pct + '%' }} /></div>}
                    </div>
                    <div className="inf">
                      <div className="t">{e.title}{e.progress?.watched && <span style={{ color: 'var(--mint)' }}>{I.check}</span>}</div>
                      {e.overview && <div className="o">{e.overview}</div>}
                      {e.path && <div className="path" title={e.path}>{e.path}</div>}
                    </div>
                    <span className="dur">{fmtDuration(e.duration)}</span>
                    {e.path && app.pickCast && (
                      <button className="nb-ep-btn" title={t('playOn')}
                        onClick={(ev) => { ev.stopPropagation(); app.pickCast(e); }}>{I.cast}</button>
                    )}
                    <button className="nb-ep-btn" title={t('moreInfo')} onClick={openMenu}>{I.dots}</button>
                  </div>
                  );
                })}
              </div>
            </>
          )}

          {item.reviews?.length > 0 && (
            <>
              <div className="nb-sect-title">{t('reviews')}</div>
              {item.reviews.slice(0, 6).map((r) => (
                <div key={r.id} className={'nb-review' + (openReview === r.id ? ' open' : '')}
                  onClick={() => setOpenReview(openReview === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                  <div className="h"><b>{r.author}</b>{r.rating != null && <span className="r">★ {r.rating}/10</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>{r.source}</span></div>
                  <div className="c">{r.content}</div>
                </div>
              ))}
            </>
          )}

          {similar && (similar.local?.length > 0 || similar.online?.length > 0) && (
            <>
              <div className="nb-sect-title">{t('similar')}</div>
              {similar.local?.length > 0 && (
                <>
                  <div className="nb-note" style={{ margin: '4px 0 10px' }}>{t('localSuggestions')}</div>
                  <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 10 }}>
                    {similar.local.map((s) => (
                      <div key={s.id} style={{ width: 190, flex: '0 0 auto' }}>
                        <Card item={s} onOpen={() => { app.openDetail(s.id); }} />
                      </div>
                    ))}
                  </div>
                </>
              )}
              {similar.online?.length > 0 && (
                <>
                  <div className="nb-note" style={{ margin: '10px 0' }}>{t('onlineSuggestions')}</div>
                  <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 10 }}>
                    {similar.online.map((s) => (
                      <div key={s.tmdbId} className="nb-card" style={{ width: 190 }}
                        onClick={() => s.localId && app.openDetail(s.localId)}>
                        {s.backdrop || s.poster
                          ? <img className="thumb" loading="lazy" src={img(s.backdrop || s.poster)} alt={s.title} />
                          : <div className="thumb ph">{s.title}</div>}
                        {s.localId && <div className="corner new">{t('inLibrary')}</div>}
                        <div className="ov"><div className="ct">{s.title}</div>
                          <div className="cm">{s.rating ? <span className="mt">★ {s.rating.toFixed(1)}</span> : null}<span>{s.year}</span></div></div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FixMatch({ item, onDone }) {
  const app = useApp();
  const { t } = useT();
  const [q, setQ] = useState(item.title);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setResults('loading');
    try { setResults(await api.get(`/tmdb/search?type=${item.type}&q=${encodeURIComponent(q)}`)); }
    catch { setResults([]); }
  };

  const apply = async (tmdbId) => {
    setBusy(true);
    try { await api.post(`/media/${item.id}/match`, { tmdbId }); app.toast('✓ ' + t('fixMatch')); onDone(); }
    catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
    setBusy(false);
  };

  return (
    <div className="nb-panel">
      <h3>{t('fixMatch')}</h3>
      <p className="hint">{t('fixMatchHint')}</p>
      <div className="nb-form-row">
        <input className="nb-input grow" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()} />
        <button className="nb-btn ghost sm" onClick={search}>{t('searchTmdb')}</button>
      </div>
      {results === 'loading' && <div className="nb-note">…</div>}
      {Array.isArray(results) && results.map((r) => (
        <div key={r.tmdbId} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
          {r.poster
            ? <img src={r.poster} alt="" style={{ width: 46, borderRadius: 6 }} />
            : <div style={{ width: 46, height: 69, borderRadius: 6, background: '#121826' }} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{r.title} {r.year && <span style={{ color: 'var(--muted)' }}>({r.year})</span>}</div>
            <div className="nb-note" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.overview}</div>
          </div>
          <button className="nb-btn play sm" disabled={busy} onClick={() => apply(r.tmdbId)}>{t('apply')}</button>
        </div>
      ))}
      {Array.isArray(results) && !results.length && <div className="nb-note">{t('noResults', { q })}</div>}
    </div>
  );
}

function IntroEditor({ item, onSaved }) {
  const app = useApp();
  const { t } = useT();
  const m = item.introMarker;
  const [season, setSeason] = useState(0);
  const [start, setStart] = useState(m ? Math.round(m.start) : 0);
  const [end, setEnd] = useState(m ? Math.round(m.end) : 0);
  const save = async () => {
    await api.put('/intro/' + item.id, { season, start: Number(start), end: Number(end) });
    app.toast('✓ ' + t('introMarker'));
    onSaved();
  };
  return (
    <div className="nb-panel">
      <h3>{t('introMarker')}</h3>
      <p className="hint">
        {m ? `${Math.round(m.start)}s → ${Math.round(m.end)}s (${m.source === 'auto' ? t('autoDetected') : 'manual'}, ${Math.round((m.confidence || 0) * 100)}%)` : '—'}
      </p>
      <div className="nb-form-row">
        <label>{t('season')} (0 = all)</label>
        <input className="nb-input" type="number" min="0" style={{ width: 90 }} value={season} onChange={(e) => setSeason(Number(e.target.value))} />
        <label style={{ minWidth: 0 }}>{t('introStart')}</label>
        <input className="nb-input" type="number" min="0" style={{ width: 90 }} value={start} onChange={(e) => setStart(e.target.value)} />
        <label style={{ minWidth: 0 }}>{t('introEnd')}</label>
        <input className="nb-input" type="number" min="0" style={{ width: 90 }} value={end} onChange={(e) => setEnd(e.target.value)} />
        <button className="nb-btn play sm" onClick={save}>{t('save')}</button>
      </div>
      {app.status.ffmpeg && (
        <button className="nb-btn ghost sm" onClick={async () => {
          try {
            const r = await api.post(`/intro/audio-detect/${item.id}`, { season: season || 1 });
            app.toast(r.ok ? `✓ ${Math.round(r.start)}s → ${Math.round(r.end)}s (${r.episodes}/${r.total})` : (r.error || r.skipped || '—'), r.ok ? 'ok' : 'err');
            if (r.ok) onSaved();
          } catch (e) { app.toast(t('testFailed', { err: e.message }), 'err'); }
        }}>{I.speed} {t('introDetect')}</button>
      )}
    </div>
  );
}
