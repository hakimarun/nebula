// Minimal DLNA / UPnP MediaServer (experimental).
// SSDP discovery + ContentDirectory Browse so TVs and DLNA apps can browse
// Movies / Series / Music and stream directly from the existing /api/stream.
// DLNA has no authentication — when enabled, streams are reachable without
// login on the local network.
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const { db, getSetting } = require('./db');
const { PORT } = require('./config');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const UUID = 'uuid:' + crypto.createHash('md5').update('nebula-dlna-' + os.hostname()).digest('hex').slice(0, 32);

let socket = null;
let aliveTimer = null;

// Virtual adapters a smart TV is never on — VMware/VirtualBox/Hyper-V/WSL/…
const VIRTUAL_RE = /vmware|virtualbox|vethernet|hyper-?v|loopback|wsl|docker|tailscale|zerotier|vpn|tap-|utun/i;

/** Real LAN interfaces { name, address, netmask }, virtual adapters filtered out. */
function lanInterfaces() {
  const all = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      all.push({ name, address: i.address, netmask: i.netmask });
    }
  }
  const real = all.filter((i) => !VIRTUAL_RE.test(i.name));
  return (real.length ? real : all).length ? (real.length ? real : all) : [{ name: 'lo', address: '127.0.0.1', netmask: '255.0.0.0' }];
}

const ipToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
const sameSubnet = (a, b, mask) => (ipToInt(a) & ipToInt(mask)) === (ipToInt(b) & ipToInt(mask));

/** The local IP reachable from `remote` (same subnet), else the first LAN IP. */
function bestLocalIp(remote) {
  const ifs = lanInterfaces();
  if (remote) { const m = ifs.find((i) => sameSubnet(i.address, remote, i.netmask)); if (m) return m.address; }
  return ifs[0].address;
}

const NTS = ['upnp:rootdevice', UUID, 'urn:schemas-upnp-org:device:MediaServer:1', 'urn:schemas-upnp-org:service:ContentDirectory:1'];

function ssdpResponse(st, ip) {
  return [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'EXT:',
    `LOCATION: http://${ip}:${PORT}/dlna/device.xml`,
    'SERVER: Node/UPnP/1.0 NEBULA/1.0',
    `ST: ${st}`,
    `USN: ${UUID}${st === UUID ? '' : '::' + st}`,
    '', '',
  ].join('\r\n');
}

function notify(nts) {
  if (!socket) return;
  for (const iface of lanInterfaces()) {
    try { socket.setMulticastInterface(iface.address); } catch { }
    for (const nt of NTS) {
      const lines = [
        'NOTIFY * HTTP/1.1',
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
        'NT: ' + nt,
        'NTS: ' + nts,
        `USN: ${UUID}${nt === UUID ? '' : '::' + nt}`,
      ];
      if (nts === 'ssdp:alive') lines.push(
        'CACHE-CONTROL: max-age=1800',
        `LOCATION: http://${iface.address}:${PORT}/dlna/device.xml`,
        'SERVER: Node/UPnP/1.0 NEBULA/1.0');
      const msg = Buffer.from(lines.concat(['', '']).join('\r\n'));
      try { socket.send(msg, SSDP_PORT, SSDP_ADDR); } catch { }
    }
  }
}
const notifyAlive = () => notify('ssdp:alive');

function start() {
  if (socket) return;
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, rinfo) => {
    const text = msg.toString();
    if (!text.startsWith('M-SEARCH')) return;
    const stMatch = text.match(/^ST:\s*(.+)$/mi);
    if (!stMatch) return;
    const st = stMatch[1].trim();
    const wanted = st === 'ssdp:all' ? NTS : NTS.includes(st) ? [st] : [];
    // reply from the IP on the same subnet as the TV so LOCATION is reachable
    const ip = bestLocalIp(rinfo.address);
    for (const respondSt of wanted) {
      setTimeout(() => {
        try { socket.send(Buffer.from(ssdpResponse(respondSt, ip)), rinfo.port, rinfo.address); } catch { }
      }, Math.random() * 300);
    }
  });
  socket.on('error', (e) => console.error('[dlna] ssdp error', e.message,
    e.code === 'EADDRINUSE' ? '(port 1900 in use — another UPnP/SSDP service?)' : ''));
  socket.bind(SSDP_PORT, () => {
    try { socket.setMulticastTTL(4); } catch { }
    // join the multicast group on every real LAN interface (not just the default)
    for (const iface of lanInterfaces()) {
      try { socket.addMembership(SSDP_ADDR, iface.address); } catch { }
    }
    // announce a few times — TVs already awake pick it up without re-scanning
    notifyAlive();
    setTimeout(notifyAlive, 800);
    setTimeout(notifyAlive, 2500);
  });
  aliveTimer = setInterval(notifyAlive, 120e3);
  console.log('[dlna] announced on', lanInterfaces().map((i) => i.address).join(', '), 'as', UUID);
}

function stop() {
  if (aliveTimer) clearInterval(aliveTimer);
  aliveTimer = null;
  if (socket) {
    try { notify('ssdp:byebye'); } catch { }
    try { socket.close(); } catch { }
    socket = null;
  }
}

/* ---------- HTTP part (mounted on the express app) ---------- */
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CD_TYPE = 'urn:schemas-upnp-org:service:ContentDirectory:1';
const CM_TYPE = 'urn:schemas-upnp-org:service:ConnectionManager:1';

function deviceXml() {
  const name = esc(getSetting('appName') || 'NEBULA');
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${name}</friendlyName>
    <manufacturer>NEBULA</manufacturer>
    <modelName>NEBULA Media Server</modelName>
    <modelNumber>1.0</modelNumber>
    <UDN>${UUID}</UDN>
    <iconList>
      <icon><mimetype>image/png</mimetype><width>120</width><height>120</height><depth>24</depth><url>/dlna/icon.png?h=${Number(getSetting('defaultHue')) || 165}&amp;s=120</url></icon>
      <icon><mimetype>image/png</mimetype><width>48</width><height>48</height><depth>24</depth><url>/dlna/icon.png?h=${Number(getSetting('defaultHue')) || 165}&amp;s=48</url></icon>
    </iconList>
    <serviceList>
      <service>
        <serviceType>${CD_TYPE}</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/cd.xml</SCPDURL>
        <controlURL>/dlna/control</controlURL>
        <eventSubURL>/dlna/cd_event</eventSubURL>
      </service>
      <service>
        <serviceType>${CM_TYPE}</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/cm.xml</SCPDURL>
        <controlURL>/dlna/cm_control</controlURL>
        <eventSubURL>/dlna/cm_event</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

const arg = (n, d, sv) => `<argument><name>${n}</name><direction>${d}</direction><relatedStateVariable>${sv}</relatedStateVariable></argument>`;
const svar = (n, t, ev = 'no') => `<stateVariable sendEvents="${ev}"><name>${n}</name><dataType>${t}</dataType></stateVariable>`;

const CD_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
  <action><name>GetSearchCapabilities</name><argumentList>${arg('SearchCaps', 'out', 'SearchCapabilities')}</argumentList></action>
  <action><name>GetSortCapabilities</name><argumentList>${arg('SortCaps', 'out', 'SortCapabilities')}</argumentList></action>
  <action><name>GetSystemUpdateID</name><argumentList>${arg('Id', 'out', 'SystemUpdateID')}</argumentList></action>
  <action><name>Browse</name><argumentList>${arg('ObjectID', 'in', 'A_ARG_TYPE_ObjectID')}${arg('BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag')}${arg('Filter', 'in', 'A_ARG_TYPE_Filter')}${arg('StartingIndex', 'in', 'A_ARG_TYPE_Index')}${arg('RequestedCount', 'in', 'A_ARG_TYPE_Count')}${arg('SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria')}${arg('Result', 'out', 'A_ARG_TYPE_Result')}${arg('NumberReturned', 'out', 'A_ARG_TYPE_Count')}${arg('TotalMatches', 'out', 'A_ARG_TYPE_Count')}${arg('UpdateID', 'out', 'A_ARG_TYPE_UpdateID')}</argumentList></action>
</actionList>
<serviceStateTable>
  ${svar('A_ARG_TYPE_ObjectID', 'string')}${svar('A_ARG_TYPE_Result', 'string')}
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType><allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList></stateVariable>
  ${svar('A_ARG_TYPE_Filter', 'string')}${svar('A_ARG_TYPE_SortCriteria', 'string')}${svar('A_ARG_TYPE_Index', 'ui4')}${svar('A_ARG_TYPE_Count', 'ui4')}${svar('A_ARG_TYPE_UpdateID', 'ui4')}
  ${svar('SearchCapabilities', 'string')}${svar('SortCapabilities', 'string')}${svar('SystemUpdateID', 'ui4', 'yes')}
</serviceStateTable></scpd>`;

const CM_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
  <action><name>GetProtocolInfo</name><argumentList>${arg('Source', 'out', 'SourceProtocolInfo')}${arg('Sink', 'out', 'SinkProtocolInfo')}</argumentList></action>
  <action><name>GetCurrentConnectionIDs</name><argumentList>${arg('ConnectionIDs', 'out', 'CurrentConnectionIDs')}</argumentList></action>
  <action><name>GetCurrentConnectionInfo</name><argumentList>${arg('ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID')}${arg('RcsID', 'out', 'A_ARG_TYPE_RcsID')}${arg('AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID')}${arg('ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo')}${arg('PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager')}${arg('PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID')}${arg('Direction', 'out', 'A_ARG_TYPE_Direction')}${arg('Status', 'out', 'A_ARG_TYPE_ConnectionStatus')}</argumentList></action>
</actionList>
<serviceStateTable>
  ${svar('SourceProtocolInfo', 'string', 'yes')}${svar('SinkProtocolInfo', 'string', 'yes')}${svar('CurrentConnectionIDs', 'string', 'yes')}
  ${svar('A_ARG_TYPE_ConnectionStatus', 'string')}${svar('A_ARG_TYPE_ConnectionManager', 'string')}${svar('A_ARG_TYPE_Direction', 'string')}${svar('A_ARG_TYPE_ProtocolInfo', 'string')}${svar('A_ARG_TYPE_ConnectionID', 'i4')}${svar('A_ARG_TYPE_AVTransportID', 'i4')}${svar('A_ARG_TYPE_RcsID', 'i4')}
</serviceStateTable></scpd>`;

const MIME_BY_EXT = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/avi', '.mov': 'video/quicktime', '.ts': 'video/mpeg', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
// DLNA streaming flags: byte-seek OK, streaming-transfer-mode
const DLNA_EXTRA = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
const SOURCE_PROTO = [...new Set(Object.values(MIME_BY_EXT))].map((m) => `http-get:*:${m}:*`).join(',');

const DIDL_NS = 'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/"';

function item(host, row, parent) {
  const ext = path.extname(row.path || '').toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'video/mp4';
  // derive the UPnP class from the ACTUAL file type — a "music" row that is
  // really a video (e.g. a downloaded music video) must not be offered as audio,
  // or the TV rejects it ("music not supported").
  const cls = mime.startsWith('audio/') ? 'object.item.audioItem.musicTrack'
    : mime.startsWith('image/') ? 'object.item.imageItem.photo'
      : row.type === 'episode' ? 'object.item.videoItem.videoBroadcast'
        : 'object.item.videoItem.movie';
  const sizeAttr = row.size ? ` size="${row.size}"` : '';
  return `<item id="m${row.id}" parentID="${parent}" restricted="1">`
    + `<dc:title>${esc(row.title)}</dc:title><upnp:class>${cls}</upnp:class>`
    + (row.artist ? `<upnp:artist>${esc(row.artist)}</upnp:artist><dc:creator>${esc(row.artist)}</dc:creator>` : '')
    + (row.album ? `<upnp:album>${esc(row.album)}</upnp:album>` : '')
    + `<res protocolInfo="http-get:*:${mime}:${DLNA_EXTRA}"${sizeAttr}>http://${host}/api/stream/${row.id}${ext}</res>`
    + `</item>`;
}

function container(id, parent, title, count) {
  return `<container id="${id}" parentID="${parent}" restricted="1" childCount="${count}">`
    + `<dc:title>${esc(title)}</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`;
}

const countType = (t) => db.prepare('SELECT COUNT(*) n FROM media WHERE type = ? AND missing = 0').get(t).n;
const ROOTS = () => [
  { id: 'movies', title: 'Movies', type: 'movie' },
  { id: 'series', title: 'Series', type: 'series' },
  { id: 'music', title: 'Music', type: 'track' },
];
const epLabel = (r) => {
  const tag = `S${String(r.season || 0).padStart(2, '0')}E${String(r.episode || 0).padStart(2, '0')}`;
  // drop the auto-generated "<Show> SxxEyy" title so it doesn't read "S01E01 Show S01E01"
  const name = /\sS\d{1,2}E\d{1,3}$/i.test(r.title || '') ? '' : (r.title || '');
  return name ? `${tag} ${name}` : tag;
};

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = (s) => { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return ''; } };
const TYPES = { movies: 'movie', series: 'series', music: 'track' };
// backing rows for a category: series = show rows; movies/music = playable files
function typeRows(t) {
  if (t === 'series') return db.prepare("SELECT * FROM media WHERE type='series' AND missing=0 ORDER BY sort_title").all();
  return db.prepare('SELECT * FROM media WHERE type=? AND missing=0 AND path IS NOT NULL ORDER BY sort_title').all(TYPES[t]);
}
function firstLetter(r) {
  const c = String(r.sort_title || r.title || '#').trim().toUpperCase()[0] || '#';
  return /[A-Z]/.test(c) ? c : '#';
}
const showChildCount = (id) => db.prepare('SELECT COUNT(*) n FROM media WHERE parent_id=? AND missing=0 AND path IS NOT NULL').get(id).n;
// render backing rows: series -> show containers, movies/music -> items
const leaf = (host, t, rows, parent) => (t === 'series'
  ? rows.map((r) => container('s' + r.id, parent, r.title, showChildCount(r.id)))
  : rows.map((r) => item(host, r, parent)));

/** DIDL fragments for the children of a container. */
function childrenOf(host, objectId) {
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  if (objectId === '0') return ROOTS().map((r) => container(r.id, '0', r.title, 3));

  // category root -> Alle / Genre / A–Z
  if (TYPES[objectId]) {
    const rows = typeRows(objectId);
    const genres = new Set(), letters = new Set();
    for (const r of rows) { for (const g of JSON.parse(r.genres || '[]')) if (g) genres.add(g); letters.add(firstLetter(r)); }
    return [
      container(`${objectId}:all`, objectId, 'Alle', rows.length),
      container(`${objectId}:genre`, objectId, 'Genre', genres.size),
      container(`${objectId}:alpha`, objectId, 'A–Z', letters.size),
    ];
  }
  let m;
  if ((m = objectId.match(/^(movies|series|music):all$/))) return leaf(host, m[1], typeRows(m[1]), objectId);
  if ((m = objectId.match(/^(movies|series|music):genre$/))) {
    const t = m[1], map = new Map();
    for (const r of typeRows(t)) for (const g of JSON.parse(r.genres || '[]')) if (g) map.set(g, (map.get(g) || 0) + 1);
    return [...map.keys()].sort((a, b) => a.localeCompare(b)).map((g) => container(`${t}:g:${b64(g)}`, objectId, g, map.get(g)));
  }
  if ((m = objectId.match(/^(movies|series|music):g:(.+)$/))) {
    const t = m[1], g = unb64(m[2]);
    return leaf(host, t, typeRows(t).filter((r) => JSON.parse(r.genres || '[]').includes(g)), objectId);
  }
  if ((m = objectId.match(/^(movies|series|music):alpha$/))) {
    const t = m[1], map = new Map();
    for (const r of typeRows(t)) { const L = firstLetter(r); map.set(L, (map.get(L) || 0) + 1); }
    return [...map.keys()].sort().map((L) => container(`${t}:a:${L}`, objectId, L, map.get(L)));
  }
  if ((m = objectId.match(/^(movies|series|music):a:(.+)$/))) {
    return leaf(host, m[1], typeRows(m[1]).filter((r) => firstLetter(r) === m[2]), objectId);
  }

  // series show -> seasons / episodes
  if (/^s\d+$/.test(objectId)) {
    const sid = Number(objectId.slice(1));
    const seasons = all('SELECT DISTINCT season FROM media WHERE parent_id=? AND missing=0 AND path IS NOT NULL AND season IS NOT NULL ORDER BY season', sid).map((r) => r.season);
    // more than one season -> show Season folders; otherwise list episodes directly
    if (seasons.length > 1) {
      return seasons.map((se) => container(`s${sid}-${se}`, objectId, `Season ${se}`,
        db.prepare('SELECT COUNT(*) n FROM media WHERE parent_id=? AND season=? AND missing=0 AND path IS NOT NULL').get(sid, se).n));
    }
    return all('SELECT * FROM media WHERE parent_id=? AND missing=0 AND path IS NOT NULL ORDER BY season, episode', sid).map((r) => item(host, { ...r, title: epLabel(r) }, objectId));
  }
  if (/^s\d+-\d+$/.test(objectId)) {
    const [, sid, se] = objectId.match(/^s(\d+)-(\d+)$/);
    return all('SELECT * FROM media WHERE parent_id=? AND season=? AND missing=0 AND path IS NOT NULL ORDER BY episode', Number(sid), Number(se)).map((r) => item(host, { ...r, title: epLabel(r) }, objectId));
  }
  return [];
}

/** DIDL fragment describing an object itself (BrowseMetadata). */
function metaOf(host, objectId) {
  if (objectId === '0') return container('0', '-1', esc(getSetting('appName') || 'NEBULA'), ROOTS().length);
  const root = ROOTS().find((r) => r.id === objectId);
  if (root) return container(root.id, '0', root.title, 3);
  // virtual containers (Alle / Genre / A–Z and their sub-folders)
  const parts = objectId.split(':');
  if (TYPES[parts[0]] && parts.length >= 2) {
    const t = parts[0];
    let title = '', parent = t;
    if (parts[1] === 'all') title = 'Alle';
    else if (parts[1] === 'genre') title = 'Genre';
    else if (parts[1] === 'alpha') title = 'A–Z';
    else if (parts[1] === 'g') { title = unb64(parts.slice(2).join(':')); parent = `${t}:genre`; }
    else if (parts[1] === 'a') { title = parts[2]; parent = `${t}:alpha`; }
    if (title) return container(objectId, parent, title, childrenOf(host, objectId).length);
  }
  if (/^s\d+$/.test(objectId)) {
    const r = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(objectId.slice(1)));
    return r ? container(objectId, 'series', r.title, db.prepare('SELECT COUNT(*) n FROM media WHERE parent_id = ? AND missing = 0').get(r.id).n) : '';
  }
  if (/^s\d+-\d+$/.test(objectId)) {
    const [, sid, se] = objectId.match(/^s(\d+)-(\d+)$/);
    return container(objectId, 's' + sid, `Season ${se}`, db.prepare('SELECT COUNT(*) n FROM media WHERE parent_id=? AND season=? AND missing=0 AND path IS NOT NULL').get(Number(sid), Number(se)).n);
  }
  if (/^m\d+$/.test(objectId)) {
    const r = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(objectId.slice(1)));
    if (!r) return '';
    const parent = r.parent_id ? 's' + r.parent_id : r.type === 'track' ? 'music' : 'movies';
    return item(host, r.type === 'episode' ? { ...r, title: epLabel(r) } : r, parent);
  }
  return '';
}

function soap(action, service, inner) {
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:${action}Response xmlns:u="${service}">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}

function browseResponse(host, objectId, flag, start, count) {
  let frags, total;
  if (flag === 'BrowseMetadata') { const m = metaOf(host, objectId); frags = m ? [m] : []; total = frags.length; }
  else { const kids = childrenOf(host, objectId); total = kids.length; frags = count > 0 ? kids.slice(start, start + count) : kids.slice(start); }
  const didl = `<DIDL-Lite ${DIDL_NS}>${frags.join('')}</DIDL-Lite>`;
  return soap('Browse', CD_TYPE, `<Result>${esc(didl)}</Result><NumberReturned>${frags.length}</NumberReturned><TotalMatches>${total}</TotalMatches><UpdateID>1</UpdateID>`);
}

function cdControl(host, action, body) {
  // tolerate namespace prefixes / attributes on the argument elements
  const val = (tag) => (body.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i')) || [])[1];
  if (action === 'Browse') {
    return browseResponse(host, (val('ObjectID') || '0').trim(), (val('BrowseFlag') || 'BrowseDirectChildren').trim(),
      Number(val('StartingIndex')) || 0, Number(val('RequestedCount')) || 0);
  }
  if (action === 'GetSortCapabilities') return soap('GetSortCapabilities', CD_TYPE, '<SortCaps>dc:title</SortCaps>');
  if (action === 'GetSearchCapabilities') return soap('GetSearchCapabilities', CD_TYPE, '<SearchCaps></SearchCaps>');
  if (action === 'GetSystemUpdateID') return soap('GetSystemUpdateID', CD_TYPE, '<Id>1</Id>');
  return null;
}

function cmControl(action) {
  if (action === 'GetProtocolInfo') return soap('GetProtocolInfo', CM_TYPE, `<Source>${esc(SOURCE_PROTO)}</Source><Sink></Sink>`);
  if (action === 'GetCurrentConnectionIDs') return soap('GetCurrentConnectionIDs', CM_TYPE, '<ConnectionIDs></ConnectionIDs>');
  if (action === 'GetCurrentConnectionInfo') return soap('GetCurrentConnectionInfo', CM_TYPE,
    '<RcsID>-1</RcsID><AVTransportID>-1</AVTransportID><ProtocolInfo></ProtocolInfo><PeerConnectionManager></PeerConnectionManager><PeerConnectionID>-1</PeerConnectionID><Direction>Output</Direction><Status>OK</Status>');
  return null;
}

function soapAction(req, body) {
  const h = String(req.headers.soapaction || '').replace(/"/g, '');
  if (h.includes('#')) return h.split('#')[1].trim();
  // fallback: name of the first element inside <s:Body> (some clients omit SOAPACTION)
  const m = String(body || '').match(/<(?:\w+:)?Body[^>]*>\s*<(?:(\w+):)?(\w+)/i);
  return m ? m[2] : '';
}
function sendFault(res) {
  res.status(500).type('text/xml; charset="utf-8"').send('<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>'
    + '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
}

/* ---------- device icon, tinted with the web UI accent hue ---------- */
let CRC;
function crc32(buf) {
  if (!CRC) { CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c; } }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// colorType 2 = 24-bit RGB (no alpha) — DLNA TVs want opaque icons, not RGBA
function encodePng(w, h, data, colorType = 2) {
  const ch = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc(h * (w * ch + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * ch + 1)] = 0; data.copy(raw, y * (w * ch + 1) + 1, y * w * ch, (y + 1) * w * ch); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}
/** OKLCH -> sRGB (matches the web UI's oklch(0.82 0.15 <hue>) accent). */
function oklchToRgb(L, C, hDeg) {
  const hr = hDeg * Math.PI / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return lin.map((c) => Math.max(0, Math.min(255, Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255))));
}
const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x < x1 && y >= y0 && y < y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r + r;
};
let iconCache = { hue: null };
function deviceIcon(size) {
  const S = size === 48 ? 48 : 120;
  const hue = Number(getSetting('defaultHue')) || 165;
  if (iconCache.hue !== hue) iconCache = { hue };
  if (iconCache[S]) return iconCache[S];
  const [r, g, b] = oklchToRgb(0.82, 0.15, hue), bg = [11, 14, 21], dark = [6, 18, 13];
  const pad = Math.round(S * 0.06), rad = Math.round(S * 0.22);
  const ip = Math.round(S * 0.35), irad = Math.round(S * 0.07);
  const buf = Buffer.alloc(S * S * 3); // opaque RGB on a solid dark tile
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 3;
    let c = bg;
    if (roundRect(x, y, pad, pad, S - pad, S - pad, rad)) c = roundRect(x, y, ip, ip, S - ip, S - ip, irad) ? dark : [r, g, b];
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
  }
  iconCache[S] = encodePng(S, S, buf, 2);
  return iconCache[S];
}
/** re-announce over SSDP (e.g. after the accent hue changed) so TVs re-describe. */
function notifyNow() { try { notifyAlive(); } catch { } }

/** Express routes for the HTTP side of DLNA. */
function mount(app) {
  const guard = (req, res, next) => (getSetting('dlnaEnabled') ? next() : res.status(404).end());
  const xml = (res, body) => res.type('text/xml; charset="utf-8"').send(body);
  const textBody = require('express').text({ type: '*/*', limit: '512kb' });

  app.get('/dlna/device.xml', guard, (req, res) => xml(res, deviceXml()));
  app.get('/dlna/cd.xml', guard, (req, res) => xml(res, CD_SCPD));
  app.get('/dlna/cm.xml', guard, (req, res) => xml(res, CM_SCPD));
  app.get('/dlna/icon.png', guard, (req, res) => res.type('image/png').set('Cache-Control', 'no-cache').send(deviceIcon(Number(req.query.s) || 120)));

  app.post('/dlna/control', guard, textBody, (req, res) => {
    const body = String(req.body || '');
    const out = cdControl(req.headers.host, soapAction(req, body), body);
    out ? xml(res, out) : sendFault(res);
  });
  app.post('/dlna/cm_control', guard, textBody, (req, res) => {
    const out = cmControl(soapAction(req, String(req.body || '')));
    out ? xml(res, out) : sendFault(res);
  });

  // GENA event subscriptions: acknowledge so TVs don't abort with "try again later"
  app.use(['/dlna/cd_event', '/dlna/cm_event'], (req, res, next) => {
    if (req.method === 'SUBSCRIBE') {
      return res.status(200).set({ SID: 'uuid:' + crypto.randomBytes(8).toString('hex'), TIMEOUT: 'Second-1800', Server: 'NEBULA/1.0' }).end();
    }
    if (req.method === 'UNSUBSCRIBE') return res.status(200).end();
    next();
  });
}

module.exports = { start, stop, mount, lanInterfaces, bestLocalIp, notifyNow };
