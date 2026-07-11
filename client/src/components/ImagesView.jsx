import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { api, withToken, thumbUrl } from '../api.js';
import { useT } from '../i18n.js';
import { useApp } from '../ctx.js';
import { I } from './Icons.jsx';

export default function ImagesView() {
  const { t } = useT();
  const app = useApp();
  const [images, setImages] = useState(null);
  const [album, setAlbum] = useState('');
  const [lightbox, setLightbox] = useState(-1);

  const load = useCallback(() => api.get('/library?type=image').then(setImages).catch(() => setImages([])), []);
  useEffect(() => { load(); }, [load, app.mediaVersion]);

  const imgMenu = (im) => ({
    header: im.title,
    items: [{
      label: t('deleteTitle'), confirm: t('ctxDeleteConfirm'), icon: I.trash, danger: true,
      onClick: async () => {
        try { await api.del('/media/' + im.id); app.toast('✓ ' + t('deleteTitle')); load(); }
        catch { app.toast(t('error'), 'err'); }
      },
    }],
  });

  const albums = useMemo(() => {
    const s = new Set();
    for (const im of images || []) if (im.album) s.add(im.album);
    return [...s].sort();
  }, [images]);

  const shown = useMemo(() =>
    (images || []).filter((im) => !album || im.album === album), [images, album]);

  useEffect(() => {
    if (lightbox < 0) return;
    const k = (e) => {
      if (e.key === 'Escape') setLightbox(-1);
      else if (e.key === 'ArrowRight') setLightbox((i) => Math.min(shown.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setLightbox((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [lightbox, shown.length]);

  if (!images) return <div className="nb-empty">{t('loading')}</div>;

  return (
    <div className="nb-rows" style={{ paddingTop: 30, minHeight: '60vh' }}>
      <div className="nb-row-head" style={{ alignItems: 'center' }}>
        <h2>{t('photoLib')}</h2>
        <span className="sub">{shown.length} {t('photos')}</span>
        <span style={{ flex: 1 }} />
        {albums.length > 0 && (
          <div className="nb-seasons" style={{ marginBottom: 0 }}>
            <button className={'nb-season-btn' + (!album ? ' on' : '')} onClick={() => setAlbum('')}>{t('allPhotos')}</button>
            {albums.map((a) => (
              <button key={a} className={'nb-season-btn' + (album === a ? ' on' : '')} onClick={() => setAlbum(a)}>{a}</button>
            ))}
          </div>
        )}
      </div>

      {shown.length ? (
        <div className="nb-imgrid">
          {shown.map((im, i) => (
            <div key={im.id} className="im" onClick={() => setLightbox(i)}
              onContextMenu={(e) => app.can('deleteMedia') && app.openCtxMenu?.(e, imgMenu(im))}>
              {app.can('deleteMedia') && (
                <button className="nb-imgmenu" title={t('deleteTitle')}
                  onClick={(e) => { e.stopPropagation(); app.openCtxMenu?.(e, imgMenu(im)); }}>{I.dots}</button>
              )}
              <img loading="lazy" src={thumbUrl(im.id, im.updatedAt)} alt={im.title}
                onError={(e) => { if (!e.target.dataset.f) { e.target.dataset.f = 1; e.target.src = api.streamUrl(im.id); } }} />
            </div>
          ))}
        </div>
      ) : <div className="nb-empty">{t('emptyLibrary')}</div>}

      {lightbox >= 0 && shown[lightbox] && (
        <div className="nb-lightbox" onClick={() => setLightbox(-1)}>
          {lightbox > 0 && (
            <button className="nav" style={{ left: 22 }} onClick={(e) => { e.stopPropagation(); setLightbox(lightbox - 1); }}>‹</button>
          )}
          <img src={api.streamUrl(shown[lightbox].id)} alt={shown[lightbox].title} onClick={(e) => e.stopPropagation()} />
          {lightbox < shown.length - 1 && (
            <button className="nav" style={{ right: 22 }} onClick={(e) => { e.stopPropagation(); setLightbox(lightbox + 1); }}>›</button>
          )}
          <div className="cap">{shown[lightbox].album ? shown[lightbox].album + ' · ' : ''}{shown[lightbox].title} · {lightbox + 1}/{shown.length}</div>
        </div>
      )}
    </div>
  );
}
