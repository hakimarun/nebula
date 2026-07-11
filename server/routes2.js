// API extensions: playback info + HLS transcoding, thumbnails/frames, image
// cache, watchlist, fix-match, profiles, stats, watch-together, OpenSubtitles,
// filename cleanup, audio intro detection, SSE events.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting, mediaRow } = require('./db');
const { CACHE_DIR } = require('./config');
const { authMiddleware, requirePerm } = require('./auth');
const ffm = require('./ffmpeg');
const scanner = require('./scanner');
const introAudio = require('./introAudio');
const opensubs = require('./opensubs');
const syncRooms = require('./sync');
const { sseHandler } = require('./events');
const { subtitleLang, normalizeTitle, sortTitle } = require('./util');

const IMG_CACHE = path.join(CACHE_DIR, 'img');
fs.mkdirSync(IMG_CACHE, { recursive: true });

const router = express.Router();
router.use(authMiddleware);

/* SSE is used pre-gate for setup-less installs; token comes via query. */
router.get('/events', (req, res) => {
  if (getSetting('authEnabled') && !req.user) return res.status(401).end();
  sseHandler(req, res);
});

/* auth gate (mirrors routes.js). This router is mounted BEFORE routes.js, so
   its gate must let the public endpoints of the downstream router through —
   otherwise enabling auth locks out even the status/login bootstrap. */
router.use((req, res, next) => {
  if (!getSetting('authEnabled')) return next();
  if (req.path === '/status' || req.path === '/setup') return next();
  if (getSetting('dlnaEnabled') && /^\/stream\/\d+(\.\w+)?$/.test(req.path)) return next();
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  next();
});

const getMedia = (id) => db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id));

/* ---------- playback info: direct vs transcode + all subtitle sources ---------- */
router.get('/media/:id/playinfo', async (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw) return res.status(404).json({ error: 'not_found' });
  // probe on first play if needed, so the direct/transcode decision is accurate
  if (raw.path) await ffm.ensureProbe(raw).catch(() => { });
  const info = raw.path ? ffm.playInfo(raw) : { direct: true, external: true, audio: [], subs: [] };

  const subs = [];
  if (raw.path) {
    const base = path.basename(raw.path).replace(/\.[^.]+$/, '');
    scanner.findSubtitles(raw.path).forEach((p, i) => {
      subs.push({ kind: 'sidecar', lang: subtitleLang(p, base), name: path.basename(p), url: `/api/media/${raw.id}/subtitles/${i}.vtt` });
    });
    for (const s of info.subs || []) {
      if (s.text) subs.push({ kind: 'embedded', lang: s.lang, name: s.title || `embedded ${s.lang}`, url: `/api/media/${raw.id}/embsub/${s.index}.vtt` });
    }
    for (const c of opensubs.cachedSubs(raw.id)) {
      subs.push({ kind: 'opensubs', lang: 'dl', name: 'OpenSubtitles ' + c.fileId, url: `/api/media/${raw.id}/opensubs/${c.fileId}.vtt` });
    }
  }
  res.json({
    id: raw.id, direct: info.direct, reason: info.reason, canTranscode: !!info.canTranscode,
    ffmpeg: ffm.available(), video: info.video || null, audioTracks: info.audio || [],
    duration: raw.duration, subtitles: subs,
    openSubtitlesEnabled: opensubs.hasKey(),
  });
});

/* ---------- HLS transcode sessions ---------- */
router.post('/media/:id/hls', (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw?.path) return res.status(404).json({ error: 'not_found' });
  if (!ffm.available()) return res.status(501).json({ error: 'ffmpeg_missing' });
  const { start = 0, audio = 0, height = 0 } = req.body || {};
  try {
    const maxH = (getSetting('playback') || {}).maxHeight || 0;
    const s = ffm.startHls(raw, {
      start: Math.max(0, Number(start) || 0),
      audio: Number(audio) || 0,
      height: Number(height) || maxH || 0,
    });
    res.json({ sid: s.sid, start: s.start, playlist: `/api/hls/${s.sid}/index.m3u8` });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

router.get('/hls/:sid/:file', async (req, res) => {
  const s = ffm.touchSession(req.params.sid);
  if (!s) return res.status(404).end();
  const file = path.basename(req.params.file);
  const full = path.join(s.dir, file);
  if (file.endsWith('.m3u8')) {
    const pl = await ffm.waitForPlaylist(req.params.sid);
    if (!pl) return res.status(503).end();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(fs.readFileSync(pl, 'utf8'));
  }
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Content-Type', 'video/mp2t');
  fs.createReadStream(full).pipe(res);
});

router.delete('/hls/:sid', (req, res) => res.json({ ok: ffm.stopSession(req.params.sid) }));

/* ---------- embedded subtitles ---------- */
router.get('/media/:id/embsub/:idx.vtt', async (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw?.path) return res.status(404).end();
  const file = await ffm.extractSub(raw, Number(req.params.idx));
  if (!file) return res.status(404).end();
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  fs.createReadStream(file).pipe(res);
});

/* ---------- thumbnails, hover frames, image cache ---------- */
router.get('/thumb/:id.jpg', async (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw) return res.status(404).end();
  const file = await ffm.ensureThumb(mediaRow(raw));
  if (!file) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  fs.createReadStream(file).pipe(res);
});

router.get('/frame/:id.jpg', async (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw?.path) return res.status(404).end();
  const file = await ffm.frameAt(mediaRow(raw), Math.max(0, Number(req.query.at) || 0));
  if (!file) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  fs.createReadStream(file).pipe(res);
});

/** TMDB image proxy with disk cache — posters keep working offline. */
router.get('/img', async (req, res) => {
  const src = String(req.query.src || '');
  if (!/^https:\/\/image\.tmdb\.org\//.test(src)) return res.status(400).end();
  const key = crypto.createHash('md5').update(src).digest('hex') + '.img';
  const cached = path.join(IMG_CACHE, key);
  if (fs.existsSync(cached)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    return fs.createReadStream(cached).pipe(res);
  }
  try {
    const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(cached, buf);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    res.send(buf);
  } catch { res.status(502).end(); }
});

/* ---------- watchlist (want-to-see from trending) ---------- */
router.get('/watchlist', (req, res) => {
  const rows = db.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC').all(req.user.id);
  const byTmdb = new Map();
  for (const r of db.prepare('SELECT id, tmdb_id FROM media WHERE tmdb_id IS NOT NULL AND missing = 0').all()) byTmdb.set(r.tmdb_id, r.id);
  res.json(rows.map((r) => ({
    tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title, year: r.year,
    poster: r.poster, addedAt: r.added_at, localId: byTmdb.get(r.tmdb_id) ?? null,
  })));
});

router.post('/watchlist', (req, res) => {
  const { tmdbId, mediaType, title, year, poster } = req.body || {};
  if (!tmdbId || !title) return res.status(400).json({ error: 'bad_request' });
  db.prepare(`INSERT OR IGNORE INTO watchlist (user_id, tmdb_id, media_type, title, year, poster, added_at)
      VALUES (?,?,?,?,?,?,?)`)
    .run(req.user.id, Number(tmdbId), mediaType === 'tv' ? 'tv' : 'movie', String(title).slice(0, 200), year || null, poster || null, Date.now());
  res.json({ ok: true });
});

router.delete('/watchlist/:tmdbId', (req, res) => {
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND tmdb_id = ?').run(req.user.id, Number(req.params.tmdbId));
  res.json({ ok: true });
});

/* ---------- fix match: search TMDB + apply a specific id ---------- */
router.get('/tmdb/search', requirePerm('editMedia'), async (req, res) => {
  const { q, type } = req.query;
  const key = (getSetting('tmdbApiKey') || '').trim();
  if (!key) return res.status(400).json({ error: 'no_tmdb_key' });
  try {
    const kind = type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${key}&language=${getSetting('tmdbLanguage') || 'en-US'}&query=${encodeURIComponent(String(q || ''))}`;
    const data = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
    res.json((data.results || []).slice(0, 10).map((m) => ({
      tmdbId: m.id, title: m.title || m.name,
      year: Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || null,
      overview: (m.overview || '').slice(0, 200),
      poster: m.poster_path ? 'https://image.tmdb.org/t/p/w185' + m.poster_path : null,
      rating: m.vote_average || null,
    })));
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

router.post('/media/:id/match', requirePerm('editMedia'), async (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw) return res.status(404).json({ error: 'not_found' });
  const tmdbId = Number(req.body?.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: 'bad_request' });
  db.prepare('UPDATE media SET tmdb_id = ? WHERE id = ?').run(tmdbId, raw.id);
  try {
    const r = await require('./tmdb').enrichItem(raw.id);
    require('./events').emit('global', 'mediaUpdated', { id: raw.id });
    res.json(r);
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* ---------- profiles (auth-less household accounts) ---------- */
router.get('/profiles', (req, res) => {
  res.json({
    enabled: !!getSetting('profilesEnabled'),
    profiles: db.prepare('SELECT id, name, hue, kid FROM profiles ORDER BY id').all()
      .map((p) => ({ ...p, kid: !!p.kid })),
  });
});

router.post('/profiles', (req, res) => {
  if (req.kidMode) return res.status(403).json({ error: 'forbidden' });
  const { name, hue, kid } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name_required' });
  const info = db.prepare('INSERT INTO profiles (name, hue, kid, created_at) VALUES (?,?,?,?)')
    .run(String(name).trim().slice(0, 30), Number(hue) || 165, kid ? 1 : 0, Date.now());
  res.json({ id: Number(info.lastInsertRowid) });
});

router.put('/profiles/:id', (req, res) => {
  if (req.kidMode) return res.status(403).json({ error: 'forbidden' });
  const { name, hue, kid } = req.body || {};
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE profiles SET name = ?, hue = ?, kid = ? WHERE id = ?')
    .run(name !== undefined ? String(name).slice(0, 30) : p.name,
      hue !== undefined ? Number(hue) : p.hue,
      kid !== undefined ? (kid ? 1 : 0) : p.kid, p.id);
  res.json({ ok: true });
});

router.delete('/profiles/:id', (req, res) => {
  if (req.kidMode) return res.status(403).json({ error: 'forbidden' });
  const pid = Number(req.params.id);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(pid);
  db.prepare('DELETE FROM progress WHERE user_id = ?').run(1000000 + pid);
  db.prepare('DELETE FROM my_list WHERE user_id = ?').run(1000000 + pid);
  res.json({ ok: true });
});

/* ---------- statistics dashboard ---------- */
router.get('/stats/dashboard', (req, res) => {
  const watchTime = db.prepare(`
    SELECT p.user_id, SUM(MIN(p.position, COALESCE(p.duration, p.position))) secs, COUNT(*) titles
    FROM progress p GROUP BY p.user_id ORDER BY secs DESC`).all()
    .map((r) => {
      let name = 'guest';
      if (r.user_id >= 1000000) name = db.prepare('SELECT name FROM profiles WHERE id = ?').get(r.user_id - 1000000)?.name || 'profile';
      else if (r.user_id > 0) name = db.prepare('SELECT username FROM users WHERE id = ?').get(r.user_id)?.username || 'user';
      return { name, secs: r.secs || 0, titles: r.titles };
    });

  const mostWatched = db.prepare(`
    SELECT m.id, m.title, m.type, m.poster, m.backdrop, COUNT(*) plays, SUM(p.watched) completions
    FROM progress p JOIN media m ON m.id = p.media_id
    GROUP BY p.media_id ORDER BY plays DESC LIMIT 10`).all();

  const genreSecs = {};
  for (const r of db.prepare(`
    SELECT m.genres, m.parent_id, p.position FROM progress p JOIN media m ON m.id = p.media_id`).all()) {
    let genres = JSON.parse(r.genres || '[]');
    if (!genres.length && r.parent_id) {
      const par = db.prepare('SELECT genres FROM media WHERE id = ?').get(r.parent_id);
      genres = JSON.parse(par?.genres || '[]');
    }
    for (const g of genres) genreSecs[g] = (genreSecs[g] || 0) + (r.position || 0);
  }
  const topGenres = Object.entries(genreSecs).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([genre, secs]) => ({ genre, secs }));

  const growth = db.prepare(`
    SELECT strftime('%Y-%m', added_at / 1000, 'unixepoch') month, COUNT(*) added
    FROM media WHERE type IN ('movie','episode','track','image')
    GROUP BY month ORDER BY month DESC LIMIT 12`).all().reverse();

  res.json({ watchTime, mostWatched, topGenres, growth });
});

/* ---------- watch-together sync rooms ---------- */
router.post('/sync/create', (req, res) => {
  const { mediaId, name } = req.body || {};
  if (!getMedia(mediaId)) return res.status(404).json({ error: 'not_found' });
  res.json(syncRooms.createRoom(Number(mediaId), name || req.user.username));
});
router.post('/sync/join', (req, res) => {
  const r = syncRooms.joinRoom(req.body?.code, req.body?.name || req.user.username);
  if (!r) return res.status(404).json({ error: 'room_not_found' });
  res.json(r);
});
router.post('/sync/control', (req, res) => {
  const { code, clientId, action, position } = req.body || {};
  res.json({ ok: syncRooms.control(code, clientId, action, position) });
});
router.post('/sync/leave', (req, res) => {
  syncRooms.leaveRoom(req.body?.code, req.body?.clientId);
  res.json({ ok: true });
});

/* ---------- OpenSubtitles ---------- */
router.get('/media/:id/opensubs/search', async (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw) return res.status(404).json({ error: 'not_found' });
  const item = { ...raw, type: raw.type };
  if (raw.type === 'episode' && raw.parent_id) {
    const parent = getMedia(raw.parent_id);
    item.seriesTitle = parent?.title;
    item.imdb_id = parent?.imdb_id;
    item.tmdb_id = parent?.tmdb_id;
    item.season = raw.season; item.episode = raw.episode;
  }
  try { res.json(await opensubs.search(item)); }
  catch (e) { res.status(502).json({ error: String(e.message) }); }
});

router.post('/media/:id/opensubs/download', async (req, res) => {
  try {
    await opensubs.download(Number(req.params.id), req.body?.fileId);
    res.json({ ok: true, url: `/api/media/${req.params.id}/opensubs/${req.body.fileId}.vtt` });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

router.get('/media/:id/opensubs/:fileId.vtt', (req, res) => {
  const file = path.join(CACHE_DIR, 'opensubs', `${Number(req.params.id)}-${path.basename(req.params.fileId)}.vtt`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  fs.createReadStream(file).pipe(res);
});

/* ---------- naming assistant: rename file to clean "Title (Year)" form ---------- */
router.post('/media/:id/rename-clean', requirePerm('editMedia'), (req, res) => {
  const raw = getMedia(req.params.id);
  if (!raw?.path) return res.status(400).json({ error: 'no_file' });
  const ext = path.extname(raw.path);
  const dir = path.dirname(raw.path);
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '').trim();
  let base;
  if (raw.type === 'episode') {
    const parent = raw.parent_id ? getMedia(raw.parent_id) : null;
    base = `${safe(parent?.title || 'Show')} - S${String(raw.season || 0).padStart(2, '0')}E${String(raw.episode || 0).padStart(2, '0')}${raw.title ? ' - ' + safe(raw.title) : ''}`;
  } else {
    base = safe(raw.title) + (raw.year ? ` (${raw.year})` : '');
  }
  const dest = path.join(dir, base + ext);
  if (dest === raw.path) return res.json({ ok: true, path: dest, unchanged: true });
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'target_exists' });
  try {
    fs.renameSync(raw.path, dest);
    // move sidecar subs along
    const oldBase = path.basename(raw.path).replace(/\.[^.]+$/, '');
    for (const sub of scanner.findSubtitles(raw.path.replace(/[^\\/]*$/, path.basename(raw.path)))) {
      const subName = path.basename(sub);
      if (subName.startsWith(oldBase)) {
        try { fs.renameSync(sub, path.join(path.dirname(sub), base + subName.slice(oldBase.length))); } catch { }
      }
    }
    db.prepare('UPDATE media SET path = ?, updated_at = ? WHERE id = ?').run(dest, Date.now(), raw.id);
    res.json({ ok: true, path: dest });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

/* ---------- audio intro detection ---------- */
router.post('/intro/audio-detect/:seriesId', requirePerm('editMedia'), async (req, res) => {
  try { res.json(await introAudio.detectSeriesIntro(Number(req.params.seriesId), Number(req.body?.season) || 1)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

router.post('/intro/audio-detect-all', requirePerm('editMedia'), (req, res) => {
  // Full re-detect so per-episode windows are (re)built for every season.
  introAudio.detectAllPending(true).catch(() => { });
  res.json({ started: true });
});
router.get('/intro/audio-detect-status', (req, res) => res.json(introAudio.detectStatus()));

/* ---------- ffmpeg status ---------- */
router.get('/ffmpeg/status', (req, res) => {
  ffm.resetBins();
  res.json({ available: ffm.available(), sessions: ffm.sessions.size });
});

module.exports = { router };
