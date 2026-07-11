// Main REST API.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, getSetting, setSetting, getAllSettings, mediaRow } = require('./db');
const { UPLOAD_TMP, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, PORT } = require('./config');
const cast = require('./cast');
const gcast = require('./gcast');
const { authMiddleware, requireUser, requirePerm, createAdmin } = require('./auth');
const scanner = require('./scanner');
const tmdb = require('./tmdb');
const intro = require('./intro');
const mailer = require('./mailer');
const backup = require('./backup');
const downloader = require('./downloader');
const { srtToVtt, subtitleLang, parseMovieName, parseEpisode, sortTitle } = require('./util');

const router = express.Router();
router.use(authMiddleware);

/* ---------- public status (also pre-setup / pre-login) ---------- */
router.get('/status', (req, res) => {
  res.json({
    appName: getSetting('appName'),
    setupComplete: !!getSetting('setupComplete'),
    authEnabled: !!getSetting('authEnabled'),
    allowRegistration: !!getSetting('allowRegistration'),
    defaultHue: getSetting('defaultHue'),
    defaultLocale: getSetting('defaultLocale'),
    ui: getSetting('ui'),
    playback: getSetting('playback'),
    hasTmdb: tmdb.hasKey(),
    ffmpeg: require('./ffmpeg').available(),
    profilesEnabled: !!getSetting('profilesEnabled'),
    dlnaEnabled: !!getSetting('dlnaEnabled'),
    offlineMode: !!getSetting('offlineMode'),
    user: req.user,
    stats: scanner.libraryStats(),
  });
});

/* ---------- first-run setup ---------- */
router.post('/setup', async (req, res) => {
  if (getSetting('setupComplete')) return res.status(403).json({ error: 'already_setup' });
  const b = req.body || {};
  if (b.appName) setSetting('appName', String(b.appName).slice(0, 40));
  if (b.defaultLocale) setSetting('defaultLocale', b.defaultLocale);
  if (b.defaultHue != null) setSetting('defaultHue', Number(b.defaultHue));
  if (b.libraryPaths) setSetting('libraryPaths', b.libraryPaths);
  if (b.tmdbApiKey !== undefined) setSetting('tmdbApiKey', String(b.tmdbApiKey).trim());
  if (b.smtp) setSetting('smtp', b.smtp);
  let token = null;
  if (b.authEnabled && b.admin && b.admin.username && b.admin.password) {
    const admin = createAdmin(b.admin.username, b.admin.password, b.admin.email);
    setSetting('authEnabled', true);
    setSetting('allowRegistration', !!b.allowRegistration);
    token = require('./auth').signToken(admin);
  } else {
    setSetting('authEnabled', false);
  }
  setSetting('setupComplete', true);
  // kick off initial scan + enrichment in background
  setImmediate(() => runScan());
  res.json({ ok: true, token });
});

/* ---------- auth gate for everything below ---------- */
router.use((req, res, next) => {
  if (!getSetting('authEnabled')) return next();
  // DLNA renderers can't authenticate — allow bare streaming when DLNA is on
  if (getSetting('dlnaEnabled') && /^\/stream\/\d+(\.\w+)?$/.test(req.path)) return next();
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  next();
});

/* kid profiles: hide age-inappropriate titles */
const KID_BLOCK = new Set(['R', 'NC-17', 'TV-MA', 'M', '16', '18', 'FSK 16', 'FSK 18', 'UNRATED 18']);
const kidOk = (m) => !m.cert || !KID_BLOCK.has(String(m.cert).toUpperCase());
const kidFilter = (req, items) => (req.kidMode ? items.filter(kidOk) : items);

/* ---------- library ---------- */
function attachProgress(items, userId) {
  const map = {};
  for (const p of db.prepare('SELECT media_id, position, duration, watched FROM progress WHERE user_id = ?').all(userId)) {
    map[p.media_id] = p;
  }
  for (const it of items) {
    const p = map[it.id];
    if (p && p.duration > 0) {
      it.progress = { position: p.position, duration: p.duration, pct: Math.min(100, Math.round((p.position / p.duration) * 100)), watched: !!p.watched };
    }
  }
  return items;
}

/* Collapse cards that resolve to the same title+year (same movie stored in two
   library folders, or mis-parsed files that got the same metadata) into one,
   keeping the richest/playable representative. Preserves input order. */
const cardScore = (it) => (it.poster ? 4 : 0) + (it.path ? 2 : 0) + (it.tmdbId ? 1 : 0);
function dedupeCards(items) {
  const best = new Map();
  for (const it of items) {
    const key = it.type + '|' + sortTitle(it.title || '') + '|' + (it.year || '');
    const cur = best.get(key);
    if (!cur || cardScore(it) > cardScore(cur)) best.set(key, it);
  }
  const kept = new Set(best.values());
  return items.filter((it) => kept.has(it));
}

router.get('/library', (req, res) => {
  const { type, genre, q, sort, limit, offset } = req.query;
  let rows = db.prepare("SELECT * FROM media WHERE missing = 0 AND type != 'episode'").all().map(mediaRow);
  rows = kidFilter(req, rows);
  if (type) rows = rows.filter((r) => r.type === type);
  if (genre) rows = rows.filter((r) => r.genres.includes(genre));
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) =>
      r.title.toLowerCase().includes(needle) ||
      (r.artist || '').toLowerCase().includes(needle) ||
      (r.album || '').toLowerCase().includes(needle) ||
      r.genres.some((g) => g.toLowerCase().includes(needle)));
  }
  rows = dedupeCards(rows);
  if (sort === 'added') rows.sort((a, b) => b.addedAt - a.addedAt);
  else if (sort === 'rating') rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  else if (sort === 'year') rows.sort((a, b) => (b.year || 0) - (a.year || 0));
  else rows.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const total = rows.length;
  if (limit) rows = rows.slice(Number(offset) || 0, (Number(offset) || 0) + Number(limit));
  res.setHeader('X-Total-Count', total);
  res.json(attachProgress(rows, req.user.id));
});

/** Aggregated home payload: hero + all rows in one request. */
router.get('/home', async (req, res) => {
  const uid = req.user.id;
  const allFull = kidFilter(req, db.prepare("SELECT * FROM media WHERE missing = 0 AND type IN ('movie','series')").all().map(mediaRow));
  const all = dedupeCards(allFull);
  attachProgress(all, uid);

  const progressRows = db.prepare(
    `SELECT p.*, m.type, m.parent_id FROM progress p JOIN media m ON m.id = p.media_id
     WHERE p.user_id = ? AND p.watched = 0 AND p.position > 30 ORDER BY p.updated_at DESC LIMIT 20`).all(uid);
  const contIds = [];
  const seenSeries = new Set();
  for (const p of progressRows) {
    if (p.type === 'episode') {
      if (seenSeries.has(p.parent_id)) continue;
      seenSeries.add(p.parent_id);
    }
    contIds.push(p.media_id);
  }
  const continueWatching = contIds
    .map((id) => {
      const m = mediaRow(db.prepare('SELECT * FROM media WHERE id = ? AND missing = 0').get(id));
      if (!m || (req.kidMode && !kidOk(m))) return null;
      if (m.type === 'episode') {
        const parent = mediaRow(db.prepare('SELECT * FROM media WHERE id = ?').get(m.parentId));
        m.seriesTitle = parent?.title;
        m.backdrop = m.backdrop || parent?.backdrop;
        m.poster = m.poster || parent?.poster;
      }
      return m;
    })
    .filter(Boolean).slice(0, 12);
  attachProgress(continueWatching, uid);

  const myListIds = db.prepare('SELECT media_id FROM my_list WHERE user_id = ? ORDER BY added_at DESC').all(uid).map((r) => r.media_id);
  const myList = myListIds.map((id) => allFull.find((m) => m.id === id)).filter(Boolean);

  const recent = [...all].sort((a, b) => b.addedAt - a.addedAt).slice(0, 15);
  const topRated = [...all].filter((m) => m.rating).sort((a, b) => b.rating - a.rating).slice(0, 15);

  // genre rows: most common genres first
  const genreCount = {};
  for (const m of all) for (const g of m.genres) genreCount[g] = (genreCount[g] || 0) + 1;
  const genres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const genreRows = genres.slice(0, 8).map((g) => ({
    genre: g,
    items: all.filter((m) => m.genres.includes(g)).slice(0, 15),
  })).filter((r) => r.items.length >= 2);

  let trending = [];
  try { trending = await tmdb.getTrending(); } catch { }
  // top 10 on the server: library titles that are currently trending, by popularity
  const top10 = trending.filter((t) => t.localId).slice(0, 10)
    .map((t, i) => ({ rank: i + 1, ...t, item: allFull.find((m) => m.id === t.localId) })).filter((t) => t.item);

  const hero = topRated[0] || recent[0] || all[0] || null;
  res.json({
    hero, continueWatching, myList, recent, topRated,
    movies: all.filter((m) => m.type === 'movie'),
    series: all.filter((m) => m.type === 'series'),
    genreRows, genres, trending, top10,
    stats: scanner.libraryStats(),
  });
});

router.get('/media/:id', async (req, res) => {
  const id = Number(req.params.id);
  const item = mediaRow(db.prepare('SELECT * FROM media WHERE id = ?').get(id));
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (req.kidMode && !kidOk(item)) return res.status(403).json({ error: 'kid_restricted' });
  attachProgress([item], req.user.id);

  const out = { ...item };
  if (item.type === 'series') {
    const episodes = db.prepare('SELECT * FROM media WHERE parent_id = ? AND missing = 0 ORDER BY season, episode').all(id).map(mediaRow);
    attachProgress(episodes, req.user.id);
    out.episodes = episodes;
    out.seasons = [...new Set(episodes.map((e) => e.season || 1))].sort((a, b) => a - b);
    out.introMarker = intro.getMarker(id, 0);
  }
  if (item.type === 'episode') {
    const parent = mediaRow(db.prepare('SELECT * FROM media WHERE id = ?').get(item.parentId));
    out.series = parent;
    // Manual season marker wins; otherwise use the precise per-episode window
    // (handles variable cold opens), falling back to the season-level marker.
    const seasonM = intro.getMarker(item.parentId, item.season || 0);
    out.introMarker = (seasonM && seasonM.source === 'manual') ? seasonM
      : (intro.getEpisodeMarker(item.id) || seasonM);
    const next = db.prepare(
      `SELECT * FROM media WHERE parent_id = ? AND missing = 0 AND (season > ? OR (season = ? AND episode > ?))
       ORDER BY season, episode LIMIT 1`).get(item.parentId, item.season || 0, item.season || 0, item.episode || 0);
    out.nextEpisode = mediaRow(next);
  }
  out.reviews = db.prepare('SELECT * FROM reviews WHERE media_id = ? ORDER BY created_at DESC').all(
    item.type === 'episode' ? item.parentId : id);
  out.inMyList = !!db.prepare('SELECT 1 FROM my_list WHERE user_id = ? AND media_id = ?').get(req.user.id, id);
  res.json(out);
});

router.get('/similar/:id', async (req, res) => {
  res.json(await tmdb.getSimilar(Number(req.params.id)));
});

router.get('/trending', async (req, res) => {
  try { res.json(await tmdb.getTrending()); } catch { res.json([]); }
});

/* ---------- add / edit external streams & media ---------- */
const STREAM_SOURCES = ['youtube', 'vimeo', 'dailymotion', 'streamtape', 'voe', 'vizoa', 'spotify', 'soundcloud', 'url'];

router.post('/media', requirePerm('editMedia'), (req, res) => {
  const b = req.body || {};
  if (!b.type) return res.status(400).json({ error: 'type_required' });
  if (!b.externalUrl) return res.status(400).json({ error: 'external_url_required' });
  const source = STREAM_SOURCES.includes(b.source) ? b.source : 'url';
  // title is optional — when omitted we store the URL and fetchMeta fills the
  // real title/year/artwork automatically from the source.
  const title = (b.title && String(b.title).trim()) || String(b.externalUrl);
  const info = db.prepare(
    `INSERT INTO media (type, title, sort_title, year, genres, overview, poster, backdrop, source, external_url, artist, album, added_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      ['movie', 'series', 'track'].includes(b.type) ? b.type : 'movie',
      String(title).slice(0, 200), sortTitle(title), b.year || null,
      JSON.stringify(Array.isArray(b.genres) ? b.genres : []),
      b.overview || null, b.poster || null, b.backdrop || null,
      source, String(b.externalUrl).slice(0, 1000),
      b.artist || null, b.album || null, Date.now(), Date.now());
  const id = Number(info.lastInsertRowid);
  // 1) fetch the real title/year from the source, 2) THEN TMDB-enrich movies/
  // series using that clean title, 3) store the stream locally for offline.
  downloader.fetchMeta(id)
    .catch(() => { })
    .then(() => {
      if ((b.type === 'movie' || b.type === 'series') && tmdb.hasKey() && b.enrich !== false) {
        tmdb.enrichItem(id).catch(() => { });
      }
      downloader.enqueue(id);
      require('./events').emit('global', 'mediaUpdated', { id });
    });
  res.json(mediaRow(db.prepare('SELECT * FROM media WHERE id = ?').get(id)));
});

router.put('/media/:id', requirePerm('editMedia'), (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const fields = { title: 'title', year: 'year', overview: 'overview', poster: 'poster', backdrop: 'backdrop', trailerKey: 'trailer_key', cert: 'cert', externalUrl: 'external_url', artist: 'artist', album: 'album' };
  for (const [k, col] of Object.entries(fields)) {
    if (b[k] !== undefined) db.prepare(`UPDATE media SET ${col} = ?, updated_at = ? WHERE id = ?`).run(b[k] || null, Date.now(), id);
  }
  if (b.genres !== undefined) db.prepare('UPDATE media SET genres = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(b.genres || []), Date.now(), id);
  if (b.title) db.prepare('UPDATE media SET sort_title = ? WHERE id = ?').run(sortTitle(b.title), id);
  require('./events').emit('global', 'mediaUpdated', { id });
  res.json(mediaRow(db.prepare('SELECT * FROM media WHERE id = ?').get(id)));
});

router.delete('/media/:id', requirePerm('deleteMedia'), (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const deleteFile = req.query.file === '1';
  const ids = [id, ...db.prepare('SELECT id FROM media WHERE parent_id = ?').all(id).map((r) => r.id)];
  for (const mid of ids) {
    const row = db.prepare('SELECT path FROM media WHERE id = ?').get(mid);
    if (deleteFile && row?.path) { try { fs.unlinkSync(row.path); } catch { } }
    db.prepare('DELETE FROM media WHERE id = ?').run(mid);
    db.prepare('DELETE FROM progress WHERE media_id = ?').run(mid);
    db.prepare('DELETE FROM my_list WHERE media_id = ?').run(mid);
    db.prepare('DELETE FROM reviews WHERE media_id = ?').run(mid);
  }
  res.json({ ok: true, removed: ids.length });
});

router.post('/media/:id/refresh-metadata', requirePerm('editMedia'), async (req, res) => {
  try {
    const r = await tmdb.enrichItem(Number(req.params.id));
    require('./events').emit('global', 'mediaUpdated', { id: Number(req.params.id) });
    res.json(r);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

/* ---------- scanning & enrichment ---------- */
let enrichState = { running: false, done: 0, total: 0 };

function runScan() {
  const result = scanner.scanLibrary();
  if (result.busy) return result;
  if (result.newItems?.length) {
    mailer.notifyNewMedia(result.newItems).catch(() => { });
    require('./events').emit('global', 'newMedia', {
      count: result.newItems.length,
      titles: result.newItems.slice(0, 5).map((i) => i.title),
    });
    if (tmdb.hasKey()) runEnrich();
  }
  // background: fill durations/codecs, auto-detect intros by audio
  require('./ffmpeg').probePending().then(() => {
    // probing generates thumbnails/durations — nudge open views to refetch
    require('./events').emit('global', 'mediaUpdated', {});
    require('./introAudio').detectAllPending().catch(() => { });
  }).catch(() => { });
  return result;
}

function runEnrich() {
  if (enrichState.running) return;
  enrichState = { running: true, done: 0, total: 0 };
  tmdb.enrichAllPending((done, total) => { enrichState.done = done; enrichState.total = total; })
    .finally(() => {
      enrichState.running = false;
      mailer.checkWatchlistArrivals().catch(() => { });
    });
}

router.post('/scan', requirePerm('editMedia'), (req, res) => {
  setImmediate(() => runScan());
  res.json({ started: true });
});

router.get('/scan/status', (req, res) => {
  res.json({ ...scanner.libraryStats(), enrich: enrichState });
});

router.post('/enrich', requirePerm('editMedia'), (req, res) => {
  runEnrich();
  res.json({ started: true });
});

/* ---------- cast to a DLNA renderer (TV / speaker) ---------- */
const CAST_MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/avi', '.mov': 'video/quicktime', '.ts': 'video/mpeg', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const escXml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function castDidl(item, uri, mime) {
  const cls = mime.startsWith('audio/') ? 'object.item.audioItem.musicTrack'
    : mime.startsWith('image/') ? 'object.item.imageItem.photo' : 'object.item.videoItem.movie';
  const flags = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">`
    + `<item id="0" parentID="-1" restricted="1"><dc:title>${escXml(item.title)}</dc:title><upnp:class>${cls}</upnp:class>`
    + (item.artist ? `<upnp:artist>${escXml(item.artist)}</upnp:artist>` : '')
    + `<res protocolInfo="http-get:*:${mime}:${flags}">${escXml(uri)}</res></item></DIDL-Lite>`;
}

const isGcast = (id) => String(id || '').startsWith('gcast:');
const castDevice = (id) => (isGcast(id) ? gcast.get(id) : cast.get(id));

router.get('/cast/renderers', async (req, res) => {
  const [dlna, gc] = await Promise.all([
    cast.discover(2500).then((l) => l.map((d) => ({ ...d, proto: 'dlna' }))).catch(() => cast.list().map((d) => ({ ...d, proto: 'dlna' }))),
    gcast.discover(2500).catch(() => gcast.list()),
  ]);
  res.json([...dlna, ...gc]);
});

router.post('/cast/play', async (req, res) => {
  const id = req.body?.renderer;
  const dev = castDevice(id);
  if (!dev) return res.status(404).json({ error: 'renderer_not_found' });
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.body?.mediaId));
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (!m.path) return res.status(400).json({ error: 'not_castable' }); // needs a local/downloaded file
  const ip = require('./dlna').bestLocalIp(dev.host || dev.addr);
  const ext = path.extname(m.path).toLowerCase();
  const mime = CAST_MIME[ext] || 'video/mp4';
  // include the file extension in the URL — some TVs/receivers pick the decoder from it
  const uri = `http://${ip}:${PORT}/api/stream/${m.id}${ext}`;
  let title = m.title;
  if (m.type === 'episode') {
    const parent = m.parent_id ? db.prepare('SELECT title FROM media WHERE id = ?').get(m.parent_id) : null;
    title = `${parent?.title || ''} S${String(m.season || 0).padStart(2, '0')}E${String(m.episode || 0).padStart(2, '0')} ${m.title}`.trim();
  }
  try {
    if (isGcast(id)) await gcast.playOn(dev, uri, mime, title);
    else await cast.play(dev, uri, castDidl({ ...m, title }, uri, mime));
    res.json({ ok: true, renderer: dev.name });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

router.post('/cast/control', async (req, res) => {
  const id = req.body?.renderer;
  const dev = castDevice(id);
  if (!dev) return res.status(404).json({ error: 'renderer_not_found' });
  const { action, position, volume } = req.body || {};
  try {
    if (isGcast(id)) {
      await gcast.control(dev, action, action === 'volume' ? volume : position);
    } else if (action === 'pause') await cast.pause(dev);
    else if (action === 'play') await cast.resume(dev);
    else if (action === 'stop') await cast.stop(dev);
    else if (action === 'seek') await cast.seek(dev, Number(position) || 0);
    else if (action === 'volume') await cast.setVolume(dev, Number(volume) || 0);
    else return res.status(400).json({ error: 'bad_action' });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

router.get('/cast/status', async (req, res) => {
  const id = req.query.renderer;
  const dev = castDevice(id);
  if (!dev) return res.status(404).json({ error: 'renderer_not_found' });
  try { res.json(isGcast(id) ? await gcast.status(dev) : await cast.status(dev)); }
  catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* ---------- offline downloads (save external streams locally) ---------- */
router.get('/offline/status', (req, res) => res.json(downloader.publicState()));

router.get('/offline/queue', (req, res) => res.json(downloader.queueList()));

router.post('/offline/download-all', requirePerm('editMedia'), (req, res) => {
  const queued = downloader.enqueuePending();
  res.json({ queued, ...downloader.publicState() });
});

router.post('/media/:id/download', requirePerm('editMedia'), (req, res) => {
  const item = db.prepare('SELECT external_url, path FROM media WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (!item.external_url) return res.status(400).json({ error: 'not_external' });
  if (item.path) return res.status(409).json({ error: 'already_local' });
  const ok = downloader.enqueue(Number(req.params.id));
  res.json({ ok, ...downloader.publicState() });
});

router.delete('/media/:id/offline', requirePerm('editMedia'), (req, res) => {
  const ok = downloader.removeOffline(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'not_downloaded' });
  res.json({ ok });
});

/* ---------- streaming ---------- */
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav', '.wma': 'audio/x-ms-wma',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

// DLNA renderers (TVs) key off the URL extension and these headers — without
// them many refuse the stream and show a black screen. `:id` tolerates a
// trailing extension (e.g. /stream/123.mkv) via parseInt.
router.get('/stream/:id', (req, res) => {
  const item = db.prepare('SELECT path FROM media WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!item?.path) return res.status(404).json({ error: 'not_found' });
  let st;
  try { st = fs.statSync(item.path); } catch { return res.status(404).json({ error: 'file_missing' }); }
  const mime = MIME[path.extname(item.path).toLowerCase()] || 'application/octet-stream';
  const isAV = mime.startsWith('video/') || mime.startsWith('audio/');
  const isHead = req.method === 'HEAD';
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('transferMode.dlna.org', req.headers['transfermode.dlna.org'] || (isAV ? 'Streaming' : 'Interactive'));
  res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (start >= st.size) { res.status(416).setHeader('Content-Range', `bytes */${st.size}`); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (isHead) return res.end();
    fs.createReadStream(item.path, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', st.size);
    if (isHead) return res.end();
    fs.createReadStream(item.path).pipe(res);
  }
});

/* ---------- subtitles ---------- */
router.get('/media/:id/subtitles', (req, res) => {
  const item = db.prepare('SELECT path FROM media WHERE id = ?').get(Number(req.params.id));
  if (!item?.path) return res.json([]);
  const base = path.basename(item.path).replace(/\.[^.]+$/, '');
  const subs = scanner.findSubtitles(item.path).map((p, i) => ({
    index: i, lang: subtitleLang(p, base), name: path.basename(p),
    url: `/api/media/${req.params.id}/subtitles/${i}.vtt`,
  }));
  res.json(subs);
});

router.get('/media/:id/subtitles/:index.vtt', (req, res) => {
  const item = db.prepare('SELECT path FROM media WHERE id = ?').get(Number(req.params.id));
  if (!item?.path) return res.status(404).end();
  const subs = scanner.findSubtitles(item.path);
  const sub = subs[Number(req.params.index)];
  if (!sub) return res.status(404).end();
  try {
    const text = fs.readFileSync(sub, 'utf8');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(srtToVtt(text));
  } catch { res.status(500).end(); }
});

/* ---------- progress ---------- */
router.get('/progress', (req, res) => {
  res.json(db.prepare('SELECT media_id, position, duration, watched, updated_at FROM progress WHERE user_id = ?').all(req.user.id));
});

router.post('/progress', (req, res) => {
  const { mediaId, position, duration } = req.body || {};
  if (!mediaId || position == null) return res.status(400).json({ error: 'bad_request' });
  const threshold = (getSetting('playback') || {}).watchedThreshold || 0.92;
  const watched = duration > 0 && position / duration >= threshold ? 1 : 0;
  db.prepare(`INSERT INTO progress (user_id, media_id, position, duration, watched, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id, media_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
      watched = MAX(watched, excluded.watched), updated_at = excluded.updated_at`)
    .run(req.user.id, Number(mediaId), Number(position), Number(duration) || 0, watched, Date.now());
  res.json({ ok: true, watched: !!watched });
});

router.delete('/progress/:mediaId', (req, res) => {
  db.prepare('DELETE FROM progress WHERE user_id = ? AND media_id = ?').run(req.user.id, Number(req.params.mediaId));
  res.json({ ok: true });
});

/* ---------- intro detection ---------- */
router.post('/skip-event', (req, res) => {
  const { mediaId, from, to } = req.body || {};
  const item = db.prepare('SELECT parent_id, season FROM media WHERE id = ?').get(Number(mediaId));
  if (!item?.parent_id) return res.json({ ok: false });
  const marker = intro.recordSkip(item.parent_id, item.season || 0, Number(from), Number(to));
  res.json({ ok: true, marker });
});

router.get('/intro/:mediaId', (req, res) => {
  const item = db.prepare('SELECT id, type, parent_id, season FROM media WHERE id = ?').get(Number(req.params.mediaId));
  if (!item) return res.json(null);
  const seriesId = item.type === 'episode' ? item.parent_id : item.id;
  res.json(intro.getMarker(seriesId, item.season || 0));
});

router.put('/intro/:seriesId', requirePerm('editMedia'), (req, res) => {
  const { season, start, end } = req.body || {};
  res.json(intro.setManualMarker(Number(req.params.seriesId), Number(season) || 0, Number(start) || 0, Number(end) || 0));
});

/* ---------- my list ---------- */
router.post('/list/:mediaId', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO my_list (user_id, media_id, added_at) VALUES (?,?,?)')
    .run(req.user.id, Number(req.params.mediaId), Date.now());
  res.json({ ok: true });
});

router.delete('/list/:mediaId', (req, res) => {
  db.prepare('DELETE FROM my_list WHERE user_id = ? AND media_id = ?').run(req.user.id, Number(req.params.mediaId));
  res.json({ ok: true });
});

/* ---------- upload ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\- ()\[\]]/g, '_')),
  }),
  limits: { fileSize: 64 * 1024 * 1024 * 1024 },
});

function moveFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(src, dest); }
  catch { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
}

router.post('/upload', requirePerm('upload'), upload.array('files', 50), (req, res) => {
  const kind = req.body.kind || 'movie'; // movie | episode | track | image
  const paths = getSetting('libraryPaths') || {};
  const rootMap = { movie: paths.movies?.[0], episode: paths.series?.[0], track: paths.music?.[0], image: paths.images?.[0] };
  const root = rootMap[kind];
  if (!root) return res.status(400).json({ error: 'no_library_path_for_kind', kind });
  const results = [];
  for (const f of req.files || []) {
    const original = f.originalname;
    const ext = path.extname(original).toLowerCase();
    const okExt = kind === 'track' ? AUDIO_EXT : kind === 'image' ? IMAGE_EXT : VIDEO_EXT;
    if (!okExt.includes(ext)) { try { fs.unlinkSync(f.path); } catch { } results.push({ file: original, error: 'bad_extension' }); continue; }
    let dest;
    const clean = getSetting('uploadCleanNames');
    if (kind === 'episode') {
      const show = String(req.body.seriesTitle || 'Unknown Show').replace(/[<>:"/\\|?*]/g, '').trim();
      const ep = parseEpisode(original);
      const season = Number(req.body.season) || ep?.season || 1;
      const name = clean && ep
        ? `${show} - S${String(season).padStart(2, '0')}E${String(ep.episode || 0).padStart(2, '0')}${ep.epTitle ? ' - ' + ep.epTitle.replace(/[<>:"/\\|?*]/g, '') : ''}${ext}`
        : original;
      dest = path.join(root, show, `Season ${String(season).padStart(2, '0')}`, name);
    } else if (kind === 'movie' && clean) {
      const { title, year } = parseMovieName(original);
      dest = path.join(root, `${title.replace(/[<>:"/\\|?*]/g, '')}${year ? ` (${year})` : ''}${ext}`);
    } else {
      dest = path.join(root, original);
    }
    try {
      moveFile(f.path, dest);
      results.push({ file: original, dest, ok: true });
    } catch (e) {
      results.push({ file: original, error: String(e.message) });
    }
  }
  setImmediate(() => runScan());
  res.json({ results });
});

/* ---------- settings ---------- */
const PUBLIC_SETTINGS = ['appName', 'defaultHue', 'defaultLocale', 'ui', 'playback', 'allowRegistration'];

router.get('/settings', (req, res) => {
  const all = getAllSettings();
  const isAdmin = req.user.role === 'admin' || req.user.perms?.settings;
  if (isAdmin) {
    const masked = { ...all, smtp: { ...all.smtp, pass: all.smtp?.pass ? '••••••' : '' } };
    return res.json(masked);
  }
  const pub = {};
  for (const k of PUBLIC_SETTINGS) pub[k] = all[k];
  res.json(pub);
});

const EDITABLE = ['appName', 'authEnabled', 'allowRegistration', 'tmdbApiKey', 'tmdbLanguage', 'libraryPaths',
  'scanIntervalMin', 'defaultHue', 'defaultLocale', 'smtp', 'notifyOnNewMedia', 'trendingRefreshHours',
  'playback', 'ui', 'introDefault', 'ffmpegPath', 'profilesEnabled', 'openSubtitles', 'dlnaEnabled',
  'backupSchedule', 'uploadCleanNames', 'offlineMode', 'offlinePath', 'ytdlpPath',
  'mdnsEnabled', 'localHostname'];

router.put('/settings', requirePerm('settings'), (req, res) => {
  const b = req.body || {};
  for (const key of EDITABLE) {
    if (b[key] === undefined) continue;
    if (key === 'smtp' && b.smtp?.pass === '••••••') b.smtp.pass = (getSetting('smtp') || {}).pass || '';
    if (key === 'authEnabled' && b[key] === true) {
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
      if (!admins) return res.status(400).json({ error: 'create_admin_first' });
    }
    setSetting(key, b[key]);
  }
  // re-detect yt-dlp if its path changed; start saving streams when offline mode
  // is switched on (existing external streams get queued in the background).
  if (b.ytdlpPath !== undefined) downloader.resetYtdlp();
  if (b.offlineMode === true) setImmediate(() => downloader.enqueuePending());
  // accent colour changed -> re-announce DLNA so TVs re-fetch the tinted icon
  if (b.defaultHue !== undefined && getSetting('dlnaEnabled')) { try { require('./dlna').notifyNow(); } catch { } }
  // hostname / mDNS toggle changed -> restart the .local responder
  if (b.localHostname !== undefined || b.mdnsEnabled !== undefined) { try { require('./mdns').restart(); } catch { } }
  res.json(getAllSettings());
});

router.post('/settings/test-tmdb', requirePerm('settings'), async (req, res) => {
  try { res.json({ ok: await tmdb.testKey(String(req.body?.key || getSetting('tmdbApiKey'))) }); }
  catch { res.json({ ok: false }); }
});

router.post('/settings/test-email', requirePerm('settings'), async (req, res) => {
  const to = req.body?.to || req.user.email;
  if (!to) return res.status(400).json({ error: 'no_recipient' });
  res.json(await mailer.sendTest(to));
});

router.get('/settings/email-log', requirePerm('settings'), (req, res) => res.json(mailer.emailLog()));

router.post('/settings/create-admin', (req, res) => {
  // allowed pre-authEnabled so the "enable auth" flow can bootstrap an admin
  const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
  if (getSetting('authEnabled') && admins && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { username, password, email } = req.body || {};
  if (!username || String(password || '').length < 4) return res.status(400).json({ error: 'invalid' });
  const admin = createAdmin(username, password, email);
  res.json({ user: admin, token: require('./auth').signToken(admin) });
});

/* ---------- browse server folders (for library path picker) ---------- */
router.get('/fs', requirePerm('settings'), (req, res) => {
  const dir = String(req.query.path || '');
  try {
    if (!dir) {
      // Windows drive roots or filesystem root
      if (process.platform === 'win32') {
        const drives = [];
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          try { fs.statSync(letter + ':\\'); drives.push({ name: letter + ':\\', path: letter + ':\\', dir: true }); } catch { }
        }
        return res.json({ path: '', entries: drives });
      }
      return res.json({ path: '/', entries: fs.readdirSync('/', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, path: '/' + d.name, dir: true })) });
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('@'))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: true }));
    res.json({ path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, entries });
  } catch (e) {
    res.status(400).json({ error: String(e.code || e.message) });
  }
});

/* ---------- backups ---------- */
router.get('/backups', requirePerm('settings'), (req, res) => res.json(backup.listBackups()));

router.post('/backups', requirePerm('settings'), (req, res) => {
  try { res.json(backup.createBackup()); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

router.get('/backups/:name/download', requirePerm('settings'), (req, res) => {
  const p = backup.backupPath(req.params.name);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.download(p);
});

router.delete('/backups/:name', requirePerm('settings'), (req, res) => {
  res.json({ ok: backup.deleteBackup(req.params.name) });
});

router.post('/backups/:name/restore', requirePerm('settings'), (req, res) => {
  const p = backup.backupPath(req.params.name);
  if (!p) return res.status(404).json({ error: 'not_found' });
  try {
    const result = backup.restoreBackup(p);
    res.json(result);
    setTimeout(() => process.exit(42), 500); // exit; launcher/user restarts with restored db
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

router.post('/backups/upload', requirePerm('settings'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  try {
    const result = backup.restoreBackup(req.file.path);
    fs.unlinkSync(req.file.path);
    res.json(result);
    setTimeout(() => process.exit(42), 500);
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});

module.exports = { router, runScan };
