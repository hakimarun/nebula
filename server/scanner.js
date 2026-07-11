// Library scanner — walks configured local/network-share folders and syncs
// them into the media table. Movies, series (Show/Season X/SxxEyy), music
// (Artist/Album/track) and image folders are all supported.
const fs = require('fs');
const path = require('path');
const { db, getSetting, mediaRow } = require('./db');
const { VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, SUB_EXT, CACHE_DIR } = require('./config');
const { parseMovieName, parseEpisode, sortTitle } = require('./util');
const { readTags } = require('./id3');
const { emit } = require('./events');

let scanning = false;
let lastScan = { at: 0, added: 0, removed: 0, files: 0, errors: [] };

function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { lastScan.errors.push(`${dir}: ${e.code || e.message}`); return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name.startsWith('@')) continue; // skip hidden + NAS system dirs (@eaDir etc.)
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out, depth + 1);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

/** Is this folder name a "Season 01" / "Staffel 1" / bare-number season folder? */
const SEASON_RE = /^(?:season|staffel|series|saison|temporada|stagione|s)[\s._-]*\d{1,3}$/i;
function isSeasonFolder(name) {
  const n = String(name).trim();
  return SEASON_RE.test(n) || /^\d{1,3}$/.test(n);
}

const insertMedia = () => db.prepare(`
  INSERT INTO media (type, title, sort_title, year, path, size, parent_id, season, episode, artist, album, source, added_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,'local',?,?)`);

function findOrCreateParent(type, title, year, cache) {
  const key = type + '|' + sortTitle(title) + '|' + (year || '');
  if (cache.has(key)) return cache.get(key);
  let row = db.prepare('SELECT id FROM media WHERE type = ? AND sort_title = ? AND path IS NULL')
    .get(type, sortTitle(title));
  if (!row) {
    const info = db.prepare(
      'INSERT INTO media (type, title, sort_title, year, source, added_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(type, title, sortTitle(title), year || null, 'local', Date.now(), Date.now());
    row = { id: Number(info.lastInsertRowid) };
  }
  cache.set(key, row.id);
  return row.id;
}

/**
 * Scan all configured library paths. Returns { added, removed, files } and
 * the list of newly added items (for email notifications / metadata fetch).
 */
function scanLibrary() {
  if (scanning) return { busy: true };
  scanning = true;
  lastScan = { at: Date.now(), added: 0, removed: 0, files: 0, errors: [] };
  const newItems = [];
  try {
    const paths = getSetting('libraryPaths') || {};
    const known = new Map(); // path -> id  of existing local file rows
    for (const r of db.prepare("SELECT id, path FROM media WHERE path IS NOT NULL AND source = 'local'").all()) {
      known.set(r.path, r.id);
    }
    const seen = new Set();
    const parentCache = new Map();
    const ins = insertMedia();
    const now = Date.now();

    const addFile = (type, full, fields) => {
      lastScan.files++;
      if (lastScan.files % 100 === 0) emit('global', 'scan', { phase: 'scanning', files: lastScan.files, added: lastScan.added });
      seen.add(full);
      if (known.has(full)) {
        const id = known.get(full);
        // Episodes: re-apply the (possibly corrected) show grouping + numbering on
        // every scan so an existing library self-heals when folder logic changes.
        // Only regenerate the title when it's still the auto-generated form —
        // never clobber a real/TMDB episode title.
        if (type === 'episode') {
          const cur = db.prepare('SELECT title, parent_id, season, episode FROM media WHERE id = ?').get(id);
          const auto = !cur.title || /\sS\d{1,2}E\d{1,3}$/i.test(cur.title);
          db.prepare('UPDATE media SET missing = 0, parent_id = ?, season = ?, episode = ?, title = ? WHERE id = ?')
            .run(fields.parentId ?? cur.parent_id, fields.season ?? cur.season, fields.episode ?? cur.episode,
              auto ? fields.title : cur.title, id);
        } else {
          db.prepare('UPDATE media SET missing = 0 WHERE id = ?').run(id);
        }
        return null;
      }
      const st = statSafe(full);
      const info = ins.run(
        type, fields.title, sortTitle(fields.title), fields.year || null, full,
        st ? st.size : null, fields.parentId || null, fields.season ?? null, fields.episode ?? null,
        fields.artist || null, fields.album || null, now, now);
      const id = Number(info.lastInsertRowid);
      lastScan.added++;
      newItems.push({ id, type, title: fields.title, year: fields.year || null, parentId: fields.parentId || null });
      return id;
    };

    /* movies: any video file, recursively through all subfolders. Title comes
       from the filename, or from the containing folder when the file lives in
       its own "Title (Year)" subfolder (common NAS/Plex layout). */
    for (const root of paths.movies || []) {
      for (const f of walk(root)) {
        if (!VIDEO_EXT.includes(path.extname(f).toLowerCase())) continue;
        let meta = parseMovieName(path.basename(f));
        const dir = path.dirname(f);
        if (path.relative(root, dir) !== '') {                 // sitting in a subfolder
          const fromDir = parseMovieName(path.basename(dir));
          if (fromDir.year && !meta.year) meta = fromDir;       // folder carries the "(Year)"
        }
        addFile('movie', f, meta);
      }
    }

    /* series: walk the whole tree so a parent folder containing nested show
       folders (e.g. <root>/<Genre>/<Show>/Season 01/…) is read correctly. The
       show name is the folder just above the Season/Staffel folder, or the
       file's immediate folder when there is no season folder. */
    for (const root of paths.series || []) {
      // group episode files by show + season so we can sort and number them
      const groups = new Map();
      for (const f of walk(root)) {
        if (!VIDEO_EXT.includes(path.extname(f).toLowerCase())) continue;
        const folders = path.relative(root, f).split(path.sep).slice(0, -1);
        let showFolder = null, seasonFolder = null;
        for (let i = folders.length - 1; i >= 0; i--) {
          if (isSeasonFolder(folders[i])) { seasonFolder = folders[i]; showFolder = folders[i - 1] || null; break; }
        }
        if (!showFolder) showFolder = folders.length ? folders[folders.length - 1] : null;
        const ep = parseEpisode(path.basename(f)) || { season: null, episode: null, epTitle: null };
        let season = ep.season;
        if (season == null && seasonFolder) { const sm = seasonFolder.match(/(\d{1,3})/); season = sm ? Number(sm[1]) : 1; }
        if (season == null) season = 1;
        const { title: showTitle, year: showYear } = parseMovieName(showFolder || path.basename(f));
        const gkey = sortTitle(showTitle) + '|' + (showYear || '') + '|' + season;
        if (!groups.has(gkey)) groups.set(gkey, { showTitle, showYear, season, files: [] });
        groups.get(gkey).files.push({ f, ep });
      }
      // sort each season by filename and assign sequential episode numbers when
      // the filenames carry none (disc-based names) — enables correct ordering
      // and lets TMDB fill in real episode titles by number.
      for (const g of groups.values()) {
        g.files.sort((a, b) => a.f.localeCompare(b.f, undefined, { numeric: true, sensitivity: 'base' }));
        const seriesId = findOrCreateParent('series', g.showTitle, g.showYear, parentCache);
        const anyNumbered = g.files.some((x) => x.ep.episode != null);
        let seq = 0;
        for (const { f, ep } of g.files) {
          seq++;
          const episode = ep.episode != null ? ep.episode : (anyNumbered ? null : seq);
          addFile('episode', f, {
            title: ep.epTitle || `${g.showTitle} S${String(g.season).padStart(2, '0')}E${String(episode || 0).padStart(2, '0')}`,
            year: g.showYear, parentId: seriesId, season: g.season, episode,
          });
        }
      }
    }

    /* music: ID3 tags first, folder structure <Artist>/<Album>/<track> as fallback */
    for (const root of paths.music || []) {
      for (const f of walk(root)) {
        if (!AUDIO_EXT.includes(path.extname(f).toLowerCase())) continue;
        if (known.has(f)) { addFile('track', f, { title: '' }); continue; } // fast path, no re-tag
        const rel = path.relative(root, f).split(path.sep);
        const tags = readTags(f);
        const artist = tags.artist || (rel.length >= 2 ? rel[0] : null);
        const album = tags.album || (rel.length >= 3 ? rel[1] : null);
        const title = tags.title ||
          path.basename(f).replace(/\.[^.]+$/, '').replace(/^\d+[\s.\-_]+/, '').replace(/[._]/g, ' ').trim();
        const id = addFile('track', f, { title, artist, album, year: tags.year });
        if (id && tags.track) db.prepare('UPDATE media SET episode = ? WHERE id = ?').run(tags.track, id);
        if (id && tags.cover?.data?.length) {
          try { fs.writeFileSync(path.join(CACHE_DIR, 'thumbs', id + '.jpg'), tags.cover.data); } catch { }
        }
      }
    }

    /* images: grouped by their immediate folder */
    for (const root of paths.images || []) {
      for (const f of walk(root)) {
        if (!IMAGE_EXT.includes(path.extname(f).toLowerCase())) continue;
        const folder = path.basename(path.dirname(f));
        addFile('image', f, { title: path.basename(f), album: folder === path.basename(root) ? null : folder });
      }
    }

    /* mark rows whose file vanished */
    for (const [p, id] of known) {
      if (!seen.has(p)) {
        db.prepare('UPDATE media SET missing = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
        lastScan.removed++;
      }
    }
    // drop series shells that have no episode rows left at all. NOTE: episodes
    // whose file is temporarily gone (NAS offline) are only marked missing, not
    // deleted — so their shell (and its corrected metadata) must survive. Only
    // shells whose episodes were genuinely removed from the library are dropped.
    db.exec(`DELETE FROM media WHERE type = 'series' AND path IS NULL AND source = 'local'
             AND id NOT IN (SELECT DISTINCT parent_id FROM media WHERE parent_id IS NOT NULL)`);
  } finally {
    scanning = false;
  }
  emit('global', 'scan', { phase: 'done', files: lastScan.files, added: lastScan.added, removed: lastScan.removed });
  return { ...lastScan, newItems };
}

/* ---------- fs.watch: incremental rescans when library folders change ---------- */
const watchers = new Map(); // root -> FSWatcher
let watchDebounce = null;
let onChangeHandler = null;

function setupWatchers(onChange) {
  onChangeHandler = onChange || onChangeHandler;
  const paths = getSetting('libraryPaths') || {};
  const roots = [...new Set(Object.values(paths).flat())];
  // drop watchers for removed roots
  for (const [root, w] of watchers) {
    if (!roots.includes(root)) { try { w.close(); } catch { } watchers.delete(root); }
  }
  for (const root of roots) {
    if (watchers.has(root)) continue;
    try {
      const w = fs.watch(root, { recursive: true }, () => {
        clearTimeout(watchDebounce);
        // debounce: copies land in bursts; wait for quiet before rescanning
        watchDebounce = setTimeout(() => { if (onChangeHandler) onChangeHandler(); }, 8000);
      });
      w.on('error', () => { try { w.close(); } catch { } watchers.delete(root); });
      watchers.set(root, w);
    } catch { /* network shares may not support watching */ }
  }
  return watchers.size;
}

/** Sidecar subtitle files for a local video: same basename prefix. */
function findSubtitles(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const subs = [];
  // also look in a Subs/ subfolder
  const subDir = path.join(dir, 'Subs');
  try { for (const f of fs.readdirSync(subDir)) files.push(path.join('Subs', f)); } catch { }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!SUB_EXT.includes(ext)) continue;
    const name = path.basename(f);
    if (!name.toLowerCase().startsWith(base.toLowerCase()) && !f.startsWith('Subs')) continue;
    subs.push(path.join(dir, f));
  }
  return subs;
}

function libraryStats() {
  const count = (t) => db.prepare('SELECT COUNT(*) c FROM media WHERE type = ? AND missing = 0').get(t).c;
  const size = db.prepare('SELECT COALESCE(SUM(size),0) s FROM media WHERE missing = 0').get().s;
  return {
    movies: count('movie'), series: count('series'), episodes: count('episode'),
    tracks: count('track'), images: count('image'),
    totalBytes: size, lastScan: lastScan.at, scanning,
  };
}

module.exports = { scanLibrary, findSubtitles, libraryStats, setupWatchers, isScanning: () => scanning };
