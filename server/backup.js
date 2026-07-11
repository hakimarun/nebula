// Backup & restore: zips the SQLite database + settings into data/backups.
const fs = require('fs');
const path = require('path');
const { db, getAllSettings } = require('./db');
const { DB_FILE, BACKUP_DIR } = require('./config');
const { writeZip, readZip } = require('./util');

function createBackup() {
  // checkpoint WAL so the main db file is complete
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `nebula-backup-${stamp}.zip`;
  const out = path.join(BACKUP_DIR, name);
  writeZip([
    { name: 'nebula.db', file: DB_FILE },
    { name: 'settings.json', data: Buffer.from(JSON.stringify(getAllSettings(), null, 2)) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ app: 'nebula', version: 1, createdAt: Date.now() })) },
  ], out);
  return { name, size: fs.statSync(out).size };
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function backupPath(name) {
  const safe = path.basename(name);
  const p = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(p)) return null;
  return p;
}

function deleteBackup(name) {
  const p = backupPath(name);
  if (p) fs.unlinkSync(p);
  return !!p;
}

/**
 * Restore a backup zip: swaps the database file in place. The server needs a
 * restart afterwards (node:sqlite keeps the old handle) — the API tells the
 * client, and index.js exits so a process manager / the user restarts it.
 */
function restoreBackup(zipFile) {
  const entries = readZip(zipFile);
  const dbEntry = entries.find((e) => e.name === 'nebula.db');
  if (!dbEntry) throw new Error('invalid_backup');
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { }
  fs.writeFileSync(DB_FILE + '.restore', dbEntry.data);
  fs.copyFileSync(DB_FILE, DB_FILE + '.pre-restore');
  fs.renameSync(DB_FILE + '.restore', DB_FILE);
  // WAL/SHM from the old db would corrupt the restored one
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch { }
  }
  return { ok: true, restartRequired: true };
}

module.exports = { createBackup, listBackups, backupPath, deleteBackup, restoreBackup };
