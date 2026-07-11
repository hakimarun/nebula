// NEBULA server entry point.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { PORT, CLIENT_DIST, DATA_DIR, BACKUP_DIR } = require('./config');
const { getSetting } = require('./db');
const { router: authRouter } = require('./auth');
const { router: apiRouter, runScan } = require('./routes');
const { router: apiRouter2 } = require('./routes2');
const dlna = require('./dlna');
const scanner = require('./scanner');
const backup = require('./backup');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

app.use('/api/auth', authRouter);
app.use('/api', apiRouter2);
app.use('/api', apiRouter);
dlna.mount(app);

// built React client
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, {
    maxAge: '30d', index: 'index.html',
    setHeaders: (res, file) => {
      // hashed assets are immutable; the entry html must always revalidate
      if (file.endsWith('.html') || file.endsWith('sw.js') || file.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get(/^(?!\/api|\/dlna).*/, (req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res
    .status(503)
    .send('<pre>NEBULA: client not built yet.\nRun:  cd client && npm install && npm run build</pre>'));
}

app.use((err, req, res, next) => {
  console.error('[nebula]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal', message: err.message });
});

/* HTTPS when cert paths are provided (NEBULA_TLS_CERT / NEBULA_TLS_KEY) */
const certFile = process.env.NEBULA_TLS_CERT;
const keyFile = process.env.NEBULA_TLS_KEY;
let server;
if (certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  server = require('https').createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
  server.listen(PORT, () => console.log(`NEBULA running on https://localhost:${PORT}`));
} else {
  server = app.listen(PORT, () => console.log(`NEBULA running on http://localhost:${PORT}`));
}

// advertise <hostname>.local on the LAN (works even before first-run setup)
if (getSetting('mdnsEnabled') !== false) { try { require('./mdns').start(); } catch (e) { console.error('mdns:', e.message); } }

function boot() {
  if (!getSetting('setupComplete')) return;
  setTimeout(() => { try { runScan(); } catch (e) { console.error('scan failed:', e.message); } }, 3000);
  scanner.setupWatchers(() => { try { runScan(); } catch { } });
  if (getSetting('dlnaEnabled')) dlna.start();
  // detect intro markers in the background, independent of the scan/probe queue
  setTimeout(() => { require('./introAudio').detectAllPending().catch(() => { }); }, 25000);
}
boot();

/* keep detecting intro markers for any season that still lacks one (guarded:
   a no-op while a pass is running or when nothing is pending) */
setInterval(() => {
  if (!getSetting('setupComplete')) return;
  try { require('./introAudio').detectAllPending().catch(() => { }); } catch { }
}, 5 * 60e3);

/* periodic rescan + watcher refresh + DLNA toggle */
setInterval(() => {
  if (!getSetting('setupComplete')) return;
  const min = Number(getSetting('scanIntervalMin')) || 60;
  const last = scanner.libraryStats().lastScan || 0;
  if (Date.now() - last >= min * 60e3) {
    try { runScan(); } catch (e) { console.error('scan failed:', e.message); }
  }
  scanner.setupWatchers(() => { try { runScan(); } catch { } });
  if (getSetting('dlnaEnabled')) dlna.start(); else dlna.stop();
  // offline mode: pick up any external streams still awaiting a local copy
  if (getSetting('offlineMode')) { try { require('./downloader').enqueuePending(); } catch { } }
}, 60e3);

/* scheduled automatic backups */
setInterval(() => {
  if (!getSetting('setupComplete')) return;
  const sched = getSetting('backupSchedule') || {};
  if (!sched.enabled) return;
  const intervalMs = Math.max(1, Number(sched.intervalHours) || 24) * 3600e3;
  const stampFile = path.join(DATA_DIR, '.last-auto-backup');
  let last = 0;
  try { last = Number(fs.readFileSync(stampFile, 'utf8')) || 0; } catch { }
  if (Date.now() - last < intervalMs) return;
  try {
    backup.createBackup();
    fs.writeFileSync(stampFile, String(Date.now()));
    // retention: keep newest N automatic+manual backups
    const keep = Math.max(1, Number(sched.keep) || 7);
    const all = backup.listBackups();
    for (const b of all.slice(keep)) backup.deleteBackup(b.name);
    console.log('[backup] scheduled backup created');
  } catch (e) { console.error('[backup] scheduled backup failed:', e.message); }
}, 5 * 60e3);
