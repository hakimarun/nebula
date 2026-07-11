// Audio-fingerprint intro detection.
//
// Idea: the intro is (nearly) identical audio appearing early in every episode
// of a season. We decode the first N minutes of each episode to 8kHz mono PCM,
// turn it into a coarse spectral fingerprint (16-band energy deltas per ~0.37s
// window), then for each pair of episodes find the longest run of matching
// windows. If several pairs agree on a window inside episode 1, that's the
// intro — no user skips needed.
const { spawn } = require('child_process');
const { db } = require('./db');
const ffm = require('./ffmpeg');

const SAMPLE_RATE = 8000;
const WINDOW = 4096;               // ~0.51s per FFT window
const HOP = 2048;                  // ~0.26s hop
const SCAN_SECONDS = 360;          // analyse first 6 minutes
const BANDS = 16;
const MIN_INTRO = 12;              // seconds
const MAX_PAIR_OFFSET = 240;       // intro may start up to 4 min in
const MATCH_MAX_AVG = 4.5;         // max avg bit-distance to accept a per-episode locate

/* -- tiny iterative radix-2 FFT (real input, magnitudes only) -- */
function fftMags(re) {
  const n = re.length;
  const im = new Float64Array(n);
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const uR = re[i + k], uI = im[i + k];
        const vR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const vI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = uR + vR; im[i + k] = uI + vI;
        re[i + k + len / 2] = uR - vR; im[i + k + len / 2] = uI - vI;
        const nR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr; curR = nR;
      }
    }
  }
  const mags = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}

/** Decode first SCAN_SECONDS of audio to fingerprint array (one uint16 per hop). */
function fingerprintReal(ffmpegBin, file) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-t', String(SCAN_SECONDS), '-i', file,
      '-vn', '-sn', '-map', '0:a:0?', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'];
    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const samples = new Float64Array(buf.length >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
      if (samples.length < WINDOW * 4) return resolve(null);

      const prints = [];
      let prevBands = null;
      const hann = new Float64Array(WINDOW);
      for (let i = 0; i < WINDOW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
      for (let off = 0; off + WINDOW <= samples.length; off += HOP) {
        const frame = new Float64Array(WINDOW);
        for (let i = 0; i < WINDOW; i++) frame[i] = samples[off + i] * hann[i];
        const mags = fftMags(frame);
        // log-spaced band energies
        const bandsArr = new Float64Array(BANDS);
        const minBin = 4, maxBin = mags.length;
        for (let b = 0; b < BANDS; b++) {
          const lo = Math.floor(minBin * Math.pow(maxBin / minBin, b / BANDS));
          const hi = Math.floor(minBin * Math.pow(maxBin / minBin, (b + 1) / BANDS));
          let e = 0;
          for (let i = lo; i < hi && i < mags.length; i++) e += mags[i] * mags[i];
          bandsArr[b] = Math.log1p(e);
        }
        // 16-bit fingerprint: band energy rising vs previous window.
        // Epsilon keeps near-silent bands from flipping on encoder noise.
        if (prevBands) {
          let fp = 0;
          for (let b = 0; b < BANDS; b++) if (bandsArr[b] > prevBands[b] + 0.05) fp |= 1 << b;
          prints.push(fp);
        }
        prevBands = bandsArr;
      }
      resolve(Uint16Array.from(prints));
    });
  });
}

const popcount = (x) => {
  x = x - ((x >> 1) & 0x5555);
  x = (x & 0x3333) + ((x >> 2) & 0x3333);
  x = (x + (x >> 4)) & 0x0f0f;
  return (x & 0xff) + (x >> 8);
};

/**
 * Find the best matching window between two fingerprints.
 * Returns { startA, endA, len } in window units, or null.
 */
function bestMatch(a, b) {
  const hopSec = HOP / SAMPLE_RATE;
  const maxOffset = Math.floor(MAX_PAIR_OFFSET / hopSec);
  const minRun = Math.floor(MIN_INTRO / hopSec);
  let best = null;
  for (let offset = -maxOffset; offset <= maxOffset; offset++) {
    let run = 0, runStart = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + offset;
      if (j < 0 || j >= b.length) { run = 0; continue; }
      const dist = popcount(a[i] ^ b[j]);
      if (dist <= 4) {          // <=4 of 16 bits differ -> "same" audio
        if (run === 0) runStart = i;
        run++;
        if (run >= minRun && (!best || run > best.len)) best = { startA: runStart, endA: i, len: run };
      } else if (dist > 6) {
        run = 0;
      }
    }
  }
  return best;
}

/**
 * Slide a reference intro fingerprint across one episode's fingerprint and find
 * the position where it matches best. Returns { pos, avg } in window(hop) units,
 * where avg is the mean bit-distance (lower = better). Coarse pass (step 2) then
 * a ±2 refine keeps it fast even for long episodes.
 */
function locate(ref, hay) {
  if (ref.length < 8 || hay.length < ref.length) return null;
  const maxPos = hay.length - ref.length;
  const score = (pos) => { let s = 0; for (let k = 0; k < ref.length; k++) s += popcount(ref[k] ^ hay[pos + k]); return s; };
  let best = { pos: 0, sum: Infinity };
  for (let pos = 0; pos <= maxPos; pos += 2) { const s = score(pos); if (s < best.sum) best = { pos, sum: s }; }
  for (let pos = Math.max(0, best.pos - 2); pos <= Math.min(maxPos, best.pos + 2); pos++) { const s = score(pos); if (s < best.sum) best = { pos, sum: s }; }
  return { pos: best.pos, avg: best.sum / ref.length };
}

const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * Detect the intro for a series season. Because intros can sit behind a
 * variable-length cold open (e.g. Game of Thrones), we don't assume a fixed
 * timestamp: we derive the shared intro fingerprint from a few episodes, then
 * locate that fingerprint inside EVERY episode individually and store a
 * per-episode window (intro_ep). A season-level marker (intro_markers) is also
 * written as a display/fallback value. Manual season markers are never touched.
 */
async function detectSeriesIntro(seriesId, season) {
  if (!ffm.available()) return { error: 'ffmpeg_missing' };
  const eps = db.prepare(`SELECT id, path FROM media WHERE parent_id = ? AND season = ? AND missing = 0
      AND path IS NOT NULL ORDER BY episode`).all(seriesId, season);
  if (eps.length < 2) return { error: 'need_2_episodes' };
  const binPath = ffm.ffmpegBin();
  const hopSec = HOP / SAMPLE_RATE;

  // Fingerprint a handful of episodes to find the shared intro fingerprint.
  const refCount = Math.min(eps.length, 6);
  const refPrints = [];
  for (let i = 0; i < refCount; i++) {
    refPrints.push(await fingerprintReal(binPath, eps[i].path).catch(() => null));
  }
  const baseIdx = refPrints.findIndex(Boolean);
  if (baseIdx < 0) return { error: 'decode_failed' };
  const base = refPrints[baseIdx];

  // Consensus intro window inside the base episode (hop units).
  const startsW = [], endsW = [];
  for (let i = 0; i < refPrints.length; i++) {
    if (i === baseIdx || !refPrints[i]) continue;
    const m = bestMatch(base, refPrints[i]);
    if (m) { startsW.push(m.startA); endsW.push(m.endA); }
  }
  if (!startsW.length) return { error: 'no_common_audio' };
  const refStart = Math.max(0, Math.round(median(startsW)));
  const refEnd = Math.round(median(endsW));
  const refLenSec = (refEnd - refStart) * hopSec;
  if (refLenSec < MIN_INTRO || refEnd <= refStart) return { error: 'too_short' };
  const ref = base.subarray(refStart, refEnd);     // the intro's fingerprint

  // Locate the intro inside every episode individually (handles variable-length
  // cold opens). Reuse the reference fingerprints we already decoded.
  const cache = new Map();
  for (let i = 0; i < refPrints.length; i++) if (refPrints[i]) cache.set(eps[i].id, refPrints[i]);
  const insEp = db.prepare(`INSERT INTO intro_ep (media_id, start, end, confidence) VALUES (?,?,?,?)
      ON CONFLICT(media_id) DO UPDATE SET start = excluded.start, end = excluded.end, confidence = excluded.confidence`);
  const delEp = db.prepare('DELETE FROM intro_ep WHERE media_id = ?');

  const epStarts = [];
  let placed = 0;
  for (const ep of eps) {
    let fp = cache.get(ep.id);
    if (!fp) fp = await fingerprintReal(binPath, ep.path).catch(() => null);
    const loc = fp && fp.length ? locate(ref, fp) : null;
    if (!loc || loc.avg > MATCH_MAX_AVG) { delEp.run(ep.id); continue; }
    const start = Math.max(0, loc.pos * hopSec - 0.5);
    const end = (loc.pos + ref.length) * hopSec + 0.5;
    const confidence = Math.max(0.5, Math.min(1, 1 - loc.avg / 9));
    insEp.run(ep.id, start, end, confidence);
    epStarts.push(start);
    placed++;
  }
  if (!placed) return { error: 'no_common_audio' };

  // Season-level fallback marker (median window) — used for any episode that
  // couldn't be matched individually, and shown in the editor.
  const s0 = Math.max(0, median(epStarts));
  const e0 = s0 + refLenSec;
  const manual = db.prepare('SELECT source FROM intro_markers WHERE series_id = ? AND season = ?').get(seriesId, season);
  if (!manual || manual.source !== 'manual') {
    const confidence = Math.min(1, 0.5 + startsW.length * 0.15);
    db.prepare(`INSERT INTO intro_markers (series_id, season, start, end, confidence, source)
        VALUES (?,?,?,?,?,'audio')
        ON CONFLICT(series_id, season) DO UPDATE SET start = excluded.start, end = excluded.end,
          confidence = excluded.confidence, source = 'audio'`)
      .run(seriesId, season, s0, e0, confidence);
  }
  return { ok: true, start: s0, end: e0, episodes: placed, total: eps.length, refLen: Math.round(refLenSec) };
}

/**
 * Detect intros across the library. By default only seasons without a marker are
 * processed (cheap background top-up). With force = true every season is
 * re-analysed — needed to backfill per-episode markers for seasons detected by
 * the older per-season-only version.
 */
let running = false;
let progress = { running: false, done: 0, total: 0 };
async function detectAllPending(force = false, onProgress) {
  if (running || !require('./ffmpeg').available()) return { busy: running };
  running = true;
  progress = { running: true, done: 0, total: 0 };
  try {
    const seasons = force
      ? db.prepare(`
          SELECT m.parent_id AS sid, m.season AS season FROM media m
          WHERE m.type = 'episode' AND m.missing = 0 AND m.season IS NOT NULL
          GROUP BY m.parent_id, m.season HAVING COUNT(*) >= 2`).all()
      : db.prepare(`
          SELECT DISTINCT m.parent_id AS sid, m.season AS season FROM media m
          LEFT JOIN intro_markers im ON im.series_id = m.parent_id AND im.season = m.season
          WHERE m.type = 'episode' AND m.missing = 0 AND m.season IS NOT NULL AND im.series_id IS NULL
          GROUP BY m.parent_id, m.season HAVING COUNT(*) >= 2`).all();
    progress.total = seasons.length;
    let done = 0;
    const results = [];
    for (const s of seasons) {
      const r = await detectSeriesIntro(s.sid, s.season).catch((e) => ({ error: String(e.message) }));
      results.push({ seriesId: s.sid, season: s.season, ...r });
      progress.done = ++done;
      if (onProgress) onProgress(done, seasons.length);
    }
    return { done, total: seasons.length, results };
  } finally { running = false; progress.running = false; }
}

/** Live progress of the current/last detection pass (manual or background). */
const detectStatus = () => ({ ...progress });

module.exports = { detectSeriesIntro, detectAllPending, detectStatus, isRunning: () => running };
