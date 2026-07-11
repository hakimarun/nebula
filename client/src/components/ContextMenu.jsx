// Custom right-click context menu (replaces the browser one app-wide).
import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { api } from '../api.js';
import { I } from './Icons.jsx';

/**
 * menu = { x, y, header?, items: [{ label, icon, onClick, danger?, confirm?, disabled? } | { sep: true } | { header: '…' }] }
 */
export function ContextMenu({ menu, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [confirmIdx, setConfirmIdx] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 10),
      y: Math.min(menu.y, window.innerHeight - r.height - 10),
    });
  }, [menu]);

  useEffect(() => {
    // capture-phase mousedown: dismiss on any press outside the menu
    const down = (e) => { if (!ref.current || !ref.current.contains(e.target)) onClose(); };
    const close = () => onClose();
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="nb-ctxmenu" style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {menu.header && <div className="k">{menu.header}</div>}
      {menu.items.map((it, i) => {
        if (it.sep) return <div key={i} className="sep" />;
        if (it.header) return <div key={i} className="k">{it.header}</div>;
        const confirming = confirmIdx === i;
        return (
          <button key={i} disabled={it.disabled}
            className={(it.danger ? 'danger' : '') + (confirming ? ' confirming' : '')}
            onClick={() => {
              if (it.confirm && !confirming) { setConfirmIdx(i); return; }
              onClose();
              it.onClick?.();
            }}>
            <span className="ic">{confirming ? I.trash : it.icon}</span>
            <span>{confirming ? it.confirm : it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Standard actions for a movie / series / episode / track card. */
export function buildMediaMenu(app, t, item, onChange) {
  const refresh = onChange || (() => app.refreshHome());
  const items = [];
  const dur = item.duration || 0;
  const hasProgress = item.progress && item.progress.position > 0;
  const inList = app.myListIds?.has(item.id);

  items.push({
    label: hasProgress && !item.progress.watched ? t('resume') : t('play'),
    icon: I.play,
    onClick: () => app.playItem(item, { startAt: hasProgress ? item.progress.position : undefined }),
  });
  items.push({ label: t('moreInfo'), icon: I.info, onClick: () => app.openDetail(item.id) });
  if (item.trailerKey) {
    items.push({ label: t('playTrailer'), icon: I.film, onClick: () => app.openDetail(item.id) });
  }
  // cast a playable local/downloaded file to a DLNA / Google Cast device
  if (item.path && item.type !== 'series' && app.pickCast) {
    items.push({ label: t('playOn'), icon: I.cast, onClick: () => app.pickCast(item) });
  }
  items.push({ sep: true });

  items.push({
    label: inList ? t('ctxRemoveList') : t('ctxAddList'),
    icon: inList ? I.check : I.plus,
    onClick: async () => {
      try {
        if (inList) await api.del('/list/' + item.id);
        else await api.post('/list/' + item.id);
        app.toast(inList ? '– ' + t('myList') : '＋ ' + t('myList'));
        refresh();
      } catch { app.toast(t('error'), 'err'); }
    },
  });

  if (item.type !== 'series') {
    if (item.progress?.watched) {
      items.push({
        label: t('ctxMarkUnwatched'), icon: I.refresh,
        onClick: async () => {
          await api.del('/progress/' + item.id).catch(() => { });
          refresh();
        },
      });
    } else {
      items.push({
        label: t('markWatched'), icon: I.check,
        onClick: async () => {
          await api.post('/progress', { mediaId: item.id, position: dur || 1, duration: dur || 1 }).catch(() => { });
          refresh();
        },
      });
      if (hasProgress) {
        items.push({
          label: t('ctxClearProgress'), icon: I.x,
          onClick: async () => {
            await api.del('/progress/' + item.id).catch(() => { });
            refresh();
          },
        });
      }
    }
  }

  if (app.can('editMedia') && app.status?.hasTmdb && (item.type === 'movie' || item.type === 'series')) {
    items.push({ sep: true });
    items.push({
      label: t('refreshMetadata'), icon: I.refresh,
      onClick: async () => {
        try { await api.post(`/media/${item.id}/refresh-metadata`); app.toast('✓'); refresh(); }
        catch { app.toast(t('error'), 'err'); }
      },
    });
  }

  if (app.can('editMedia') && item.source && item.source !== 'local' && item.externalUrl && !item.path) {
    items.push({ sep: true });
    items.push({
      label: t('offlineDownload'), icon: I.download,
      onClick: async () => {
        try { await api.post(`/media/${item.id}/download`); app.toast(t('offlineQueued')); }
        catch { app.toast(t('error'), 'err'); }
      },
    });
  }

  // downloaded external stream: let it be reverted to a pure stream (keep entry)
  const isOfflineCopy = item.source && item.source !== 'local' && item.path;
  if (app.can('editMedia') && isOfflineCopy) {
    items.push({ sep: true });
    items.push({
      label: t('offlineRemove'), icon: I.download,
      onClick: async () => {
        try { await api.del(`/media/${item.id}/offline`); app.toast('✓ ' + t('offlineRemove')); refresh(); }
        catch { app.toast(t('error'), 'err'); }
      },
    });
  }

  if (app.can('deleteMedia')) {
    if (!isOfflineCopy) items.push({ sep: true });
    items.push({
      label: t('deleteTitle'), confirm: t('ctxDeleteConfirm'), icon: I.trash, danger: true,
      onClick: async () => {
        // for a downloaded stream, also drop the saved file; never auto-delete
        // original local-library files
        const q = isOfflineCopy ? '?file=1' : '';
        try { await api.del('/media/' + item.id + q); app.toast('✓ ' + t('deleteTitle')); refresh(); }
        catch { app.toast(t('error'), 'err'); }
      },
    });
  }
  return { header: item.title, items };
}
