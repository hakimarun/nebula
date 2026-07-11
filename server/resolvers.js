// Resolvers for streaming file-hosts (VOE, Streamtape, Vizoa, …). These sites
// have no yt-dlp extractor and hide their real media URL inside obfuscated page
// JavaScript, so we fetch the embed page and dig the direct HLS/MP4 link out of
// it, then hand that to ffmpeg. Best-effort by nature: these hosts change their
// obfuscation often, so a generic HLS/MP4 scrape is always tried as a fallback.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function host(url) { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }

/** Does this URL / source look like a host we can try to resolve? */
function isHost(url, source) {
  if (['voe', 'vizoa', 'streamtape'].includes(source)) return true;
  return /(?:voe\.sx|\bvoe\.|streamtape\.|vizoa\.)/i.test(url || '');
}

async function fetchText(url, referer) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...(referer ? { referer } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('http_' + res.status);
  return { text: await res.text(), finalUrl: res.url };
}

/** Pull the first HLS (.m3u8) or MP4 URL out of raw page/script text. */
function findMedia(html) {
  const s = String(html).replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
  const hls = s.match(/https?:\/\/[^\s"'`<>()\\]+\.m3u8[^\s"'`<>()\\]*/i);
  if (hls) return hls[0];
  const mp4 = s.match(/https?:\/\/[^\s"'`<>()\\]+\.mp4[^\s"'`<>()\\]*/i);
  if (mp4) return mp4[0];
  return null;
}

/** Follow a JS-level redirect (hoster interstitials) once, if present. */
async function withRedirect(url) {
  let { text, finalUrl } = await fetchText(url);
  const red = text.match(/(?:window\.location(?:\.href)?|location\.(?:href|replace))\s*=?\s*\(?\s*["']([^"']+)["']/);
  if (red && /^https?:\/\//.test(red[1]) && red[1] !== url) {
    try { ({ text, finalUrl } = await fetchText(red[1], url)); } catch { }
  }
  return { text, finalUrl };
}

/* ---------- Streamtape: link is split across two literals to beat scrapers ---------- */
async function resolveStreamtape(url) {
  const idm = url.match(/streamtape\.[a-z.]+\/(?:e|v)\/([A-Za-z0-9_-]+)/i) ||
    url.match(/streamtape\.[a-z.]+\/.*?[?&]id=([A-Za-z0-9_-]+)/i);
  const embed = idm ? `https://streamtape.com/e/${idm[1]}` : url;
  const { text: html, finalUrl } = await fetchText(embed);
  // …innerHTML = '<partA>' + ('<partB>').substring(N);
  const cc = html.match(/innerHTML\s*=\s*(["'])(.*?)\1\s*\+\s*\(?\s*(["'])(.*?)\3\)?\s*\.substring\((\d+)\)/s);
  let media = null;
  if (cc) media = 'https:' + cc[2].trim() + cc[4].substring(Number(cc[5]));
  if (!media) { const c = findMedia(html); if (c) media = c; }
  if (!media) return null;
  media = media.replace(/\s+/g, '');
  if (/get_video\?/.test(media) && !/[?&]stream=1/.test(media)) media += (media.includes('?') ? '&' : '?') + 'stream=1';
  return { url: media, referer: finalUrl || embed };
}

/* ---------- VOE: obfuscated JSON blob, with a scrape fallback ---------- */
function rot13(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}
function voeDecode(raw) {
  try {
    let t = rot13(raw);
    for (const p of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) t = t.split(p).join('');
    t = Buffer.from(t, 'base64').toString('binary');
    t = t.split('').map((c) => String.fromCharCode(c.charCodeAt(0) - 3)).join('');
    t = t.split('').reverse().join('');
    return JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
  } catch { return null; }
}
async function resolveVoe(url) {
  const { text: html, finalUrl } = await withRedirect(url);
  // 1) obfuscated application/json blob (current VOE scheme)
  const j = html.match(/<script[^>]+application\/json[^>]*>\s*(\[[\s\S]*?\])\s*<\/script>/i);
  if (j) {
    try {
      const d = voeDecode(JSON.parse(j[1])[0]);
      const src = d && (d.source || d.file || d.direct_access_url ||
        (Array.isArray(d.source_list) && d.source_list[0] && d.source_list[0].file));
      if (src) return { url: src, referer: finalUrl || url };
    } catch { }
  }
  // 2) fallback: scrape any m3u8/mp4 from the page
  const c = findMedia(html);
  return c ? { url: c, referer: finalUrl || url } : null;
}

/* ---------- unknown hosts (Vizoa, …): generic HLS/MP4 scrape ---------- */
async function resolveGeneric(url) {
  const { text: html, finalUrl } = await withRedirect(url);
  const c = findMedia(html);
  return c ? { url: c, referer: finalUrl || url } : null;
}

/**
 * Resolve an embed/page URL to a directly-downloadable media URL.
 * Returns { url, referer } or null when nothing could be extracted.
 */
async function resolve(url, source) {
  if (!url) return null;
  const h = host(url);
  if (source === 'streamtape' || /streamtape\./i.test(h)) return resolveStreamtape(url);
  if (source === 'voe' || /voe\./i.test(h) || /voe\.sx/i.test(url)) return resolveVoe(url);
  if (source === 'vizoa' || /vizoa\./i.test(h)) return resolveGeneric(url);
  // any other non-direct page URL: last-ditch generic scrape
  if (!/\.(m3u8|mp4|m4v|webm|mkv|mp3|m4a|aac|flac|wav)(\?|#|$)/i.test(url)) return resolveGeneric(url);
  return null;
}

module.exports = { resolve, isHost };
