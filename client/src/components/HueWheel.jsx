import React, { useRef, useEffect } from 'react';
import { useT } from '../i18n.js';

export const HUE_PRESETS = [
  ['Mint', 165], ['Cyan', 200], ['Violet', 295], ['Magenta', 350], ['Amber', 75], ['Lime', 130],
];

export function HueWheel({ hue, onChange, size = 184 }) {
  const ref = useRef(null);
  const dragging = useRef(false);
  const R = size / 2;
  const fromEvent = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const cx = e.clientX - rect.left - R, cy = e.clientY - rect.top - R;
    const ang = Math.atan2(cy, cx) * 180 / Math.PI;
    onChange(Math.round((ang + 360) % 360));
  };
  useEffect(() => {
    const move = (e) => { if (dragging.current) fromEvent(e); };
    const up = () => { dragging.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rad = hue * Math.PI / 180;
  const knobR = R - 16;
  const kx = R + Math.cos(rad) * knobR, ky = R + Math.sin(rad) * knobR;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '4px 0 2px' }}>
      <div
        ref={ref}
        onPointerDown={(e) => { dragging.current = true; fromEvent(e); }}
        style={{
          position: 'relative', width: size, height: size, borderRadius: '50%', cursor: 'crosshair', touchAction: 'none',
          background: `radial-gradient(circle at center, #fff 0%, rgba(255,255,255,.25) 32%, transparent 62%),
            conic-gradient(from 90deg,
              oklch(0.78 0.17 0), oklch(0.82 0.17 60), oklch(0.88 0.17 120),
              oklch(0.85 0.16 180), oklch(0.72 0.18 240), oklch(0.7 0.2 300), oklch(0.78 0.17 360))`,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.12), 0 8px 28px -10px rgba(0,0,0,.6)',
        }}
      >
        <div style={{
          position: 'absolute', left: kx, top: ky, width: 26, height: 26, transform: 'translate(-50%,-50%)',
          borderRadius: '50%', border: '3px solid #fff', background: `oklch(0.82 0.15 ${hue})`,
          boxShadow: '0 2px 8px rgba(0,0,0,.5)', pointerEvents: 'none',
        }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: 'var(--muted)' }}>
        <span style={{ width: 16, height: 16, borderRadius: 5, background: `oklch(0.82 0.15 ${hue})`, boxShadow: `0 0 10px oklch(0.82 0.15 ${hue} / .6)` }} />
        hue {hue}°
      </div>
    </div>
  );
}

export function HuePicker({ hue, onChange }) {
  return (
    <div>
      <HueWheel hue={hue} onChange={onChange} />
      <div className="nb-hue-presets" style={{ justifyContent: 'center' }}>
        {HUE_PRESETS.map(([name, h]) => (
          <button key={name} className={'nb-hue-preset' + (hue === h ? ' on' : '')} onClick={() => onChange(h)}>
            <span className="sw" style={{ background: `oklch(0.82 0.15 ${h})` }} />{name}
          </button>
        ))}
      </div>
    </div>
  );
}
