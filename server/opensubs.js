// OpenSubtitles.com REST API v2 integration — search + download subtitles
// for titles without local subs. Requires a free API key (Settings → Playback).
const fs = require('fs');
const path = require('path');
const { getSetting } = require('./db');
const { CACHE_DIR } = require('./config');
const { srtToVtt } = require('./util');

const API = 'https://api.opensubtitles.com/api/v1';
const OS_DIR = path.join(CACHE_DIR, 'opensubs');
fs.mkdirSync(OS_DIR, { recursive: true });

function cfg() { return getSetting('openSubtitles') || {}; }

async function osFetch(pathname, opts = {}) {
  const { apiKey } = cfg();
  if (!apiKey) throw new Error('no_opensubtitles_key');
  const res = await fetch(API + pathname, {
    ...opts,
    headers: {
      'Api-Key': apiKey,
      'User-Agent': 'NEBULA v1.0',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('opensubtitles_' + res.status);
  return res.json();
}

/** Search subtitles for a media row. Returns [{fileId, lang, release, downloads}] */
async function search(item) {
  const params = new URLSearchParams();
  const langs = (cfg().langs || ['en']).join(',');
  params.set('languages', langs);
  if (item.imdb_id) params.set('imdb_id', String(item.imdb_id).replace('tt', ''));
  else if (item.tmdb_id) params.set('tmdb_id', String(item.tmdb_id));
  else params.set('query', item.title);
  if (item.type === 'episode') {
    params.delete('imdb_id'); params.delete('tmdb_id');
    params.set('query', item.seriesTitle || item.title);
    if (item.season) params.set('season_number', String(item.season));
    if (item.episode) params.set('episode_number', String(item.episode));
  }
  const data = await osFetch('/subtitles?' + params.toString());
  return (data.data || []).slice(0, 20).map((d) => ({
    fileId: d.attributes?.files?.[0]?.file_id,
    lang: d.attributes?.language,
    release: d.attributes?.release || d.attributes?.files?.[0]?.file_name || '',
    downloads: d.attributes?.download_count || 0,
    ai: !!d.attributes?.ai_translated,
  })).filter((s) => s.fileId);
}

/** Download a subtitle file, convert to VTT, cache; returns local path. */
async function download(mediaId, fileId) {
  const out = path.join(OS_DIR, `${mediaId}-${fileId}.vtt`);
  if (fs.existsSync(out)) return out;
  const info = await osFetch('/download', { method: 'POST', body: JSON.stringify({ file_id: fileId }) });
  if (!info.link) throw new Error('no_download_link');
  const res = await fetch(info.link, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('download_failed');
  const text = await res.text();
  fs.writeFileSync(out, srtToVtt(text));
  return out;
}

function cachedSubs(mediaId) {
  return fs.readdirSync(OS_DIR)
    .filter((f) => f.startsWith(mediaId + '-') && f.endsWith('.vtt'))
    .map((f) => ({ file: path.join(OS_DIR, f), fileId: f.slice(String(mediaId).length + 1, -4) }));
}

module.exports = { search, download, cachedSubs, hasKey: () => !!cfg().apiKey };
