// Intro detection. The player reports forward seeks that happen early in an
// episode ("skip events"). When several events for the same series/season
// agree on a window, we promote the median window to an auto intro marker —
// so the Skip Intro button appears exactly where people actually skip.
const { db } = require('./db');

const MIN_EVENTS = 3;        // events needed before an auto marker is created
const MAX_INTRO_START = 300; // intros start within the first 5 minutes
const MIN_SKIP_LEN = 10;     // ignore tiny scrubs
const MAX_SKIP_LEN = 180;    // ignore "skip half the episode" jumps
const TOLERANCE = 20;        // clustering tolerance in seconds

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Record a seek and re-run detection for that series/season. */
function recordSkip(seriesId, season, fromSec, toSec) {
  const len = toSec - fromSec;
  if (fromSec > MAX_INTRO_START || len < MIN_SKIP_LEN || len > MAX_SKIP_LEN) return null;
  db.prepare('INSERT INTO skip_events (series_id, season, from_sec, to_sec, created_at) VALUES (?,?,?,?,?)')
    .run(seriesId, season || 0, fromSec, toSec, Date.now());
  // keep the table bounded
  db.prepare(`DELETE FROM skip_events WHERE series_id = ? AND season = ? AND id NOT IN
      (SELECT id FROM skip_events WHERE series_id = ? AND season = ? ORDER BY created_at DESC LIMIT 200)`)
    .run(seriesId, season || 0, seriesId, season || 0);
  return detect(seriesId, season || 0);
}

/** Cluster skip events; if the biggest cluster is large enough, save an auto marker. */
function detect(seriesId, season) {
  const events = db.prepare('SELECT from_sec, to_sec FROM skip_events WHERE series_id = ? AND season = ?')
    .all(seriesId, season);
  if (events.length < MIN_EVENTS) return null;

  // greedy clustering on destination time (the "intro end" people skip to)
  const clusters = [];
  for (const e of events) {
    let hit = clusters.find((c) => Math.abs(median(c.map((x) => x.to_sec)) - e.to_sec) <= TOLERANCE);
    if (hit) hit.push(e); else clusters.push([e]);
  }
  clusters.sort((a, b) => b.length - a.length);
  const top = clusters[0];
  if (top.length < MIN_EVENTS) return null;

  const start = Math.max(0, median(top.map((e) => e.from_sec)) - 2);
  const end = median(top.map((e) => e.to_sec));
  const confidence = Math.min(1, top.length / 10);

  // never clobber a manual marker
  const existing = db.prepare('SELECT source FROM intro_markers WHERE series_id = ? AND season = ?').get(seriesId, season);
  if (existing && existing.source === 'manual') return null;
  db.prepare(`INSERT INTO intro_markers (series_id, season, start, end, confidence, source)
      VALUES (?,?,?,?,?, 'auto')
      ON CONFLICT(series_id, season) DO UPDATE SET start = excluded.start, end = excluded.end, confidence = excluded.confidence`)
    .run(seriesId, season, start, end, confidence);
  return { start, end, confidence, source: 'auto' };
}

/** Marker for a series/season — exact season first, then season 0 (whole-series). */
function getMarker(seriesId, season) {
  return (
    db.prepare('SELECT * FROM intro_markers WHERE series_id = ? AND season = ?').get(seriesId, season || 0) ||
    db.prepare('SELECT * FROM intro_markers WHERE series_id = ? AND season = 0').get(seriesId) ||
    null
  );
}

/** Precise per-episode intro window from audio detection, if one exists. */
function getEpisodeMarker(mediaId) {
  const r = db.prepare('SELECT start, end, confidence FROM intro_ep WHERE media_id = ?').get(mediaId);
  return r ? { start: r.start, end: r.end, confidence: r.confidence, source: 'audio' } : null;
}

function setManualMarker(seriesId, season, start, end) {
  if (end <= start) {
    db.prepare('DELETE FROM intro_markers WHERE series_id = ? AND season = ?').run(seriesId, season || 0);
    return null;
  }
  db.prepare(`INSERT INTO intro_markers (series_id, season, start, end, confidence, source)
      VALUES (?,?,?,?,1,'manual')
      ON CONFLICT(series_id, season) DO UPDATE SET start = excluded.start, end = excluded.end, confidence = 1, source = 'manual'`)
    .run(seriesId, season || 0, start, end);
  return getMarker(seriesId, season || 0);
}

module.exports = { recordSkip, getMarker, getEpisodeMarker, setManualMarker, detect };
