// Formatting + external-embed helpers.

export function fmtDuration(sec) {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

export function fmtBytes(b) {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(b) / 10));
  return (b / 2 ** (10 * i)).toFixed(i >= 3 ? 1 : 0) + ' ' + units[i];
}

export function matchPct(item) {
  return item?.rating ? Math.min(99, Math.round(item.rating * 10)) : null;
}

export function ep2(n) { return String(n ?? 0).padStart(2, '0'); }

/** Parse a video/music platform URL into an embeddable iframe URL. */
export function parseEmbed(source, url) {
  if (!url) return null;
  const u = String(url).trim();
  try {
    if (source === 'youtube' || /youtu\.?be/.test(u)) {
      let id = null;
      const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{6,20})/);
      if (m) id = m[1];
      else if (/^[\w-]{6,20}$/.test(u)) id = u;
      if (id) return { type: 'iframe', src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`, thumb: `https://img.youtube.com/vi/${id}/maxresdefault.jpg` };
    }
    if (source === 'vimeo' || /vimeo\.com/.test(u)) {
      const m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      if (m) return { type: 'iframe', src: `https://player.vimeo.com/video/${m[1]}?autoplay=1` };
    }
    if (source === 'dailymotion' || /dai(?:lymotion\.com|\.ly)/.test(u)) {
      const m = u.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([\w]+)/);
      if (m) return { type: 'iframe', src: `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1` };
    }
    if (source === 'streamtape' || /streamtape/.test(u)) {
      const m = u.match(/streamtape\.[a-z]+\/(?:[ve]\/)?([\w-]+)/);
      if (m) return { type: 'iframe', src: `https://streamtape.com/e/${m[1]}` };
    }
    if (source === 'voe' || /voe\./.test(u)) {
      const m = u.match(/voe\.[a-z]+\/(?:e\/)?([\w-]+)/);
      if (m) return { type: 'iframe', src: `https://voe.sx/e/${m[1]}` };
      return { type: 'iframe', src: u };
    }
    if (source === 'vizoa' || /vizoa\./.test(u)) {
      const m = u.match(/vizoa\.[a-z]+\/(?:e\/|embed\/|d\/)?([\w-]+)/);
      if (m) return { type: 'iframe', src: `https://vizoa.net/e/${m[1]}` };
      return { type: 'iframe', src: u };
    }
    if (source === 'spotify' || /open\.spotify\.com/.test(u)) {
      const m = u.match(/open\.spotify\.com\/(track|album|playlist|episode|show|artist)\/([\w]+)/);
      if (m) return { type: 'iframe', src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, tall: m[1] !== 'track' };
    }
    if (source === 'soundcloud' || /soundcloud\.com/.test(u)) {
      return { type: 'iframe', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(u)}&auto_play=true&visual=true` };
    }
    if (/\.(mp4|webm|m4v|mov|mp3|m4a|ogg|flac)(\?|$)/i.test(u)) {
      return { type: 'video', src: u };
    }
    // last resort: try iframing it
    return { type: 'iframe', src: u };
  } catch { return null; }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
