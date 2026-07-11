// ffmpeg/ffprobe integration: media probing, HLS transcoding sessions,
// thumbnails, hover-preview frames and embedded-subtitle extraction.
// Everything degrades gracefully when ffmpeg is absent.
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting } = require('./db');
const { ROOT, CACHE_DIR } = require('./config');

const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const FRAME_DIR = path.join(CACHE_DIR, 'frames');
const SUB_DIR = path.join(CACHE_DIR, 'subs');
const HLS_DIR = path.join(CACHE_DIR, 'hls');
for (const d of [THUMB_DIR, FRAME_DIR, SUB_DIR, HLS_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------- binary discovery ---------- */
let bins = null; // { ffmpeg, ffprobe } | { missing: true }

function findBins() {
  if (bins) return bins;
  const candidates = [];
  const custom = (getSetting('ffmpegPath') || '').trim();
  if (custom) {
    candidates.push(custom.endsWith('.exe') || custom.endsWith('ffmpeg') ? path.dirname(custom) : custom);
  }
  candidates.push(path.join(ROOT, 'tools', 'ffmpeg'));
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const dir of candidates) {
    const f = path.join(dir, 'ffmpeg' + exe), p = path.join(dir, 'ffprobe' + exe);
    if (fs.existsSync(f) && fs.existsSync(p)) { bins = { ffmpeg: f, ffprobe: p }; return bins; }
  }
  // PATH fallback
  const which = spawnSync('ffmpeg' + exe, ['-version'], { windowsHide: true });
  if (which.status === 0) { bins = { ffmpeg: 'ffmpeg' + exe, ffprobe: 'ffprobe' + exe }; return bins; }
  bins = { missing: true };
  return bins;
}

const available = () => !findBins().missing;
const resetBins = () => { bins = null; };
const ffmpegBin = () => findBins().ffmpeg || null;

/* ---------- probing ---------- */
function probe(file) {
  return new Promise((resolve, reject) => {
    const b = findBins();
    if (b.missing) return reject(new Error('ffmpeg_missing'));
    execFile(b.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const j = JSON.parse(stdout);
          const streams = j.streams || [];
          const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
          const TEXT_SUBS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
          let aIdx = 0, sIdx = 0;
          const audio = [], subs = [];
          for (const s of streams) {
            if (s.codec_type === 'audio') {
              audio.push({ index: aIdx++, codec: s.codec_name, lang: s.tags?.language || 'und', title: s.tags?.title || '', channels: s.channels || 2 });
            } else if (s.codec_type === 'subtitle') {
              subs.push({ index: sIdx++, codec: s.codec_name, lang: s.tags?.language || 'und', title: s.tags?.title || '', text: TEXT_SUBS.includes(s.codec_name) });
            }
          }
          resolve({
            duration: Number(j.format?.duration) || null,
            container: (j.format?.format_name || '').split(',')[0],
            bitrate: Number(j.format?.bit_rate) || null,
            video: v ? { codec: v.codec_name, width: v.width, height: v.height, pixFmt: v.pix_fmt } : null,
            audio, subs,
          });
        } catch (e) { reject(e); }
      });
  });
}

/* ---------- probe queue: fill durations + stream info after scans ---------- */
let probing = false;
async function probePending() {
  if (probing || !available()) return;
  probing = true;
  try {
    const rows = db.prepare(`SELECT id, path, extra FROM media
        WHERE path IS NOT NULL AND missing = 0 AND type IN ('movie','episode','track')
        AND json_extract(extra, '$.probe') IS NULL LIMIT 500`).all();
    for (const r of rows) {
      try {
        const p = await probe(r.path);
        const extra = JSON.parse(r.extra || '{}');
        extra.probe = {
          container: p.container, video: p.video, audio: p.audio,
          subs: p.subs, bitrate: p.bitrate,
        };
        db.prepare('UPDATE media SET duration = COALESCE(?, duration), extra = ? WHERE id = ?')
          .run(p.duration, JSON.stringify(extra), r.id);
      } catch {
        const extra = JSON.parse(r.extra || '{}');
        extra.probe = { failed: true };
        db.prepare('UPDATE media SET extra = ? WHERE id = ?').run(JSON.stringify(extra), r.id);
      }
    }
  } finally { probing = false; }
}

/** Probe a single row on demand (first play) and cache it, so the direct-vs-
 *  transcode decision has real codec info instead of guessing by extension. */
async function ensureProbe(row) {
  const extra = JSON.parse(row.extra || '{}');
  if (extra.probe && !extra.probe.failed) return extra.probe;
  if (!row.path || !fs.existsSync(row.path) || !available()) return null;
  try {
    const p = await probe(row.path);
    extra.probe = { container: p.container, video: p.video, audio: p.audio, subs: p.subs, bitrate: p.bitrate };
    db.prepare('UPDATE media SET duration = COALESCE(?, duration), extra = ? WHERE id = ?').run(p.duration, JSON.stringify(extra), row.id);
  } catch {
    extra.probe = { failed: true };
    db.prepare('UPDATE media SET extra = ? WHERE id = ?').run(JSON.stringify(extra), row.id);
  }
  row.extra = JSON.stringify(extra); // reflect in the caller's in-memory row
  return extra.probe.failed ? null : extra.probe;
}

/* ---------- direct-play decision ---------- */
const DIRECT_CONTAINERS = ['mov', 'mp4', 'm4v', 'webm', 'matroska'];
const DIRECT_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const DIRECT_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

function playInfo(mediaRowRaw) {
  const extra = JSON.parse(mediaRowRaw.extra || '{}');
  const p = extra.probe;
  const ext = mediaRowRaw.path ? path.extname(mediaRowRaw.path).toLowerCase() : '';
  if (!p || p.failed || !available()) {
    // no probe info: with ffmpeg present, transcode rather than direct-play so the
    // audio always works (rips are usually AC3/DTS/TrueHD, which browsers can't
    // decode -> "no sound"). Without ffmpeg, best-effort direct by extension.
    const guess = ['.mp4', '.m4v', '.webm', '.mov', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.wav'].includes(ext);
    return { direct: available() ? false : guess, canTranscode: available(), reason: p?.failed ? 'probe_failed' : 'no_ffmpeg', audio: [], subs: [], duration: mediaRowRaw.duration };
  }
  const container = ['.mp4', '.m4v', '.mov'].includes(ext) ? 'mp4' : ext === '.webm' ? 'webm' : p.container;
  const vOk = !p.video || DIRECT_VIDEO.includes(p.video.codec);
  const aOk = !p.audio.length || DIRECT_AUDIO.includes(p.audio[0].codec);
  const cOk = DIRECT_CONTAINERS.includes(container) && container !== 'matroska'; // browsers choke on mkv container features
  const direct = vOk && aOk && cOk;
  return {
    direct,
    reason: direct ? 'compatible' : !cOk ? 'container' : !vOk ? 'video_codec' : 'audio_codec',
    canTranscode: available(),
    video: p.video, audio: p.audio, subs: p.subs,
    duration: mediaRowRaw.duration,
  };
}

/* ---------- thumbnails & preview frames ---------- */
function run(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const b = findBins();
    if (b.missing) return reject(new Error('ffmpeg_missing'));
    execFile(b.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args],
      { windowsHide: true, timeout }, (err) => err ? reject(err) : resolve());
  });
}

const inflight = new Map(); // dedupe concurrent generation of the same file
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Poster/preview jpeg for any media row. Returns cached path or null. */
async function ensureThumb(row) {
  const out = path.join(THUMB_DIR, row.id + '.jpg');
  if (fs.existsSync(out)) return out;
  if (!row.path || !fs.existsSync(row.path) || !available()) return null;
  return once('thumb' + row.id, async () => {
    if (row.type === 'image') {
      await run(['-i', row.path, '-vf', 'scale=420:-2', '-frames:v', '1', '-q:v', '4', '-y', out]);
    } else if (row.type === 'track') {
      // music video (a real video stream, e.g. a downloaded YouTube clip): use a
      // representative frame as the thumbnail if one is present…
      const probe = (row.extra && typeof row.extra === 'object' ? row.extra : JSON.parse(row.extra || '{}')).probe;
      if (probe?.video) {
        const at = Math.max(1, Math.min(600, (row.duration || 60) * 0.15));
        await run(['-ss', String(at), '-i', row.path, '-vf', 'scale=420:-2', '-frames:v', '1', '-q:v', '4', '-y', out]).catch(() => { });
      }
      // …otherwise fall back to embedded cover art (attached_pic)
      if (!fs.existsSync(out)) {
        await run(['-i', row.path, '-an', '-vf', 'scale=420:-2', '-frames:v', '1', '-q:v', '4', '-y', out]).catch(() => { });
      }
    } else {
      const at = Math.max(5, Math.min(600, (row.duration || 120) * 0.15));
      await run(['-ss', String(at), '-i', row.path, '-vf', 'scale=640:-2', '-frames:v', '1', '-q:v', '4', '-y', out]);
    }
    return fs.existsSync(out) ? out : null;
  }).catch(() => null);
}

/** Seek-hover preview frame, bucketed to 10s so caching is effective. */
async function frameAt(row, sec) {
  const bucket = Math.floor(sec / 10) * 10;
  const dir = path.join(FRAME_DIR, String(row.id));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, bucket + '.jpg');
  if (fs.existsSync(out)) return out;
  if (!row.path || !available()) return null;
  return once(`frame${row.id}-${bucket}`, async () => {
    await run(['-ss', String(bucket), '-skip_frame', 'nokey', '-i', row.path,
      '-vf', 'scale=240:-2', '-frames:v', '1', '-q:v', '6', '-y', out], 20000);
    return fs.existsSync(out) ? out : null;
  }).catch(() => null);
}

/** Extract an embedded text subtitle stream to VTT (cached). */
async function extractSub(row, streamIndex) {
  const out = path.join(SUB_DIR, `${row.id}-${streamIndex}.vtt`);
  if (fs.existsSync(out)) return out;
  if (!row.path || !available()) return null;
  return once(`sub${row.id}-${streamIndex}`, async () => {
    await run(['-i', row.path, '-map', `0:s:${streamIndex}`, '-f', 'webvtt', '-y', out], 120000);
    return fs.existsSync(out) ? out : null;
  }).catch(() => null);
}

/* ---------- HLS transcode sessions ---------- */
const sessions = new Map(); // sid -> { proc, dir, mediaId, start, lastAccess }

function startHls(row, { start = 0, audio = 0, height = 0 } = {}) {
  const b = findBins();
  if (b.missing) throw new Error('ffmpeg_missing');
  const extra = JSON.parse(row.extra || '{}');
  const p = extra.probe || {};
  const sid = crypto.randomBytes(8).toString('hex');
  const dir = path.join(HLS_DIR, sid);
  fs.mkdirSync(dir, { recursive: true });

  const vCopy = p.video && p.video.codec === 'h264' && (!p.video.pixFmt || p.video.pixFmt.startsWith('yuv420')) && !height;
  const aCodec = p.audio?.[audio]?.codec;
  const aCopy = ['aac', 'mp3'].includes(aCodec) && audio === 0;

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', row.path, '-map', '0:v:0', '-map', `0:a:${audio}?`);
  if (vCopy) args.push('-c:v', 'copy');
  else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-force_key_frames', 'expr:gte(t,n_forced*4)');
    if (height) args.push('-vf', `scale=-2:${height}`);
  }
  if (aCopy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k');
  args.push('-sn', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8'));

  const proc = spawn(b.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errTail = '';
  proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
  proc.on('exit', (code) => { if (code && sessions.has(sid)) console.error('[hls]', sid, 'ffmpeg exit', code, errTail.slice(-300)); });

  sessions.set(sid, { proc, dir, mediaId: row.id, start, lastAccess: Date.now() });
  return { sid, start };
}

function touchSession(sid) {
  const s = sessions.get(sid);
  if (s) s.lastAccess = Date.now();
  return s;
}

function stopSession(sid) {
  const s = sessions.get(sid);
  if (!s) return false;
  sessions.delete(sid);
  try { s.proc.kill('SIGKILL'); } catch { }
  setTimeout(() => { try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { } }, 1000);
  return true;
}

// reap idle sessions
setInterval(() => {
  for (const [sid, s] of sessions) {
    if (Date.now() - s.lastAccess > 120e3) stopSession(sid);
  }
}, 30e3);

/** Wait until the playlist exists (transcode warmed up). */
async function waitForPlaylist(sid, timeoutMs = 15000) {
  const s = sessions.get(sid);
  if (!s) return null;
  const file = path.join(s.dir, 'index.m3u8');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('#EXTINF')) return file;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fs.existsSync(file) ? file : null;
}

module.exports = {
  available, resetBins, ffmpegBin, probe, probePending, ensureProbe, playInfo,
  ensureThumb, frameAt, extractSub,
  startHls, touchSession, stopSession, waitForPlaylist, sessions,
  THUMB_DIR, FRAME_DIR, SUB_DIR, HLS_DIR,
};
