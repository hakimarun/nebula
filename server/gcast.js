// Google Cast sender: discover Chromecast / Android-TV / "Chromecast built-in"
// devices via mDNS and push media to them (LOAD on the Default Media Receiver).
// Complements the DLNA controller in cast.js.
const mdns = require('multicast-dns');
const { Client, DefaultMediaReceiver } = require('castv2-client');

const registry = new Map();        // id -> { id, name, host, port }
const active = new Map();          // id -> { client, player }
const pub = (d) => ({ id: d.id, name: d.name, host: d.host, hasVolume: true, proto: 'gcast' });

/* ---------- discovery ---------- */
function discover(timeoutMs = 2500) {
  return new Promise((resolve) => {
    let m;
    try { m = mdns(); } catch { return resolve([...registry.values()].map(pub)); }
    const found = new Map();
    m.on('response', (res) => {
      const recs = [...(res.answers || []), ...(res.additionals || [])];
      const srv = recs.find((r) => r.type === 'SRV' && /_googlecast\._tcp/i.test(r.name));
      if (!srv) return;
      const txt = recs.find((r) => r.type === 'TXT' && r.name === srv.name);
      const a = recs.find((r) => r.type === 'A' && r.name === srv.data.target);
      const host = a ? a.data : null;
      if (!host) return;
      let name = srv.name.split('.')[0].replace(/-[0-9a-f]{32}$/i, '');
      let id = srv.name;
      if (txt) for (const b of [].concat(txt.data || [])) {
        const s = b.toString();
        if (s.startsWith('fn=')) name = s.slice(3);
        else if (s.startsWith('id=')) id = s.slice(3);
      }
      found.set(host, { id: 'gcast:' + id, name, host, port: srv.data.port || 8009 });
    });
    m.on('error', () => { });
    try { m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch { }
    setTimeout(() => {
      try { m.destroy(); } catch { }
      const now = Date.now();
      for (const d of found.values()) registry.set(d.id, { ...d, at: now });
      for (const [k, v] of registry) if (now - (v.at || 0) > 90000) registry.delete(k);
      resolve([...registry.values()].map(pub));
    }, timeoutMs);
  });
}

const get = (id) => registry.get(id);
const list = () => [...registry.values()].map(pub);

/* ---------- control (persistent connection per device while casting) ---------- */
function close(id) {
  const a = active.get(id);
  if (a) { try { a.client.close(); } catch { } active.delete(id); }
}

function playOn(dev, url, mime, title) {
  return new Promise((resolve, reject) => {
    close(dev.id);
    const client = new Client();
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { client.close(); } catch { } reject(e instanceof Error ? e : new Error(String(e))); } };
    client.on('error', fail);
    const t = setTimeout(() => fail(new Error('timeout')), 15000);
    client.connect(dev.host, () => {
      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) return fail(err);
        const media = {
          contentId: url, contentType: mime, streamType: 'BUFFERED',
          metadata: { type: 0, metadataType: 0, title: title || 'NEBULA' },
        };
        player.load(media, { autoplay: true }, (err2) => {
          clearTimeout(t);
          if (err2) return fail(err2);
          settled = true;
          active.set(dev.id, { client, player });
          resolve();
        });
      });
    });
  });
}

function control(dev, action, position) {
  const a = active.get(dev.id);
  if (!a) return Promise.reject(new Error('not_active'));
  return new Promise((resolve, reject) => {
    const cb = (e) => (e ? reject(e) : resolve());
    if (action === 'pause') a.player.pause(cb);
    else if (action === 'play') a.player.play(cb);
    else if (action === 'seek') a.player.seek(Math.max(0, Number(position) || 0), cb);
    else if (action === 'stop') a.player.stop(() => { close(dev.id); resolve(); });
    else if (action === 'volume') { try { a.client.setVolume({ level: Math.max(0, Math.min(1, (Number(position) || 0) / 100)) }, cb); } catch (e) { reject(e); } }
    else reject(new Error('bad_action'));
  });
}

function status(dev) {
  const a = active.get(dev.id);
  if (!a) return Promise.resolve({ state: 'STOPPED', position: 0, duration: 0, volume: null });
  return new Promise((resolve) => {
    a.player.getStatus((err, s) => {
      const out = (err || !s) ? { state: 'UNKNOWN', position: 0, duration: 0 } : {
        state: String(s.playerState || 'UNKNOWN').toUpperCase(),
        position: Math.floor(s.currentTime || 0),
        duration: Math.floor((s.media && s.media.duration) || 0),
      };
      // receiver volume (0..1 -> 0..100)
      let done = false;
      const finish = (vol) => { if (!done) { done = true; resolve({ ...out, volume: vol }); } };
      try {
        a.client.getStatus((e2, rs) => finish(rs && rs.volume && typeof rs.volume.level === 'number' ? Math.round(rs.volume.level * 100) : null));
        setTimeout(() => finish(null), 3000);
      } catch { finish(null); }
    });
  });
}

module.exports = { discover, list, get, playOn, control, status };
