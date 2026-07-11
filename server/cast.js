// DLNA controller (DMC): discover UPnP MediaRenderers (smart TVs, AV receivers)
// on the LAN and push media to them via AVTransport — the "cast"/AirPlay
// equivalent for DLNA. The browser can't speak UPnP, so the server drives it.
const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');
const { lanInterfaces } = require('./dlna');

const SSDP_ADDR = '239.255.255.250', SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const registry = new Map(); // udn -> { id, name, location, addr, avTransport, renderingControl, at }
const pub = (r) => ({ id: r.id, name: r.name, host: r.addr, hasVolume: !!r.renderingControl });

/* ---------- HTTP helpers ---------- */
function httpGet(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('http_' + res.statusCode)); }
      let data = ''; res.setEncoding('utf8');
      res.on('data', (d) => { data += d; if (data.length > 512 * 1024) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function soapCall(controlUrl, service, action, args) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?>`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:${action} xmlns:u="${service}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const u = new URL(controlUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      // TVs often fetch/probe the media URL before answering the SOAP call, so
      // give SetAVTransportURI/Play generous time before we report a timeout.
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', timeout: 20000,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"${service}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (x) => { d += x; });
      res.on('end', () => (res.statusCode < 400 ? resolve(d) : reject(new Error('soap_' + res.statusCode + ': ' + d.slice(0, 160)))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

/* ---------- discovery ---------- */
async function describeRenderer(location) {
  const xml = await httpGet(location);
  const base = (xml.match(/<URLBase>([^<]+)<\/URLBase>/i) || [])[1]?.trim() || new URL(location).origin;
  const name = (xml.match(/<friendlyName>([^<]*)<\/friendlyName>/i) || [])[1]?.trim() || 'DLNA Renderer';
  const udn = ((xml.match(/<UDN>([^<]*)<\/UDN>/i) || [])[1] || location).trim();
  let avTransport = null, renderingControl = null;
  for (const s of xml.split(/<service>/i).slice(1)) {
    const type = (s.match(/<serviceType>([^<]*)<\/serviceType>/i) || [])[1] || '';
    const ctrl = (s.match(/<controlURL>([^<]*)<\/controlURL>/i) || [])[1] || '';
    if (!ctrl) continue;
    try {
      if (/:AVTransport:/i.test(type)) avTransport = new URL(ctrl, base).href;
      else if (/:RenderingControl:/i.test(type)) renderingControl = new URL(ctrl, base).href;
    } catch { }
  }
  if (!avTransport) return null; // not a controllable renderer
  return { id: udn, name, location, addr: new URL(location).hostname, avTransport, renderingControl };
}

function discover(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const locations = new Set();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg) => {
      const t = msg.toString();
      const loc = (t.match(/^LOCATION:\s*(.+)$/mi) || [])[1];
      if (loc) locations.add(loc.trim());
    });
    sock.on('error', () => { });
    const searchFor = (st) => {
      const m = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${st}`, '', ''].join('\r\n'));
      for (const i of lanInterfaces()) { try { sock.setMulticastInterface(i.address); } catch { } try { sock.send(m, SSDP_PORT, SSDP_ADDR); } catch { } }
    };
    sock.bind(0, () => {
      searchFor('urn:schemas-upnp-org:device:MediaRenderer:1');
      searchFor('urn:schemas-upnp-org:service:AVTransport:1');
      setTimeout(() => searchFor('urn:schemas-upnp-org:device:MediaRenderer:1'), 500);
    });
    setTimeout(async () => {
      try { sock.close(); } catch { }
      await Promise.all([...locations].map((loc) =>
        describeRenderer(loc).then((r) => { if (r) registry.set(r.id, { ...r, at: Date.now() }); }).catch(() => { })));
      const now = Date.now();
      for (const [k, v] of registry) if (now - v.at > 90000) registry.delete(k);
      resolve([...registry.values()].map(pub));
    }, timeoutMs);
  });
}

const get = (id) => registry.get(id);
const list = () => [...registry.values()].map(pub);

/* ---------- control ---------- */
function hms(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const toSec = (t) => { const p = String(t || '0:0:0').split(':').map(Number); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); };

async function play(r, uri, didl) {
  // the URI must be set — this is the step that fails if the TV can't reach the
  // media. Play is best-effort: many renderers auto-start after SetAVTransportURI.
  await soapCall(r.avTransport, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: esc(uri), CurrentURIMetaData: esc(didl) });
  try { await soapCall(r.avTransport, AVT, 'Play', { InstanceID: 0, Speed: 1 }); } catch { /* ignore */ }
}
const stop = (r) => soapCall(r.avTransport, AVT, 'Stop', { InstanceID: 0 });
const pause = (r) => soapCall(r.avTransport, AVT, 'Pause', { InstanceID: 0 });
const resume = (r) => soapCall(r.avTransport, AVT, 'Play', { InstanceID: 0, Speed: 1 });
const seek = (r, sec) => soapCall(r.avTransport, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(sec) });
const setVolume = (r, vol) => (r.renderingControl
  ? soapCall(r.renderingControl, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.max(0, Math.min(100, Math.round(vol))) })
  : Promise.resolve());

async function status(r) {
  const out = { state: 'UNKNOWN', position: 0, duration: 0, volume: null };
  try {
    const ti = await soapCall(r.avTransport, AVT, 'GetTransportInfo', { InstanceID: 0 });
    out.state = (ti.match(/<CurrentTransportState>([^<]*)/i) || [])[1] || 'UNKNOWN';
  } catch { }
  try {
    const pi = await soapCall(r.avTransport, AVT, 'GetPositionInfo', { InstanceID: 0 });
    out.position = toSec((pi.match(/<RelTime>([^<]*)/i) || [])[1]);
    out.duration = toSec((pi.match(/<TrackDuration>([^<]*)/i) || [])[1]);
  } catch { }
  if (r.renderingControl) {
    try {
      const v = await soapCall(r.renderingControl, RC, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
      const m = v.match(/<CurrentVolume>(\d+)/i);
      if (m) out.volume = Number(m[1]);
    } catch { }
  }
  return out;
}

module.exports = { discover, list, get, play, stop, pause, resume, seek, setVolume, status };
