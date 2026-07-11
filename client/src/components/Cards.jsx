import React, { useRef, useState, useEffect } from 'react';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { img, withToken, thumbUrl } from '../api.js';
import { matchPct, fmtDuration, ep2 } from '../util.js';
import { I } from './Icons.jsx';
import { buildMediaMenu } from './ContextMenu.jsx';

const FOURTEEN_DAYS = 14 * 864e5;

export function Thumb({ item, ratio }) {
  // TMDB art (via server cache) -> generated ffmpeg thumb -> title placeholder
  const [stage, setStage] = useState(0);
  const remote = item.backdrop || item.poster;
  const local = (item.path || item.type === 'movie' || item.type === 'episode') ? thumbUrl(item.id, item.updatedAt) : null;
  const chain = [remote ? img(remote) : null, item.id ? local : null].filter(Boolean);
  const chainKey = chain.join('|');
  // when the sources change (e.g. a thumbnail just finished generating), retry from the top
  useEffect(() => { setStage(0); }, [chainKey]);
  if (stage >= chain.length) {
    return <div className="thumb ph" style={ratio ? { aspectRatio: ratio } : undefined}>{item.title}</div>;
  }
  return <img className="thumb" loading="lazy" alt={item.title} src={chain[stage]}
    style={ratio ? { aspectRatio: ratio } : undefined}
    onError={() => setStage(stage + 1)} />;
}

export function Card({ item, onOpen, quickActions }) {
  const app = useApp();
  const t = useT().t;
  const open = onOpen || ((it) => app.openDetail(it.id));
  const isNew = item.addedAt && Date.now() - item.addedAt < FOURTEEN_DAYS;
  const pct = matchPct(item);
  const showMatch = app.status?.ui?.showMatch !== false;
  return (
    <div className="nb-card" onClick={() => open(item)}
      onContextMenu={(e) => app.openCtxMenu?.(e, buildMediaMenu(app, t, item))}>
      <Thumb item={item} />
      {isNew
        ? <div className="corner new">{t('new')}</div>
        : <div className="corner">{item.type === 'series' ? t('seriesType') : item.type === 'movie' ? t('filmType') : item.type}</div>}
      {item.source && item.source !== 'local' && !quickActions && (
        <div className="corner right" title={item.source}>{item.source}</div>
      )}
      {quickActions && (
        <div className="corner right" style={{ display: 'flex', gap: 4, padding: 0, background: 'none', border: 'none' }}
          onClick={(e) => e.stopPropagation()}>
          {quickActions.map((a) => (
            <button key={a.key} title={a.title} onClick={a.onClick}
              style={{
                width: 28, height: 28, borderRadius: 7, border: '1px solid var(--line)', cursor: 'pointer',
                background: 'rgba(7,9,13,.75)', color: 'var(--ink)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', backdropFilter: 'blur(4px)',
              }}>{a.icon}</button>
          ))}
        </div>
      )}
      <div className="ov">
        <div className="ct-row">
          <div className="ct">{item.title}</div>
          <button className="nb-cardmenu" title={t('moreInfo')} aria-label={t('moreInfo')}
            onClick={(e) => { e.stopPropagation(); app.openCtxMenu?.(e, buildMediaMenu(app, t, item)); }}>
            {I.dots}
          </button>
        </div>
        <div className="cm">
          {showMatch && pct && <span className="mt">{t('match', { n: pct })}</span>}
          {item.year && <span>{item.year}</span>}
          {item.seriesTitle && <span>{item.seriesTitle} · S{ep2(item.season)}E{ep2(item.episode)}</span>}
          {item.duration ? <span>{fmtDuration(item.duration)}</span> : null}
        </div>
      </div>
      {item.progress && !item.progress.watched && item.progress.pct > 0 &&
        <div className="nb-prog"><i style={{ width: item.progress.pct + '%' }} /></div>}
    </div>
  );
}

export function Row({ title, sub, items, onOpen, children }) {
  const track = useRef(null);
  const by = (dir) => { const el = track.current; if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' }); };
  if (!items?.length && !children) return null;
  return (
    <section className="nb-row">
      <div className="nb-row-head"><h2>{title}</h2>{sub && <span className="sub">{sub}</span>}</div>
      <div className="nb-track-wrap">
        <button className="nb-arrow l" onClick={() => by(-1)} aria-label="scroll left">‹</button>
        <div className="nb-track" ref={track}>
          {children || items.map((it) => <Card key={it.id} item={it} onOpen={onOpen} />)}
        </div>
        <button className="nb-arrow r" onClick={() => by(1)} aria-label="scroll right">›</button>
      </div>
    </section>
  );
}

export function Grid({ items, onOpen }) {
  return (
    <div className="nb-grid">
      {items.map((it) => <Card key={it.id} item={it} onOpen={onOpen} />)}
    </div>
  );
}

/** Big-numeral Top 10 row: library titles that are trending worldwide. */
export function Top10Row({ top10 }) {
  const app = useApp();
  const { t } = useT();
  if (!top10?.length) return null;
  return (
    <Row title={t('top10')} sub={t('top10Sub')} items={top10}>
      {top10.map((entry) => (
        <div key={entry.rank} className="nb-ten" onClick={() => app.openDetail(entry.item.id)}
          onContextMenu={(e) => app.openCtxMenu?.(e, buildMediaMenu(app, t, entry.item))}>
          <span className="rank">{entry.rank}</span>
          <div className="nb-card">
            {entry.item.poster || entry.poster
              ? <img className="thumb" style={{ aspectRatio: '2/3' }} loading="lazy" alt={entry.title}
                src={img(entry.item.poster || entry.poster)} />
              : <div className="thumb ph" style={{ aspectRatio: '2/3' }}>{entry.title}</div>}
            <div className="ov">
              <div className="ct">{entry.title}</div>
              <div className="cm">{entry.rating ? <span className="mt">★ {entry.rating.toFixed(1)}</span> : null}<span>{entry.year}</span></div>
            </div>
          </div>
        </div>
      ))}
    </Row>
  );
}

/** TMDB art with a local-thumbnail fallback, so it still shows a poster offline. */
function TrendThumb({ tr }) {
  const [stage, setStage] = useState(0);
  const chain = [
    (tr.backdrop || tr.poster) ? img(tr.backdrop || tr.poster) : null,
    tr.localId ? thumbUrl(tr.localId, tr.updatedAt) : null,
  ].filter(Boolean);
  if (stage >= chain.length) return <div className="thumb ph">{tr.title}</div>;
  return <img className="thumb" loading="lazy" alt={tr.title} src={chain[stage]}
    onError={() => setStage(stage + 1)} />;
}

/** Trending row — only titles that are actually in your library, with local art. */
export function TrendingRow({ trending }) {
  const app = useApp();
  const { t } = useT();
  const items = (trending || []).filter((tr) => tr.localId);
  if (!items.length) return null;
  return (
    <Row title={t('trendingNow')} sub={t('trendingSub')} items={items}>
      {items.map((tr) => (
        <div key={tr.tmdbId} className="nb-card"
          onClick={() => app.openDetail(tr.localId)}
          onContextMenu={(e) => app.openCtxMenu?.(e, {
            header: tr.title,
            items: [{ label: t('moreInfo'), icon: I.info, onClick: () => app.openDetail(tr.localId) }],
          })}>
          <TrendThumb tr={tr} />
          <div className="corner new">{t('inLibrary')}</div>
          <div className="ov">
            <div className="ct">{tr.title}</div>
            <div className="cm">
              {tr.rating ? <span className="mt">★ {tr.rating.toFixed(1)}</span> : null}
              {tr.year && <span>{tr.year}</span>}
            </div>
          </div>
        </div>
      ))}
    </Row>
  );
}

/** Watchlist row: wanted trending titles, highlighted once they arrive. */
export function WatchlistRow({ items }) {
  const app = useApp();
  const { t } = useT();
  if (!items?.length) return null;
  return (
    <Row title={t('watchlistTitle')} sub={items.length + ' ' + t('titles')} items={items}>
      {items.map((w) => (
        <div key={w.tmdbId} className="nb-card" style={{ width: 200, opacity: w.localId ? 1 : 0.75 }}
          onClick={() => w.localId ? app.openDetail(w.localId) : app.toggleWant({ tmdbId: w.tmdbId, title: w.title })}
          onContextMenu={(e) => app.openCtxMenu?.(e, {
            header: w.title,
            items: [
              ...(w.localId ? [{ label: t('moreInfo'), icon: I.info, onClick: () => app.openDetail(w.localId) }] : []),
              { label: t('removeList'), icon: I.x, onClick: () => app.toggleWant({ tmdbId: w.tmdbId, title: w.title }) },
            ],
          })}>
          {w.poster
            ? <img className="thumb" style={{ aspectRatio: '2/3' }} loading="lazy" alt={w.title} src={img(w.poster)} />
            : <div className="thumb ph" style={{ aspectRatio: '2/3' }}>{w.title}</div>}
          {w.localId
            ? <div className="corner new">{t('inLibrary')}</div>
            : <div className="corner">{t('wanted')}</div>}
          <div className="ov">
            <div className="ct">{w.title}</div>
            <div className="cm">{w.year && <span>{w.year}</span>}{!w.localId && <span>✕ {t('removeList')}</span>}</div>
          </div>
        </div>
      ))}
    </Row>
  );
}
