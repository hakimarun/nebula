// Offline downloader — saves external streams to a local folder so the library
// keeps working without a network connection. Uses yt-dlp when available (covers
// YouTube, SoundCloud, Vimeo, … and direct links); otherwise falls back to
// ffmpeg for HLS and a plain fetch for direct media files.
//
// On success the media row's `path` is set to the downloaded file while `source`
// stays the original platform — playback, thumbnails and streaming then all use
// the local copy. Per-item state lives in extra.offline; progress is pushed over
// SSE and also readable via GET /offline/status.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, getSetting, mediaRow } = require('./db');
const { DATA_DIR, ROOT } = require('./config');
const ffm = require('./ffmpeg');
const resolvers = require('./resolvers');
const { sortTitle, parseMovieName } = require('./util');
const { emit } = require('./events');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DIRECT_RE = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|flac|wav|ts)(\?|#|$)/i;
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i;
const HLS_RE = /\.m3u8(\?|#|$)/i;

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function offlineDir() {
  const custom = (getSetting('offlinePath') || '').trim();
  const dir = custom || path.join(DATA_DIR, 'offline');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  return dir;
}

function safeName(s) {
  return String(s || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 120) || 'download';
}

/* ---------- yt-dlp discovery (mirrors ffmpeg binary lookup) ---------- */
let ytdlp; // undefined = unprobed | string = path | null = missing
function findYtdlp() {
  if (ytdlp !== undefined) return ytdlp;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const custom = (getSetting('ytdlpPath') || '').trim();
  const candidates = [];
  if (custom) {
    const looksLikeFile = /yt-dlp(\.exe)?$/i.test(custom);
    candidates.push(looksLikeFile ? custom : path.join(custom, 'yt-dlp' + exe));
  }
  candidates.push(path.join(ROOT, 'tools', 'yt-dlp' + exe));
  candidates.push(path.join(ROOT, 'tools', 'ffmpeg', 'yt-dlp' + exe));
  for (const c of candidates) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) { ytdlp = c; return ytdlp; } } catch { }
  }
  const which = spawnSync('yt-dlp' + exe, ['--version'], { windowsHide: true });
  if (which.status === 0) { ytdlp = 'yt-dlp' + exe; return ytdlp; }
  ytdlp = null;
  return ytdlp;
}
function resetYtdlp() { ytdlp = undefined; }
const ytdlpAvailable = () => !!findYtdlp();

/** Which engine (if any) can fetch this URL right now. */
function engineFor(url, source) {
  if (!url) return null;
  if (resolvers.isHost(url, source)) return 'resolve'; // VOE / Streamtape / Vizoa / …
  if (ytdlpAvailable()) return 'ytdlp';
  if (HLS_RE.test(url)) return 'ffmpeg';
  if (DIRECT_RE.test(url)) return 'ffmpeg';
  return null;
}

/* ---------- individual download engines ---------- */
function findProduced(outBase) {
  const dir = path.dirname(outBase);
  const prefix = path.basename(outBase) + '.';
  let best = null, bestSize = -1;
  let entries; try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const f of entries) {
    if (!f.startsWith(prefix)) continue;
    if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp')) continue;
    const full = path.join(dir, f);
    const st = statSafe(full);
    if (st && st.size > bestSize) { bestSize = st.size; best = full; }
  }
  return best;
}

// Platforms yt-dlp can't pull directly (DRM etc.). We don't give up on these —
// instead we find the same track on a supported source (YouTube) by its
// title/artist and download that. `spotify` is the classic case (DRM-locked).
const SEARCH_ONLY = new Set(['spotify']);

function searchQuery(media) {
  return [media.artist, media.title].map((x) => (x || '').trim()).filter(Boolean).join(' ');
}

/** Run yt-dlp against a target (a URL, or a `ytsearchN:query` expression). */
function spawnYtdlp(target, outBase, onPct) {
  return new Promise((resolve, reject) => {
    const bin = findYtdlp();
    const args = [
      '--no-playlist', '--no-part', '--newline', '--no-color', '--no-progress',
      '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
      '-o', outBase + '.%(ext)s',
    ];
    const ff = ffm.ffmpegBin();
    if (ff && ff.includes(path.sep)) args.push('--ffmpeg-location', path.dirname(ff));
    args.push(target);
    const proc = spawn(bin, args, { windowsHide: true });
    let tail = '';
    const onData = (d) => {
      const s = String(d);
      tail = (tail + s).slice(-4000);
      const m = s.match(/\[download\]\s+([\d.]+)%/);
      if (m) onPct(Math.min(99, parseFloat(m[1])));
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        const file = findProduced(outBase);
        if (file) resolve(file); else reject(new Error('no_output_file'));
      } else {
        const err = new Error('yt-dlp exit ' + code + ': ' + tail.slice(-200).trim());
        err.stderr = tail;
        reject(err);
      }
    });
  });
}

/** yt-dlp download with an automatic "find it elsewhere" fallback. */
async function ytdlpFetch(media, outBase, onPct) {
  const q = searchQuery(media);
  // DRM / no-extractor sources: go straight to a YouTube match by metadata
  if (SEARCH_ONLY.has(media.source)) {
    if (!q) throw new Error('needs_metadata');
    return { file: await spawnYtdlp('ytsearch1:' + q, outBase, onPct), via: 'search', query: q };
  }
  try {
    return { file: await spawnYtdlp(media.external_url, outBase, onPct), via: 'direct' };
  } catch (e) {
    // audio track with metadata whose extractor failed (unsupported/removed/geo)
    // -> recover by searching a supported source for the same track
    const recoverable = /unsupported url|unable to (extract|download)|no video formats|requested format|drm|not available|removed|private|geo|blocked/i
      .test(e.stderr || e.message || '');
    if (media.type === 'track' && q && recoverable) {
      return { file: await spawnYtdlp('ytsearch1:' + q, outBase, onPct), via: 'search', query: q };
    }
    throw e;
  }
}

function downloadWithFfmpeg(url, outBase, onPct, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = ffm.ffmpegBin();
    if (!bin) return reject(new Error('ffmpeg_missing'));
    const audioOnly = AUDIO_RE.test(url);
    const out = outBase + (audioOnly ? '.m4a' : '.mp4');
    // -loglevel info prints "Duration:" (total) and -stats prints "time=" (current) to stderr
    const args = ['-hide_banner', '-loglevel', 'info', '-stats', '-y', '-user_agent', BROWSER_UA];
    if (opts.referer) args.push('-referer', opts.referer);
    if (HLS_RE.test(url)) args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');
    args.push('-i', url, '-c', 'copy');
    if (!audioOnly) args.push('-bsf:a', 'aac_adtstoasc');
    args.push(out);
    const proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '', totalSec = 0;
    const hms = (h, m, s) => (+h) * 3600 + (+m) * 60 + (+s);
    proc.stderr.on('data', (d) => {
      const s = String(d); tail = (tail + s).slice(-2000);
      if (!totalSec) { const dm = s.match(/Duration:\s*(\d+):(\d+):(\d+)/); if (dm) totalSec = hms(dm[1], dm[2], dm[3]); }
      const tm = s.match(/time=\s*(\d+):(\d+):(\d+)/);
      if (tm && totalSec) onPct(Math.min(99, (hms(tm[1], tm[2], tm[3]) / totalSec) * 100));
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0 && fs.existsSync(out)) resolve(out);
      else reject(new Error('ffmpeg exit ' + code + ': ' + tail.slice(-200).trim()));
    });
  });
}

async function downloadDirect(url, outBase, onPct, opts = {}) {
  const m = url.match(DIRECT_RE);
  const ext = m ? '.' + m[1].toLowerCase() : '.mp4';
  const out = outBase + ext;
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, ...(opts.referer ? { referer: opts.referer } : {}) },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error('http_' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const fh = fs.createWriteStream(out);
  let recv = 0;
  try {
    const reader = res.body.getReader();
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      recv += value.length;
      if (!fh.write(Buffer.from(value))) await new Promise((r) => fh.once('drain', r));
      if (total) onPct(Math.min(99, (recv / total) * 100));
    }
  } catch (e) {
    fh.destroy(); try { fs.unlinkSync(out); } catch { }
    throw e;
  }
  await new Promise((r, j) => { fh.end(() => r()); fh.on('error', j); });
  return out;
}

async function runDownload(media, outBase, onPct) {
  const url = media.external_url;

  // 1) streaming file-hosts (VOE, Streamtape, Vizoa, …): dig the real media URL
  //    out of the embed page, then fetch it with ffmpeg/direct.
  if (resolvers.isHost(url, media.source)) {
    const r = await resolvers.resolve(url, media.source).catch(() => null);
    if (r?.url) {
      const opts = { referer: r.referer };
      const file = HLS_RE.test(r.url)
        ? await downloadWithFfmpeg(r.url, outBase, onPct, opts)
        : await downloadDirect(r.url, outBase, onPct, opts);
      return { file, via: 'resolved' };
    }
    // resolver came up empty — let yt-dlp's generic extractor have a go
    if (ytdlpAvailable()) return ytdlpFetch(media, outBase, onPct);
    throw new Error('unresolved_host');
  }

  // 2) everything else
  if (ytdlpAvailable()) return ytdlpFetch(media, outBase, onPct);
  if (HLS_RE.test(url)) return { file: await downloadWithFfmpeg(url, outBase, onPct), via: 'direct' };
  if (DIRECT_RE.test(url)) return { file: await downloadDirect(url, outBase, onPct), via: 'direct' };
  throw new Error('needs_ytdlp');
}

/* ---------- per-item state (persisted in media.extra.offline) ---------- */
function patchOffline(id, patch) {
  const row = db.prepare('SELECT extra FROM media WHERE id = ?').get(id);
  if (!row) return null;
  const extra = JSON.parse(row.extra || '{}');
  extra.offline = { ...(extra.offline || {}), ...patch };
  db.prepare('UPDATE media SET extra = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(extra), Date.now(), id);
  return extra.offline;
}

/* ---------- queue + worker ---------- */
const state = { running: false, current: null, done: 0, total: 0 };
const queue = [];
const queued = new Set();
let pumping = false;

function publicState() {
  return {
    ytdlp: ytdlpAvailable(),
    ffmpeg: ffm.available(),
    running: state.running,
    current: state.current,
    pending: queue.length + (state.current ? 1 : 0),
    done: state.done,
    total: state.total,
    dir: offlineDir(),
  };
}

function emitState(extra) { emit('global', 'offline', { ...publicState(), ...extra }); }

function enqueue(id) {
  id = Number(id);
  if (!id || queued.has(id)) return false;
  const m = db.prepare('SELECT id, external_url, path FROM media WHERE id = ?').get(id);
  if (!m || !m.external_url || m.path) return false; // no source, or already local
  queued.add(id);
  queue.push(id);
  state.total++;
  patchOffline(id, { status: 'queued', error: null });
  emitState();
  pump();
  return true;
}

/** Enqueue every external stream that hasn't been saved locally yet. */
function enqueuePending() {
  const rows = db.prepare(
    `SELECT id FROM media WHERE external_url IS NOT NULL AND (path IS NULL OR path = '') AND type != 'series'`).all();
  let n = 0;
  for (const r of rows) if (enqueue(r.id)) n++;
  return n;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  state.running = true;
  emitState();
  try {
    while (queue.length) {
      const id = queue.shift();
      try { await processOne(id); } catch { /* recorded per-item */ }
      queued.delete(id);
      state.done++;
    }
  } finally {
    pumping = false;
    state.running = false;
    state.current = null;
    state.done = 0;
    state.total = 0;
    emitState();
  }
}

async function processOne(id) {
  const raw = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!raw || !raw.external_url || raw.path) return;

  const picked = engineFor(raw.external_url, raw.source);
  if (!picked) {
    patchOffline(id, { status: 'skipped', reason: 'needs_ytdlp' });
    emitState();
    return;
  }

  const engine = picked === 'resolve' ? 'resolver' : picked;
  state.current = { id, title: raw.title, pct: 0, engine };
  patchOffline(id, { status: 'downloading', engine, pct: 0, error: null });
  emitState();

  const outBase = path.join(offlineDir(), safeName(raw.title) + ' [' + id + ']');
  let lastEmit = 0;
  const onPct = (p) => {
    if (state.current) state.current.pct = p;
    if (p - lastEmit >= 3) {
      lastEmit = p;
      patchOffline(id, { pct: Math.round(p) });
      emitState();
    }
  };

  try {
    const { file, via, query } = await runDownload(raw, outBase, onPct);
    const st = statSafe(file);
    db.prepare('UPDATE media SET path = ?, size = COALESCE(?, size), missing = 0, updated_at = ? WHERE id = ?')
      .run(file, st ? st.size : null, Date.now(), id);
    patchOffline(id, {
      status: 'done', engine, via: via || 'direct',
      matchQuery: via === 'search' ? query : null,
      pct: 100, at: Date.now(), error: null,
    });
    // fill duration/codecs, then generate a thumbnail from the local copy.
    // once the thumbnail exists, bump updated_at + notify so clients refresh the
    // card art automatically (the URL's ?v= changes -> the <img> refetches).
    setImmediate(() => {
      ffm.probePending()
        .then(() => ffm.ensureThumb(mediaRow(db.prepare('SELECT * FROM media WHERE id = ?').get(id))))
        .then(() => {
          db.prepare('UPDATE media SET updated_at = ? WHERE id = ?').run(Date.now(), id);
          emit('global', 'mediaUpdated', { id });
        })
        .catch(() => { });
    });
    emit('global', 'offlineDone', { id, title: raw.title });
  } catch (e) {
    patchOffline(id, { status: 'error', engine, error: String(e.message).slice(0, 300) });
  }
  emitState();
}

/** Delete a downloaded copy and revert the row to a pure external stream. */
function removeOffline(id) {
  id = Number(id);
  const raw = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!raw || !raw.external_url || raw.source === 'local') return false;
  if (raw.path) {
    try { fs.unlinkSync(raw.path); } catch { }
    try { fs.unlinkSync(path.join(ffm.THUMB_DIR, id + '.jpg')); } catch { }
  }
  const extra = JSON.parse(raw.extra || '{}');
  delete extra.offline;
  delete extra.probe;
  db.prepare('UPDATE media SET path = NULL, size = NULL, duration = NULL, extra = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(extra), Date.now(), id);
  return true;
}

/* ---------- metadata enrichment (artist / album / track / thumbnail / …) ---------- */
function ytdlpJson(url) {
  return new Promise((resolve, reject) => {
    const bin = findYtdlp();
    if (!bin) return reject(new Error('no_ytdlp'));
    const proc = spawn(bin, ['-J', '--no-playlist', '--no-warnings', '--no-progress', url],
      { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) return reject(new Error('ytdlp_json exit ' + code + ': ' + err.slice(-160).trim()));
      try { resolve(JSON.parse(out.trim())); } catch (e) { reject(e); }
    });
  });
}

function ytdlpMeta(j) {
  if (j && Array.isArray(j.entries) && j.entries[0]) j = j.entries[0]; // playlist -> first entry
  return {
    title: j.track || j.title || null,
    artist: j.artist || j.creator || j.uploader || j.channel || null,
    album: j.album || null,
    year: j.release_year || (j.upload_date ? Number(String(j.upload_date).slice(0, 4)) : null) || null,
    duration: j.duration ? Math.round(j.duration) : null,
    poster: j.thumbnail || (Array.isArray(j.thumbnails) && j.thumbnails.length ? j.thumbnails[j.thumbnails.length - 1].url : null) || null,
    overview: j.description ? String(j.description).slice(0, 4000) : null,
    trackNo: j.track_number || null,
    genres: Array.isArray(j.genres) && j.genres.length ? j.genres.slice(0, 5)
      : j.genre ? [j.genre] : Array.isArray(j.categories) ? j.categories.slice(0, 4) : [],
  };
}

/** Spotify can't be read by yt-dlp — grab title + cover from its public oEmbed. */
async function spotifyOembed(url) {
  const res = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j = await res.json();
  return j.title ? { title: j.title, poster: j.thumbnail_url || null } : null;
}

/** Last resort: read the page's <title> / og:title (VOE, Streamtape, plain URLs). */
async function pageTitle(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 200000);
  let t = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1]
    || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
  if (!t) return null;
  t = t.replace(/\s+/g, ' ').trim().replace(/\s*[|\-–—·]\s*(VOE|Streamtape|Vizoa|Dailymotion|Vimeo|YouTube|Watch)\b.*$/i, '').trim();
  return t ? { title: t } : null;
}

function applyMeta(id, raw, m) {
  const urlTitle = !raw.title || /^https?:\/\//.test(raw.title);
  let title = (urlTitle && m.title) ? m.title : (raw.title || m.title || raw.external_url);
  let year = raw.year || m.year || null;
  // films/series: turn a scene-release / page title into a clean "Title" + year
  if ((raw.type === 'movie' || raw.type === 'series') && title) {
    const p = parseMovieName(String(title).replace(/^\s*(watch|stream|download)\s+/i, ''));
    if (p.title) title = p.title;
    if (!year && p.year) year = p.year;
  }
  const trackNo = raw.type === 'track' ? (raw.episode || m.trackNo || null) : raw.episode;
  let genres = JSON.parse(raw.genres || '[]');
  if (!genres.length && m.genres && m.genres.length) genres = m.genres.slice(0, 5);
  db.prepare(`UPDATE media SET title = ?, sort_title = ?, artist = ?, album = ?, year = ?,
      duration = COALESCE(duration, ?), poster = ?, overview = ?, episode = ?, genres = ?, updated_at = ?
      WHERE id = ?`)
    .run(title, sortTitle(title), raw.artist || m.artist || null, raw.album || m.album || null,
      year, m.duration || null, raw.poster || m.poster || null,
      raw.overview || m.overview || null, trackNo, JSON.stringify(genres), Date.now(), id);
  emit('global', 'mediaUpdated', { id });
}

/** Auto-fetch title/artist/album/year/thumbnail/… for an external stream. */
async function fetchMeta(id) {
  const raw = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!raw || !raw.external_url) return { skipped: true };
  const url = raw.external_url;
  let m = null;
  // 1) yt-dlp for its supported sites (YouTube, SoundCloud, Vimeo, …)
  if (ytdlpAvailable() && !resolvers.isHost(url, raw.source) && raw.source !== 'spotify') {
    try { m = ytdlpMeta(await ytdlpJson(url)); } catch { m = null; }
  }
  // 2) Spotify via oEmbed
  if (!m && raw.source === 'spotify') m = await spotifyOembed(url).catch(() => null);
  // 3) generic page <title> (VOE / Streamtape / Vizoa / direct URL)
  if (!m) m = await pageTitle(url).catch(() => null);
  if (!m) return { skipped: true };
  applyMeta(id, raw, m);
  return { ok: true };
}

/** Full list of items with an offline state, for the downloads queue popout. */
function queueList() {
  const rows = db.prepare(
    `SELECT id, title, source, path, extra FROM media WHERE extra IS NOT NULL AND extra != '{}' ORDER BY updated_at DESC LIMIT 200`).all();
  const rank = { downloading: 0, queued: 1, error: 2, skipped: 3, done: 4 };
  const items = rows.map((r) => {
    const o = (JSON.parse(r.extra || '{}').offline) || {};
    return {
      id: r.id, title: r.title, source: r.source, downloaded: !!r.path,
      status: o.status || null, pct: o.pct || 0, via: o.via || null,
      error: o.error || null, reason: o.reason || null,
    };
  }).filter((x) => x.status);
  items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  return { ...publicState(), items };
}

module.exports = {
  enqueue, enqueuePending, removeOffline, publicState, queueList, fetchMeta,
  resetYtdlp, ytdlpAvailable, engineFor, offlineDir,
};
