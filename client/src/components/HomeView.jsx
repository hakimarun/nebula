import React from 'react';
import { api, img } from '../api.js';
import { useApp } from '../ctx.js';
import { useT } from '../i18n.js';
import { I } from './Icons.jsx';
import { Row, Card, Top10Row, TrendingRow, WatchlistRow } from './Cards.jsx';
import { matchPct, fmtDuration } from '../util.js';

function Hero({ item }) {
  const app = useApp();
  const { t } = useT();
  if (!item) return null;
  const pct = matchPct(item);
  const bg = img(item.backdrop || item.poster);
  return (
    <header className="nb-hero">
      <div className="nb-hero-bg" style={bg ? { backgroundImage: `url(${bg})` } : { background: 'linear-gradient(135deg,#121826,#07090d)' }} />
      <div className="nb-hero-in">
        <div className="nb-badge"><span className="nb-dot" />{t('featured')}</div>
        <h1 className="nb-h1">{item.title}</h1>
        <div className="nb-meta">
          {pct && app.status?.ui?.showMatch !== false && <span className="nb-match">{t('match', { n: pct })}</span>}
          {item.year && <span>{item.year}</span>}
          {item.cert && <span className="nb-chip">{item.cert}</span>}
          {item.duration ? <span>{fmtDuration(item.duration)}</span> : null}
          {(item.genres || []).slice(0, 3).map((g) => <span key={g} className="nb-chip">{g}</span>)}
        </div>
        <p className="nb-hero-d">{item.overview || t('noOverview')}</p>
        <div className="nb-cta">
          <button className="nb-btn play" onClick={() => app.playItem(item)}>{I.play} {t('play')}</button>
          <button className="nb-btn ghost" onClick={() => app.openDetail(item.id)}>{I.info} {t('moreInfo')}</button>
        </div>
      </div>
    </header>
  );
}

export default function HomeView() {
  const app = useApp();
  const { t } = useT();
  const home = app.home;

  if (!home) return <div className="nb-empty">{t('loading')}</div>;

  const ui = app.status?.ui || {};
  const empty = !home.movies.length && !home.series.length;

  const hideProgress = async (it) => {
    await api.del('/progress/' + it.id).catch(() => { });
    app.refreshHome();
  };

  const rows = {
    continue: home.continueWatching.length ? (
      <Row key="c" title={t('continueWatching')} sub={t('continueSub')} items={home.continueWatching}>
        {home.continueWatching.map((it) => (
          <Card key={it.id} item={it}
            onOpen={() => app.playItem(it, { startAt: it.progress?.position })}
            quickActions={[
              ...(it.type === 'episode' ? [{
                key: 'next', title: t('playNextEp'), icon: I.chevR,
                onClick: async () => {
                  const d = await api.get('/media/' + it.id).catch(() => null);
                  if (d?.nextEpisode) app.playItem(d.nextEpisode.id, {});
                },
              }] : []),
              { key: 'info', title: t('moreInfo'), icon: I.info, onClick: () => app.openDetail(it.id) },
              { key: 'hide', title: t('hideFromRow'), icon: I.x, onClick: () => hideProgress(it) },
            ]} />
        ))}
      </Row>
    ) : null,
    watchlist: <WatchlistRow key="wl" items={app.watchlistItems} />,
    top10: ui.top10Enabled !== false ? <Top10Row key="t10" top10={home.top10} /> : null,
    trending: <TrendingRow key="tr" trending={home.trending} />,
    recent: <Row key="r" title={t('recentlyAdded')} items={home.recent} />,
    toprated: <Row key="tr2" title={t('topRated')} items={home.topRated} />,
    movies: <Row key="m" title={t('movies')} sub={t('inLibraryCount', { n: home.movies.length })} items={home.movies.slice(0, 20)} />,
    series: <Row key="s" title={t('series')} sub={t('inLibraryCount', { n: home.series.length })} items={home.series.slice(0, 20)} />,
    genres: home.genreRows.map((g) => <Row key={'g' + g.genre} title={g.genre} items={g.items} />),
    mylist: home.myList.length ? <Row key="ml" title={t('myList')} items={home.myList} /> : null,
  };
  const order = ui.rowsOrder || ['continue', 'watchlist', 'top10', 'trending', 'recent', 'toprated', 'movies', 'series', 'genres', 'mylist'];
  // always render every known row type, ordered by settings; unknown keys ignored
  const seen = new Set(order);
  const finalOrder = [...order, ...Object.keys(rows).filter((k) => !seen.has(k))];

  return (
    <>
      {ui.heroEnabled !== false && <Hero item={home.hero} />}
      <div className="nb-rows" style={ui.heroEnabled === false ? { paddingTop: 30 } : undefined}>
        {empty && <div className="nb-empty">{t('emptyLibrary')}</div>}
        {finalOrder.map((k) => rows[k] || null)}
      </div>
    </>
  );
}
