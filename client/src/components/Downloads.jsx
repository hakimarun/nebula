// Downloads queue popout — top-bar icon that shows active/queued/failed/done
// offline downloads with live progress. Polls /offline/queue.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';

export function DownloadsMenu() {
  const app = useApp();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const ref = useRef(null);

  const poll = useCallback(() => api.get('/offline/queue').then(setData).catch(() => { }), []);
  useEffect(() => {
    poll();
    const iv = setInterval(poll, open ? 1500 : 6000);
    return () => clearInterval(iv);
  }, [poll, open]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const key = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', key); };
  }, [open]);

  const items = data?.items || [];
  const active = items.filter((i) => i.status === 'downloading' || i.status === 'queued');
  const failed = items.filter((i) => i.status === 'error' || i.status === 'skipped');
  const done = items.filter((i) => i.status === 'done').slice(0, 10);
  const badge = active.length;

  const retry = async (id) => { try { await api.post(`/media/${id}/download`); poll(); } catch { } };
  const remove = async (id) => { try { await api.del(`/media/${id}/offline`); poll(); app.refreshHome(); } catch { } };
  const downloadAll = async () => { try { await api.post('/offline/download-all'); poll(); } catch { } };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className={'nb-ico' + (badge ? ' busy' : '')} title={t('downloads')} onClick={() => setOpen((o) => !o)}>
        {I.download}
        {badge > 0 && <span className="nb-dlbadge">{badge}</span>}
      </button>
      {open && (
        <div className="nb-menu nb-dlmenu">
          <div className="nb-dlhead">
            <span className="k" style={{ padding: 0 }}>{t('downloads')}</span>
            <button className="nb-btn ghost sm" onClick={downloadAll}>{I.download} {t('offlineDownloadAll')}</button>
          </div>
          {data && data.ytdlp === false && (
            <div className="nb-note" style={{ padding: '2px 12px 8px', color: '#ffcf8a' }}>{t('ytdlpMissing')}</div>
          )}
          {items.length === 0 && <div className="nb-note" style={{ padding: '12px' }}>{t('dlEmpty')}</div>}
          {active.map((i) => <DlRow key={i.id} i={i} t={t} />)}
          {failed.length > 0 && <div className="k">{t('dlFailed')}</div>}
          {failed.map((i) => <DlRow key={i.id} i={i} t={t} onRetry={i.status === 'error' ? () => retry(i.id) : null} />)}
          {done.length > 0 && <div className="k">{t('dlDone')}</div>}
          {done.map((i) => (
            <DlRow key={i.id} i={i} t={t}
              onOpen={() => { setOpen(false); app.openDetail(i.id); }}
              onRemove={() => remove(i.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DlRow({ i, t, onRetry, onRemove, onOpen }) {
  const status = i.status === 'downloading' ? `${i.pct || 0}%`
    : i.status === 'queued' ? t('dlQueued')
      : i.status === 'error' ? t('offlineErrorLbl')
        : i.status === 'skipped' ? t('dlSkipped')
          : t('offlineAvailable');
  return (
    <div className="nb-dlrow">
      <div className="nb-dlrow-main" onClick={onOpen} style={onOpen ? { cursor: 'pointer' } : undefined}>
        <div className="nb-dlrow-title" title={i.error || i.title}>{i.title}</div>
        <div className="nb-dlrow-sub">
          <span>{i.source}</span><span>·</span><span>{status}</span>
          {i.via === 'search' && <span title="matched on YouTube">· ↪yt</span>}
          {i.via === 'resolved' && <span title="extracted from host page">· ↪host</span>}
        </div>
        {i.status === 'downloading' && <div className="nb-dlbar"><i style={{ width: (i.pct || 0) + '%' }} /></div>}
      </div>
      {onRetry && <button className="nb-ico sm" title={t('retry')} onClick={onRetry}>{I.refresh}</button>}
      {onRemove && <button className="nb-ico sm" title={t('offlineRemove')} onClick={onRemove}>{I.trash}</button>}
    </div>
  );
}
