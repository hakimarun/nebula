// Minimal ID3v2/ID3v1 tag reader (title, artist, album, track, year, cover art).
// Pure JS, reads only the tag region of the file.
const fs = require('fs');

function syncSafe(buf, off) {
  return (buf[off] << 21) | (buf[off + 1] << 14) | (buf[off + 2] << 7) | buf[off + 3];
}

function decodeText(buf, enc) {
  if (enc === 1) { // UTF-16 with BOM
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const sw = Buffer.alloc(buf.length - 2);
      for (let i = 2; i + 1 < buf.length; i += 2) { sw[i - 2] = buf[i + 1]; sw[i - 1] = buf[i]; }
      return sw.toString('utf16le');
    }
    return buf.toString('utf16le');
  }
  if (enc === 2) { // UTF-16BE
    const sw = Buffer.alloc(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) { sw[i] = buf[i + 1]; sw[i + 1] = buf[i]; }
    return sw.toString('utf16le');
  }
  if (enc === 3) return buf.toString('utf8');
  return buf.toString('latin1');
}

const clean = (s) => s.replace(/\0+$/g, '').replace(/\0/g, ' ').trim();

/**
 * Read tags from an MP3 (or any file with an ID3v2 header).
 * Returns { title, artist, album, track, year, cover: {mime, data} } — fields may be missing.
 */
function readTags(file) {
  const out = {};
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) === 'ID3') {
      const version = head[3];
      const tagSize = syncSafe(head, 6);
      const body = Buffer.alloc(Math.min(tagSize, 4 * 1024 * 1024));
      fs.readSync(fd, body, 0, body.length, 10);
      let off = 0;
      // skip extended header
      if (head[5] & 0x40) off += version === 4 ? syncSafe(body, 0) : body.readUInt32BE(0) + 4;
      while (off + 10 <= body.length) {
        const id = body.toString('latin1', off, off + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const size = version === 4 ? syncSafe(body, off + 4) : body.readUInt32BE(off + 4);
        if (size <= 0 || off + 10 + size > body.length) break;
        const frame = body.subarray(off + 10, off + 10 + size);
        if (id === 'TIT2') out.title = clean(decodeText(frame.subarray(1), frame[0]));
        else if (id === 'TPE1') out.artist = clean(decodeText(frame.subarray(1), frame[0]));
        else if (id === 'TALB') out.album = clean(decodeText(frame.subarray(1), frame[0]));
        else if (id === 'TRCK') out.track = parseInt(clean(decodeText(frame.subarray(1), frame[0])), 10) || undefined;
        else if (id === 'TYER' || id === 'TDRC') out.year = parseInt(clean(decodeText(frame.subarray(1), frame[0])).slice(0, 4), 10) || undefined;
        else if (id === 'APIC' && !out.cover) {
          const enc = frame[0];
          let i = 1;
          while (i < frame.length && frame[i] !== 0) i++;
          const mime = frame.toString('latin1', 1, i);
          i++; // null
          i++; // picture type byte
          // description (encoding-dependent terminator)
          if (enc === 1 || enc === 2) { while (i + 1 < frame.length && !(frame[i] === 0 && frame[i + 1] === 0)) i += 2; i += 2; }
          else { while (i < frame.length && frame[i] !== 0) i++; i++; }
          if (i < frame.length) out.cover = { mime: mime || 'image/jpeg', data: Buffer.from(frame.subarray(i)) };
        }
        off += 10 + size;
      }
    }
    // ID3v1 fallback for missing fields
    if (!out.title || !out.artist) {
      const st = fs.fstatSync(fd);
      if (st.size > 128) {
        const v1 = Buffer.alloc(128);
        fs.readSync(fd, v1, 0, 128, st.size - 128);
        if (v1.toString('latin1', 0, 3) === 'TAG') {
          out.title = out.title || clean(v1.toString('latin1', 3, 33));
          out.artist = out.artist || clean(v1.toString('latin1', 33, 63));
          out.album = out.album || clean(v1.toString('latin1', 63, 93));
          out.year = out.year || parseInt(v1.toString('latin1', 93, 97), 10) || undefined;
        }
      }
    }
  } catch { /* unreadable tag -> empty result */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return out;
}

module.exports = { readTags };
