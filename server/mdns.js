// mDNS / Bonjour responder: makes the web UI reachable at <hostname>.local
// (default nebula.local) on the LAN, and advertises an _http._tcp service so it
// shows up in network/service browsers. One responder per real LAN interface so
// it works on multi-homed hosts (e.g. WLAN alongside a VMware adapter).
const makeMdns = require('multicast-dns');
const { getSetting } = require('./db');
const { PORT } = require('./config');
const { lanInterfaces } = require('./dlna');

const SVC = '_http._tcp.local';
let instances = [];   // { mdns, ip }
let host = null;      // "<name>.local"
let inst = null;      // "<name>._http._tcp.local"
let timer = null;

function sanitize() {
  return String(getSetting('localHostname') || 'nebula').trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'nebula';
}
const aRec = (ip) => ({ name: host, type: 'A', ttl: 120, data: ip });
const srvRec = () => ({ name: inst, type: 'SRV', ttl: 120, data: { port: PORT, target: host, weight: 0, priority: 0 } });
const txtRec = () => ({ name: inst, type: 'TXT', ttl: 120, data: ['path=/'] });
const ptrRec = () => ({ name: SVC, type: 'PTR', ttl: 120, data: inst });

function handleQuery(m, ip, query) {
  const ans = [];
  for (const q of query.questions || []) {
    const name = String(q.name || '').toLowerCase();
    const t = q.type;
    if ((t === 'A' || t === 'ANY') && name === host) ans.push(aRec(ip));
    if ((t === 'PTR' || t === 'ANY') && name === SVC) ans.push(ptrRec());
    if ((t === 'PTR' || t === 'ANY') && name === '_services._dns-sd._udp.local') ans.push({ name, type: 'PTR', ttl: 120, data: SVC });
    if ((t === 'SRV' || t === 'ANY') && name === inst) ans.push(srvRec(), aRec(ip));
    if ((t === 'TXT' || t === 'ANY') && name === inst) ans.push(txtRec());
  }
  if (ans.length) { try { m.respond({ answers: ans }); } catch { } }
}

/** Gratuitous announcement so caches populate without a query. */
function announce() {
  for (const { mdns, ip } of instances) {
    try { mdns.respond({ answers: [aRec(ip), ptrRec(), srvRec(), txtRec()] }); } catch { }
  }
}

function start() {
  if (instances.length) return;
  host = sanitize() + '.local';
  inst = sanitize() + '.' + SVC;
  for (const iface of lanInterfaces()) {
    let m;
    try { m = makeMdns({ reuseAddr: true, loopback: false, interface: iface.address }); }
    catch { continue; }
    m.on('error', () => { });
    m.on('query', (q) => handleQuery(m, iface.address, q));
    instances.push({ mdns: m, ip: iface.address });
  }
  if (!instances.length) return;
  announce();
  setTimeout(announce, 1000);
  timer = setInterval(announce, 60000);
  console.log('[mdns] responding for', host, '(:' + PORT + ') on', instances.map((i) => i.ip).join(', '));
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const { mdns } of instances) { try { mdns.destroy(); } catch { } }
  instances = [];
}

function restart() {
  stop();
  if (getSetting('mdnsEnabled') !== false) start();
}

module.exports = { start, stop, restart };
