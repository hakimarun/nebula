// Shared helpers: media filename parsing, subtitle conversion, zip writer.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- filename parsing ---------- */
const JUNK = /\b(1080p|2160p|720p|480p|4k|uhd|hdr10?|dv|x26[45]|h26[45]|hevc|avc|aac|ac3|dts|atmos|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|remux|proper|repack|extended|unrated|multi|german|english|dl|ml|complete|retail)\b.*$/i;

/** "The.Matrix.1999.1080p.BluRay.mkv" -> { title: "The Matrix", year: 1999 } */
function parseMovieName(filename) {
  let name = filename.replace(/\.[^.]+$/, '');
  name = name.replace(/[._]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  let year = null;
  // Prefer a year in ()/[] — it's the release year even when the title itself
  // contains a number ("Wonder Woman 1984 (2020)"). Fall back to a bare token.
  const ym = name.match(/[([](19\d{2}|20\d{2})[)\]]/) || name.match(/[\s]?(19\d{2}|20\d{2})[\s]?/);
  if (ym) {
    year = Number(ym[1]);
    const before = name.slice(0, ym.index).trim().replace(/[-\s]+$/, '');
    const after = name.slice(ym.index + ym[0].length).trim().replace(/^[-\s]+/, '');
    // Normally the title is what precedes the year. But some libraries put the
    // year in the middle ("007 - 1964 - Goldfinger"); when the part before the
    // year carries no real words (just a number/code), the title is after it.
    const beforeHasWords = /[a-z]{2,}/i.test(before);
    name = beforeHasWords || !after ? before : after;
  }
  name = name.replace(JUNK, '').replace(/[-\s]+$/, '').replace(/^[-\s]+/, '').trim();
  return { title: name || filename, year };
}

/** Detects S01E02 / 1x02 / Season 1 Episode 2 patterns. */
function parseEpisode(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  let m = base.match(/[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/);
  if (!m) m = base.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (!m) return null;
  const season = Number(m[1]), episode = Number(m[2]);
  // Episode title = whatever comes after the pattern, cleaned.
  let epTitle = base.slice(m.index + m[0].length).replace(/[._]/g, ' ').replace(/^[\s-]+/, '').replace(JUNK, '').trim();
  return { season, episode, epTitle: epTitle || null };
}

function normalizeTitle(t) {
  return String(t || '').toLowerCase()
    .replace(/[':!?.,()\[\]&]/g, '').replace(/\s+/g, ' ')
    .replace(/^the /, '').trim();
}

function sortTitle(t) {
  return normalizeTitle(t);
}

/** Fold German umlauts to their ASCII digraphs so both spellings compare equal:
 *  "München" and "Muenchen" both become "muenchen". */
const foldUmlauts = (s) => String(s || '')
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss');

/** Expand ASCII digraphs back to umlauts for search: "Muenchen" -> "München".
 *  Best-effort — used only as a fallback query, so a wrong guess just misses. */
const expandUmlauts = (s) => String(s || '')
  .replace(/ae/g, 'ä').replace(/oe/g, 'ö').replace(/ue/g, 'ü')
  .replace(/Ae/g, 'Ä').replace(/Oe/g, 'Ö').replace(/Ue/g, 'Ü');

/* ---------- subtitles ---------- */
/** Convert SRT (or already-VTT) text to WebVTT. */
function srtToVtt(text) {
  text = text.replace(/^﻿/, '');
  if (/^WEBVTT/.test(text)) return text;
  const body = text
    .replace(/\r/g, '')
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n').filter(Boolean);
      if (!lines.length) return '';
      // drop numeric cue index
      if (/^\d+$/.test(lines[0])) lines.shift();
      if (!lines.length) return '';
      lines[0] = lines[0].replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      return lines.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
  return 'WEBVTT\n\n' + body;
}

/** Guess subtitle language from a sidecar filename like Movie.en.srt / Movie.ger.srt */
function subtitleLang(subPath, mediaBase) {
  const base = path.basename(subPath).replace(/\.[^.]+$/, '');
  const tail = base.slice(mediaBase.length).replace(/^[._-]+/, '').toLowerCase();
  const map = { en: 'en', eng: 'en', english: 'en', de: 'de', ger: 'de', deu: 'de', german: 'de', fr: 'fr', fre: 'fr', es: 'es', spa: 'es', it: 'it', forced: 'forced' };
  return map[tail] || (tail.length >= 2 && tail.length <= 7 ? tail : 'und');
}

/* ---------- minimal zip writer (deflate, no external deps) ---------- */
function dosDateTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Create a zip from entries [{ name, data (Buffer) | file (path) }] -> writes to outPath.
 */
function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = dosDateTime(Date.now());

  for (const e of entries) {
    const data = e.data !== undefined ? e.data : fs.readFileSync(e.file);
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32Fallback(data);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(now.time, 12); cd.writeUInt16LE(now.date, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, end]));
}

function crc32Fallback(buf) {
  let c, table = crc32Fallback.table;
  if (!table) {
    table = crc32Fallback.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Read entries from a (store/deflate) zip file -> [{ name, data }] */
function readZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // find end-of-central-directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    entries.push({ name, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

module.exports = { parseMovieName, parseEpisode, normalizeTitle, sortTitle, foldUmlauts, expandUmlauts, srtToVtt, subtitleLang, writeZip, readZip };
