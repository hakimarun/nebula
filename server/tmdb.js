// TMDB integration: metadata enrichment (posters, descriptions, trailers,
// reviews), trending feed + library comparison, and similar-title lookups.
const { db, getSetting } = require('./db');
const { normalizeTitle, parseMovieName, foldUmlauts, expandUmlauts } = require('./util');

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';

function apiKey() { return (getSetting('tmdbApiKey') || '').trim(); }

async function tmdb(pathname, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('no_tmdb_key');
  const url = new URL(BASE + pathname);
  url.searchParams.set('api_key', key);
  url.searchParams.set('language', getSetting('tmdbLanguage') || 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`tmdb_${res.status}`);
  return res.json();
}

function pickTrailer(videos) {
  const list = (videos && videos.results) || [];
  const yt = list.filter((v) => v.site === 'YouTube');
  return (
    yt.find((v) => v.type === 'Trailer' && v.official) ||
    yt.find((v) => v.type === 'Trailer') ||
    yt.find((v) => v.type === 'Teaser') || yt[0] || null
  )?.key || null;
}

function certOf(details, tv) {
  try {
    if (tv) {
      const r = details.content_ratings.results.find((x) => x.iso_3166_1 === 'US') || details.content_ratings.results[0];
      return r ? r.rating : null;
    }
    const us = details.release_dates.results.find((x) => x.iso_3166_1 === 'US') || details.release_dates.results[0];
    return us?.release_dates?.find((d) => d.certification)?.certification || null;
  } catch { return null; }
}

/** Search TMDB for a local item and write metadata back into the media row. */
async function enrichItem(id) {
  const item = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!item) return { error: 'not_found' };
  const tv = item.type === 'series';
  if (item.type !== 'movie' && item.type !== 'series') return { skipped: true };

  let tmdbId = item.tmdb_id;
  if (!tmdbId) {
    // clean scene-release / page-scraped titles ("Watch Mr.No.Pain.2025.German…")
    // into a plain "Title" + year before querying TMDB
    const cleaned = parseMovieName(String(item.title || '').replace(/^\s*(watch|stream|download)\s+/i, ''));
    const query = cleaned.title || item.title;
    const year = item.year || cleaned.year || null;
    const search = async (q, y) => {
      const params = { query: q };
      if (y) params[tv ? 'first_air_date_year' : 'year'] = y;
      return (await tmdb(tv ? '/search/tv' : '/search/movie', params)).results || [];
    };
    let found = await search(query, year);
    if (!found.length && year) found = await search(query, null);
    if (!found.length && query !== item.title) found = await search(item.title, null);
    // German umlaut fallback: files often spell "München" as "Muenchen" — TMDB
    // won't match the ASCII form, so retry with umlauts restored.
    const qUml = expandUmlauts(query);
    if (!found.length && qUml !== query) {
      found = await search(qUml, year);
      if (!found.length && year) found = await search(qUml, null);
    }
    // compare umlaut-folded so "München" (TMDB) matches "Muenchen" (query)
    const norm = foldUmlauts(normalizeTitle(query));
    const exact = found.find((r) => foldUmlauts(normalizeTitle(r.title || r.name)) === norm);
    const best = exact || found[0];
    if (!best) return { error: 'no_match' };
    tmdbId = best.id;
  }

  const details = await tmdb(`/${tv ? 'tv' : 'movie'}/${tmdbId}`, {
    append_to_response: tv ? 'videos,content_ratings,external_ids' : 'videos,release_dates,external_ids',
  });

  const year = Number(String(details.release_date || details.first_air_date || '').slice(0, 4)) || item.year;
  db.prepare(`UPDATE media SET tmdb_id = ?, imdb_id = ?, title = ?, year = ?, genres = ?, overview = ?,
      poster = ?, backdrop = ?, trailer_key = ?, rating = ?, votes = ?, cert = ?, duration = COALESCE(duration, ?), updated_at = ?
      WHERE id = ?`)
    .run(
      details.id,
      details.external_ids?.imdb_id || details.imdb_id || null,
      details.title || details.name || item.title,
      year,
      JSON.stringify((details.genres || []).map((g) => g.name)),
      details.overview || item.overview,
      details.poster_path ? IMG + 'w500' + details.poster_path : item.poster,
      details.backdrop_path ? IMG + 'w1280' + details.backdrop_path : item.backdrop,
      pickTrailer(details.videos) || item.trailer_key,
      details.vote_average || null,
      details.vote_count || null,
      certOf(details, tv),
      tv ? null : (details.runtime ? details.runtime * 60 : null),
      Date.now(), id);

  // reviews (best-effort)
  try {
    const rev = await tmdb(`/${tv ? 'tv' : 'movie'}/${tmdbId}/reviews`);
    db.prepare('DELETE FROM reviews WHERE media_id = ?').run(id);
    const ins = db.prepare('INSERT INTO reviews (media_id, author, rating, content, source, url, created_at) VALUES (?,?,?,?,?,?,?)');
    for (const r of (rev.results || []).slice(0, 12)) {
      ins.run(id, r.author || 'anonymous', r.author_details?.rating ?? null,
        (r.content || '').slice(0, 4000), 'tmdb', r.url || null, Date.parse(r.created_at) || Date.now());
    }
  } catch { }

  // per-episode titles/stills for series
  if (tv) {
    try {
      const seasons = [...new Set(db.prepare('SELECT DISTINCT season FROM media WHERE parent_id = ? AND season IS NOT NULL').all(id).map((r) => r.season))];
      for (const s of seasons.slice(0, 25)) {
        const sd = await tmdb(`/tv/${tmdbId}/season/${s}`);
        for (const ep of sd.episodes || []) {
          db.prepare(`UPDATE media SET title = COALESCE(NULLIF(?, ''), title), overview = ?, poster = ?,
              duration = COALESCE(duration, ?), rating = ?, updated_at = ?
              WHERE parent_id = ? AND season = ? AND episode = ?`)
            .run(ep.name || '', ep.overview || null,
              ep.still_path ? IMG + 'w500' + ep.still_path : null,
              ep.runtime ? ep.runtime * 60 : null,
              ep.vote_average || null, Date.now(), id, s, ep.episode_number);
        }
      }
    } catch { }
  }
  return { ok: true, tmdbId };
}

/** Enrich every movie/series that has no tmdb_id yet. Serial with tiny delay to be polite. */
async function enrichAllPending(onProgress) {
  if (!apiKey()) return { error: 'no_tmdb_key' };
  const pending = db.prepare("SELECT id FROM media WHERE type IN ('movie','series') AND tmdb_id IS NULL AND missing = 0").all();
  let done = 0, matched = 0;
  for (const row of pending) {
    try { const r = await enrichItem(row.id); if (r.ok) matched++; }
    catch (e) { if (String(e.message).includes('no_tmdb_key')) break; }
    done++;
    if (onProgress) onProgress(done, pending.length);
    await new Promise((r) => setTimeout(r, 120));
  }
  // one refresh signal at the end so open views pick up the new art/titles
  if (matched) { try { require('./events').emit('global', 'mediaUpdated', {}); } catch { } }
  return { done, matched, total: pending.length };
}

/* ---------- trending + library comparison ---------- */
async function refreshTrending() {
  const data = await tmdb('/trending/all/week');
  const payload = (data.results || [])
    .filter((m) => m.media_type === 'movie' || m.media_type === 'tv')
    .slice(0, 30)
    .map((m) => ({
      tmdbId: m.id, mediaType: m.media_type,
      title: m.title || m.name,
      year: Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || null,
      rating: m.vote_average || null, votes: m.vote_count || null,
      overview: m.overview || '',
      poster: m.poster_path ? IMG + 'w500' + m.poster_path : null,
      backdrop: m.backdrop_path ? IMG + 'w1280' + m.backdrop_path : null,
      popularity: m.popularity || 0,
    }));
  db.exec('DELETE FROM trending_cache');
  db.prepare('INSERT INTO trending_cache (fetched_at, payload) VALUES (?, ?)').run(Date.now(), JSON.stringify(payload));
  return payload;
}

/** Trending list, refreshed when stale, each entry flagged with the matching NAS item. */
async function getTrending() {
  const row = db.prepare('SELECT * FROM trending_cache ORDER BY fetched_at DESC LIMIT 1').get();
  let list = row ? JSON.parse(row.payload) : null;
  const maxAge = (getSetting('trendingRefreshHours') || 12) * 3600e3;
  if (!list || Date.now() - row.fetched_at > maxAge) {
    try { list = await refreshTrending(); } catch { if (!list) return []; }
  }
  // compare against library: by tmdb id first, then normalized title
  const byTmdb = new Map();
  const byTitle = new Map();
  for (const r of db.prepare("SELECT id, tmdb_id, title, type FROM media WHERE type IN ('movie','series') AND missing = 0").all()) {
    if (r.tmdb_id) byTmdb.set(r.tmdb_id, r.id);
    byTitle.set(normalizeTitle(r.title), r.id);
  }
  return list.map((t) => ({
    ...t,
    localId: byTmdb.get(t.tmdbId) ?? byTitle.get(normalizeTitle(t.title)) ?? null,
  }));
}

/** Similar titles: TMDB recommendations flagged with local availability + local genre fallback. */
async function getSimilar(mediaId) {
  const item = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId);
  if (!item) return { local: [], online: [] };
  const genres = JSON.parse(item.genres || '[]');

  // local: same-genre titles ranked by overlap then rating
  const candidates = db.prepare(
    "SELECT id, title, year, poster, backdrop, rating, genres, type FROM media WHERE type IN ('movie','series') AND id != ? AND missing = 0").all(mediaId);
  const local = candidates
    .map((c) => {
      const g = JSON.parse(c.genres || '[]');
      const overlap = g.filter((x) => genres.includes(x)).length;
      return { ...c, genres: g, overlap };
    })
    .filter((c) => c.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.rating || 0) - (a.rating || 0))
    .slice(0, 12);

  let online = [];
  if (item.tmdb_id && apiKey()) {
    try {
      const tv = item.type === 'series';
      const data = await tmdb(`/${tv ? 'tv' : 'movie'}/${item.tmdb_id}/recommendations`);
      const byTmdb = new Map();
      for (const r of db.prepare('SELECT id, tmdb_id FROM media WHERE tmdb_id IS NOT NULL').all()) byTmdb.set(r.tmdb_id, r.id);
      online = (data.results || []).slice(0, 12).map((m) => ({
        tmdbId: m.id, title: m.title || m.name,
        year: Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || null,
        rating: m.vote_average, poster: m.poster_path ? IMG + 'w342' + m.poster_path : null,
        backdrop: m.backdrop_path ? IMG + 'w780' + m.backdrop_path : null,
        overview: m.overview || '', localId: byTmdb.get(m.id) ?? null,
      }));
    } catch { }
  }
  return { local, online };
}

async function testKey(key) {
  const res = await fetch(`${BASE}/configuration?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
  return res.ok;
}

module.exports = { enrichItem, enrichAllPending, getTrending, refreshTrending, getSimilar, testKey, hasKey: () => !!apiKey() };
