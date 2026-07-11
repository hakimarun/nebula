import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api, setToken, getToken, setProfile, getProfile, withToken } from './api.js';
import ProfilesGate from './components/ProfilesGate.jsx';
import { I18nContext, translate, LOCALES } from './i18n.js';
import { AppCtx } from './ctx.js';
import { I } from './components/Icons.jsx';
import { fmtBytes, debounce } from './util.js';
import HomeView from './components/HomeView.jsx';
import DetailModal from './components/DetailModal.jsx';
import Player from './components/Player.jsx';
import MusicView from './components/MusicView.jsx';
import ImagesView from './components/ImagesView.jsx';
import SettingsView from './components/SettingsView.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import AuthView from './components/AuthView.jsx';
import { UploadModal, AddStreamModal } from './components/Modals.jsx';
import { ContextMenu } from './components/ContextMenu.jsx';
import { DownloadsMenu } from './components/Downloads.jsx';
import { CastBar, CastPicker } from './components/Cast.jsx';

const NAV_VIEWS = [
  { key: 'home', icon: I.home },
  { key: 'movies', icon: I.film },
  { key: 'series', icon: I.tv },
  { key: 'music', icon: I.music },
  { key: 'images', icon: I.image },
  { key: 'myList', icon: I.list },
];

export default function App() {
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(false);
  const [user, setUser] = useState(null);
  const [view, setViewRaw] = useState(() => localStorage.getItem('nebula_view') || 'home');
  const setView = useCallback((v) => {
    setViewRaw(v);
    try { localStorage.setItem('nebula_view', v); } catch { /* private mode */ }
  }, []);
  const [home, setHome] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [watch, setWatch] = useState(null); // full media detail object
  const [q, setQ] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [results, setResults] = useState(null);
  const [solid, setSolid] = useState(false);
  const [menu, setMenu] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showAddStream, setShowAddStream] = useState(false);
  const [toasts, setToasts] = useState([]);

  const [locale, setLocaleState] = useState(localStorage.getItem('nebula_locale') || 'en');
  const [hue, setHueState] = useState(Number(localStorage.getItem('nebula_hue')) || 165);
  const [profileChosen, setProfileChosen] = useState(!!getProfile());
  const [watchlistItems, setWatchlistItems] = useState([]);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [mediaVersion, setMediaVersion] = useState(0); // bumps when media changes -> views reload
  const [casting, setCasting] = useState(null); // { renderer, media } when casting to a DLNA device
  const [castPickFor, setCastPickFor] = useState(null); // media whose "Play on…" picker is open

  const t = useCallback((k, v) => translate(locale, k, v), [locale]);

  /* ---- toast helper ---- */
  const toast = useCallback((msg, kind = 'ok') => {
    const id = Math.random();
    setToasts((ts) => [...ts, { id, msg, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4200);
  }, []);

  /* ---- accent hue -> css + bg canvas ---- */
  const setHue = useCallback((h, persist = true) => {
    setHueState(h);
    document.documentElement.style.setProperty('--mint-h', h);
    window.__accentHue = h;
    if (persist) {
      localStorage.setItem('nebula_hue', String(h));
      api.put('/auth/me/prefs', { hue: h }).catch(() => { });
    }
  }, []);

  const setLocale = useCallback((l, persist = true) => {
    setLocaleState(l);
    if (persist) {
      localStorage.setItem('nebula_locale', l);
      api.put('/auth/me/prefs', { locale: l }).catch(() => { });
    }
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--mint-h', hue);
    window.__accentHue = hue;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- bootstrap ---- */
  const loadStatus = useCallback(async () => {
    try {
      const s = await api.get('/status');
      setStatus(s);
      setStatusErr(false);
      if (s.ui?.cardSize) document.documentElement.style.setProperty('--card-w', s.ui.cardSize + 'px');
      if (s.user) {
        setUser(s.user);
        if (s.user.prefs?.hue && !localStorage.getItem('nebula_hue')) setHue(s.user.prefs.hue, false);
        if (s.user.prefs?.locale && !localStorage.getItem('nebula_locale')) setLocaleState(s.user.prefs.locale);
      }
      if (!localStorage.getItem('nebula_hue') && s.defaultHue != null && !s.user?.prefs?.hue) setHue(s.defaultHue, false);
      if (!localStorage.getItem('nebula_locale') && s.defaultLocale && !s.user?.prefs?.locale) setLocaleState(s.defaultLocale);
      return s;
    } catch {
      setStatusErr(true);
      return null;
    }
  }, [setHue]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const needProfile = status && !status.authEnabled && status.profilesEnabled && !profileChosen;
  const ready = status && status.setupComplete && (!status.authEnabled || user) && !needProfile;

  const refreshHome = useCallback(async () => {
    if (!ready) return;
    try { setHome(await api.get('/home')); } catch (e) { if (e.status === 401) setUser(null); }
  }, [ready]);

  useEffect(() => { refreshHome(); }, [refreshHome]);

  /* watchlist */
  const loadWatchlist = useCallback(async () => {
    if (!ready) return;
    try { setWatchlistItems(await api.get('/watchlist')); } catch { }
  }, [ready]);
  useEffect(() => { loadWatchlist(); }, [loadWatchlist]);

  const toggleWant = useCallback(async (tr) => {
    const has = watchlistItems.some((w) => w.tmdbId === tr.tmdbId);
    try {
      if (has) await api.del('/watchlist/' + tr.tmdbId);
      else await api.post('/watchlist', { tmdbId: tr.tmdbId, mediaType: tr.mediaType, title: tr.title, year: tr.year, poster: tr.poster });
      loadWatchlist();
    } catch { }
  }, [watchlistItems, loadWatchlist]);

  /* live server events -> toasts + refresh */
  useEffect(() => {
    if (!ready) return;
    const es = new EventSource(withToken('/api/events?ch=global'));
    es.addEventListener('scan', (e) => {
      const d = JSON.parse(e.data);
      if (d.phase === 'done' && d.added > 0) {
        toast(t('scanDoneToast', { n: d.added }));
        refreshHome();
      }
    });
    es.addEventListener('newMedia', (e) => {
      const d = JSON.parse(e.data);
      toast(t('newMediaToast', { n: d.count }));
    });
    es.addEventListener('watchlistArrived', (e) => {
      const d = JSON.parse(e.data);
      toast('🎬 ' + t('arrivedToast', { t: d.title }));
      loadWatchlist();
    });
    es.addEventListener('offlineDone', (e) => {
      const d = JSON.parse(e.data);
      toast('⬇ ' + t('offlineDoneToast', { t: d.title }));
      setMediaVersion((v) => v + 1);
      refreshHome();
    });
    es.addEventListener('mediaUpdated', () => { setMediaVersion((v) => v + 1); refreshHome(); });
    return () => es.close();
  }, [ready, toast, t, refreshHome, loadWatchlist]);

  /* ---- nav solid on scroll ---- */
  useEffect(() => {
    const s = () => setSolid(window.scrollY > 40);
    window.addEventListener('scroll', s);
    return () => window.removeEventListener('scroll', s);
  }, []);

  /* ---- custom context menu ---- */
  const openCtxMenu = useCallback((e, menu) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, ...menu });
  }, []);

  // suppress the browser menu app-wide; empty areas get a small app menu
  useEffect(() => {
    const handler = (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable]')) return; // keep native for text fields
      if (e.defaultPrevented) return;                                       // a card already opened its menu
      e.preventDefault();
      const items = [];
      if (canRef.current('editMedia')) {
        items.push({
          label: t('ctxScan'), icon: I.refresh,
          onClick: async () => { await api.post('/scan').catch(() => { }); },
        });
      }
      if (canRef.current('settings')) {
        items.push({ label: t('settings'), icon: I.gear, onClick: () => { setView('settings'); window.scrollTo({ top: 0 }); } });
      }
      items.push({ label: t('ctxReload'), icon: I.globe, onClick: () => location.reload() });
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, [t]);
  const canRef = useRef(() => false);

  /* ---- search ---- */
  const doSearch = useMemo(() => debounce(async (needle) => {
    if (!needle.trim()) { setResults(null); return; }
    try { setResults(await api.get('/library?q=' + encodeURIComponent(needle))); } catch { }
  }, 250), []);
  useEffect(() => { doSearch(q); }, [q, doSearch]);

  /* ---- play flow: always fetch full detail (intro marker, next ep, progress) ---- */
  const playItem = useCallback(async (itemOrId, opts = {}) => {
    const id = typeof itemOrId === 'object' ? itemOrId.id : itemOrId;
    try {
      let detail = await api.get('/media/' + id);
      // A series has no file itself: play first unwatched episode instead.
      if (detail.type === 'series' && detail.episodes?.length) {
        const next = detail.episodes.find((e) => !e.progress?.watched) || detail.episodes[0];
        detail = await api.get('/media/' + next.id);
      }
      setDetailId(null);
      setWatch({ ...detail, startAt: opts.startAt });
    } catch { toast(t('error'), 'err'); }
  }, [toast, t]);

  const closePlayer = useCallback(() => { setWatch(null); refreshHome(); }, [refreshHome]);

  /* ---- cast to a DLNA renderer ---- */
  const startCast = useCallback(async (media, renderer) => {
    try {
      await api.post('/cast/play', { mediaId: media.id, renderer: renderer.id });
      setCasting({ renderer, media: { id: media.id, title: media.title } });
      toast('▶ ' + t('castStarted', { name: renderer.name }));
      return true;
    } catch (e) { toast(t('castFailed', { err: e.data?.error || e.message }), 'err'); return false; }
  }, [toast, t]);
  const stopCast = useCallback(() => {
    setCasting((c) => { if (c) api.post('/cast/control', { renderer: c.renderer.id, action: 'stop' }).catch(() => { }); return null; });
  }, []);

  const logout = () => { setToken(''); setUser(null); setMenu(false); loadStatus(); };

  /* ---- render gates ---- */
  if (statusErr) return (
    <div className="nb-center"><div className="nb-wizard" style={{ textAlign: 'center' }}>
      <h1>NEBULA</h1>
      <p className="sub">Server unreachable. Is <code>node server/index.js</code> running?</p>
      <button className="nb-btn play" onClick={loadStatus}>{t('retry')}</button>
    </div></div>
  );
  if (!status) return <div className="nb-center"><div className="nb-badge"><span className="nb-dot" />{t('loading')}</div></div>;

  const i18nVal = { locale, t, setLocale };
  const kidMode = !status.authEnabled && !!user?.profile?.kid;
  const appVal = {
    status, user, setUser, home, refreshHome, toast, t, locale, setLocale,
    hue, setHue, playItem, openDetail: setDetailId, loadStatus,
    watchlist: new Set(watchlistItems.map((w) => w.tmdbId)), watchlistItems, toggleWant,
    myListIds: new Set((home?.myList || []).map((m) => m.id)),
    openCtxMenu, mediaVersion,
    casting, startCast, stopCast, pickCast: setCastPickFor,
    switchProfile: () => { setProfile(0); setProfileChosen(false); setHome(null); },
    can: (perm) => {
      if (!status.authEnabled) return !kidMode || ['music', 'images'].includes(perm);
      return user && (user.role === 'admin' || user.perms?.[perm]);
    },
  };
  canRef.current = appVal.can;

  if (!status.setupComplete) return (
    <I18nContext.Provider value={i18nVal}><AppCtx.Provider value={appVal}>
      <SetupWizard onDone={async (tok) => { if (tok) setToken(tok); await loadStatus(); }} />
    </AppCtx.Provider></I18nContext.Provider>
  );

  if (status.authEnabled && !user) return (
    <I18nContext.Provider value={i18nVal}><AppCtx.Provider value={appVal}>
      <AuthView onAuth={(u, tok) => { setToken(tok); setUser(u); loadStatus(); }} />
    </AppCtx.Provider></I18nContext.Provider>
  );

  if (needProfile) return (
    <I18nContext.Provider value={i18nVal}><AppCtx.Provider value={appVal}>
      <ProfilesGate onPick={(p) => {
        setProfile(p ? p.id : 0);
        if (p?.hue) setHue(p.hue, false);
        setProfileChosen(true);
        loadStatus();
      }} />
    </AppCtx.Provider></I18nContext.Provider>
  );

  const stats = home?.stats || status.stats || {};
  const showSection = (key) => {
    if (key === 'music') return appVal.can('music');
    if (key === 'images') return appVal.can('images');
    return true;
  };

  return (
    <I18nContext.Provider value={i18nVal}>
      <AppCtx.Provider value={appVal}>
        <nav className={'nb-nav' + (solid ? ' solid' : '')}>
          <div className="nb-logo" onClick={() => { setView('home'); setQ(''); window.scrollTo({ top: 0 }); }}>
            <span className="mark" />{status.appName || 'Nebula'}
          </div>
          <div className="nb-links">
            {NAV_VIEWS.filter((n) => showSection(n.key)).map((n) => (
              <button key={n.key} className={view === n.key ? 'on' : ''}
                onClick={() => { setView(n.key); setQ(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                {t(n.key)}
              </button>
            ))}
          </div>
          <div className="nb-right">
            <div className={'nb-search' + (searchOn || q ? ' on' : '')}>
              <span style={{ color: 'var(--muted)', display: 'flex' }}>{I.search}</span>
              {(searchOn || q) ? (
                <input autoFocus placeholder={t('searchPlaceholder')} value={q}
                  onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setSearchOn(false)} />
              ) : (
                <button onClick={() => setSearchOn(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 14 }}>
                  {t('search')}
                </button>
              )}
            </div>
            <div className="nb-pill"><span className="live" />NAS · {fmtBytes(stats.totalBytes || 0)}</div>
            {appVal.can('editMedia') && <DownloadsMenu />}
            {appVal.can('upload') && (
              <button className="nb-ico" title={t('upload')} onClick={() => setShowUpload(true)}>{I.upload}</button>
            )}
            {appVal.can('settings') && (
              <button className="nb-ico" title={t('settings')} onClick={() => { setView('settings'); window.scrollTo({ top: 0 }); }}>{I.gear}</button>
            )}
            <button className="nb-avatar" onClick={() => setMenu((m) => !m)}>
              {(user?.username || 'N')[0]}
            </button>
          </div>
        </nav>

        {menu && (
          <div className="nb-menu" onMouseLeave={() => setMenu(false)}>
            <div className="k">{user ? user.username : status.appName}</div>
            {appVal.can('editMedia') && (
              <button onClick={() => { setShowAddStream(true); setMenu(false); }}>{I.link} {t('addStream')}</button>
            )}
            <div className="k">{t('language')}</div>
            {Object.entries(LOCALES).map(([code, name]) => (
              <button key={code} onClick={() => { setLocale(code); setMenu(false); }}>
                {locale === code ? I.check : I.globe} {name}
              </button>
            ))}
            {!status.authEnabled && status.profilesEnabled && (
              <><div className="sep" /><button onClick={() => { appVal.switchProfile(); setMenu(false); }}>{I.users} {t('whoWatching')}</button></>
            )}
            {status.authEnabled && user && (<><div className="sep" /><button onClick={logout}>{I.logout} {t('logout')}</button></>)}
          </div>
        )}

        {view === 'settings' ? (
          <SettingsView />
        ) : results !== null && q ? (
          <SearchResults q={q} results={results} />
        ) : (
          <>
            {view === 'home' && <HomeView />}
            {view === 'movies' && <LibraryGridView type="movie" titleKey="allMovies" />}
            {view === 'series' && <LibraryGridView type="series" titleKey="allSeries" />}
            {view === 'music' && <MusicView />}
            {view === 'images' && <ImagesView />}
            {view === 'myList' && <MyListView />}
          </>
        )}

        <footer className="nb-foot">
          <div>{status.appName || 'NEBULA'} · self-hosted media · v1.0</div>
          <div>
            {(stats.movies || 0) + (stats.series || 0)} {t('titles')} · {stats.episodes || 0} {t('episodes').toLowerCase()} · {stats.tracks || 0} ♪ · {stats.images || 0} ▣
          </div>
        </footer>

        <div className="nb-mobile-nav">
          {NAV_VIEWS.filter((n) => showSection(n.key)).map((n) => (
            <button key={n.key} className={view === n.key ? 'on' : ''}
              onClick={() => { setView(n.key); setQ(''); window.scrollTo({ top: 0 }); }}>
              {n.icon}<span>{t(n.key)}</span>
            </button>
          ))}
        </div>

        {detailId && <DetailModal id={detailId} onClose={() => setDetailId(null)} />}
        {watch && <Player media={watch} onClose={closePlayer} onPlayOther={(id, opts) => playItem(id, opts)} />}
        {showUpload && <UploadModal onClose={() => { setShowUpload(false); refreshHome(); }} />}
        {showAddStream && <AddStreamModal onClose={() => { setShowAddStream(false); refreshHome(); }} />}

        {ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}

        {castPickFor && <CastPicker media={castPickFor} onClose={() => setCastPickFor(null)} />}
        <CastBar />

        <div className="nb-toasts">
          {toasts.map((x) => <div key={x.id} className={'nb-toast ' + x.kind}>{x.msg}</div>)}
        </div>
      </AppCtx.Provider>
    </I18nContext.Provider>
  );
}

/* ---------- small inline views ---------- */
import { Row, Grid } from './components/Cards.jsx';

function SearchResults({ q, results }) {
  const { t } = React.useContext(I18nContext);
  return (
    <div className="nb-rows" style={{ paddingTop: 30, minHeight: '60vh' }}>
      <div className="nb-row-head"><h2>{t('resultsFor', { q })}</h2><span className="sub">{results.length} {t('titles')}</span></div>
      {results.length
        ? <Grid items={results} />
        : <div className="nb-empty">{t('noResults', { q })}</div>}
    </div>
  );
}

function LibraryGridView({ type, titleKey }) {
  const { t } = React.useContext(I18nContext);
  const { mediaVersion } = React.useContext(AppCtx);
  const [items, setItems] = useState(null);
  const [sort, setSort] = useState('title');
  const [genre, setGenre] = useState('');
  useEffect(() => {
    api.get(`/library?type=${type}&sort=${sort}` + (genre ? `&genre=${encodeURIComponent(genre)}` : ''))
      .then(setItems).catch(() => setItems([]));
  }, [type, sort, genre, mediaVersion]);
  const genres = useMemo(() => {
    const s = new Set();
    for (const it of items || []) for (const g of it.genres || []) s.add(g);
    return [...s].sort();
  }, [items]);
  if (!items) return <div className="nb-empty">{t('loading')}</div>;
  return (
    <div className="nb-rows" style={{ paddingTop: 30, minHeight: '60vh' }}>
      <div className="nb-row-head" style={{ alignItems: 'center', gap: 16 }}>
        <h2>{t(titleKey)}</h2><span className="sub">{items.length} {t('titles')}</span>
        <span style={{ flex: 1 }} />
        {genres.length > 0 && (
          <select className="nb-input" style={{ padding: '7px 30px 7px 11px', fontSize: 13 }} value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">All genres</option>
            {genres.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <select className="nb-input" style={{ padding: '7px 30px 7px 11px', fontSize: 13 }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="title">A–Z</option>
          <option value="added">{t('recentlyAdded')}</option>
          <option value="rating">{t('topRated')}</option>
          <option value="year">{t('released')}</option>
        </select>
      </div>
      {items.length ? <Grid items={items} /> : <div className="nb-empty">{t('emptyLibrary')}</div>}
    </div>
  );
}

function MyListView() {
  const { t } = React.useContext(I18nContext);
  const { home } = React.useContext(AppCtx);
  const items = home?.myList || [];
  return (
    <div className="nb-rows" style={{ paddingTop: 30, minHeight: '60vh' }}>
      <div className="nb-row-head"><h2>{t('myList')}</h2><span className="sub">{items.length} {t('titles')}</span></div>
      {items.length ? <Grid items={items} /> : <div className="nb-empty">{t('emptyList')}</div>}
    </div>
  );
}
