// Interactive background: drifting star/particle field on a canvas plus a
// soft accent glow that follows the pointer. Hue tracks the accent setting.
//
// Performance-aware: capped at 30fps, paused when the tab is hidden, and in
// "auto" mode it measures real frame times — on slow machines (no GPU, RDP,
// old NAS boxes) it turns itself off and adds `body.fx-off`, which also
// disables the expensive backdrop-filter blurs in CSS.
const FPS = 30;
const FRAME_MS = 1000 / FPS;

let rafId = 0;
let running = false;

function mode() { return localStorage.getItem('nebula_fx') || 'auto'; }

function setOffClass(off) {
  document.body.classList.toggle('fx-off', off);
}

export function startBackground() {
  const canvas = document.getElementById('nebula-bg');
  const glow = document.getElementById('nebula-glow');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  let w, h, stars = [];

  const resize = () => {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.min(110, Math.floor((w * h) / 24000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      z: Math.random() * 0.8 + 0.2,
      vx: (Math.random() - 0.5) * 0.16, vy: (Math.random() - 0.5) * 0.1,
      tw: Math.random() * Math.PI * 2,
    }));
  };
  resize();
  window.addEventListener('resize', resize);

  let mx = window.innerWidth / 2, my = window.innerHeight / 3, gx = mx, gy = my;
  window.addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; });

  // adaptive quality probe (auto mode): count slow frames early on
  let probed = sessionStorage.getItem('nebula_fx_probe') === 'slow';
  let frames = 0, slow = 0, lastTs = 0, lastDraw = 0;
  let t = 0;

  const stop = () => {
    running = false;
    cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, w, h);
    setOffClass(true);
  };

  const tick = (ts) => {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    if (ts - lastDraw < FRAME_MS) return;      // 30fps cap
    // frame-time probe: detect machines where even capped drawing is heavy
    if (mode() === 'auto' && !probed) {
      if (lastTs && ts - lastTs > 90) slow++;
      lastTs = ts;
      if (++frames >= 90) {
        probed = true;
        if (slow > 20) {
          sessionStorage.setItem('nebula_fx_probe', 'slow');
          stop();
          return;
        }
      }
    }
    lastDraw = ts;
    t += 1 / FPS;
    ctx.clearRect(0, 0, w, h);
    const hue = window.__accentHue ?? 165;
    for (const s of stars) {
      s.x += s.vx; s.y += s.vy;
      if (s.x < 0) s.x = w; if (s.x > w) s.x = 0;
      if (s.y < 0) s.y = h; if (s.y > h) s.y = 0;
      const a = (Math.sin(t * 1.4 + s.tw) * 0.5 + 0.5) * 0.5 * s.z + 0.08;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.z * 1.3, 0, Math.PI * 2);
      ctx.fillStyle = s.z > 0.75
        ? `oklch(0.82 0.15 ${hue} / ${a})`
        : `rgba(233,238,246,${a * 0.7})`;
      ctx.fill();
    }
    if (glow) {
      gx += (mx - gx) * 0.08; gy += (my - gy) * 0.08;
      glow.style.transform = `translate(${gx - 400}px, ${gy - 400}px)`;
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    setOffClass(false);
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  };

  const apply = () => {
    const m = mode();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const autoOff = m === 'auto' && (reduced || sessionStorage.getItem('nebula_fx_probe') === 'slow');
    if (m === 'off' || autoOff) stop();
    else start();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(rafId); running = false; }
    else apply();
  });

  // live switch from Settings → General
  window.__setNebulaFx = (m) => {
    localStorage.setItem('nebula_fx', m);
    if (m !== 'auto') sessionStorage.removeItem('nebula_fx_probe');
    frames = 0; slow = 0; probed = m !== 'auto' ? true : sessionStorage.getItem('nebula_fx_probe') === 'slow';
    apply();
  };

  apply();
}
