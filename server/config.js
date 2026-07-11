// Central paths + runtime config for NEBULA.
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.NEBULA_DATA || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'nebula.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const UPLOAD_TMP = path.join(DATA_DIR, 'upload-tmp');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

for (const d of [DATA_DIR, BACKUP_DIR, UPLOAD_TMP, CACHE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Secret for JWT signing — generated once, persisted next to the db.
const SECRET_FILE = path.join(DATA_DIR, '.secret');
let secret;
if (fs.existsSync(SECRET_FILE)) {
  secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
  secret = require('crypto').randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret);
}

module.exports = {
  ROOT, DATA_DIR, DB_FILE, BACKUP_DIR, UPLOAD_TMP, CACHE_DIR, CLIENT_DIST,
  JWT_SECRET: secret,
  PORT: Number(process.env.NEBULA_PORT || 8474),
  VIDEO_EXT: ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts', '.wmv', '.flv'],
  AUDIO_EXT: ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma'],
  IMAGE_EXT: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'],
  SUB_EXT: ['.srt', '.vtt', '.ass', '.ssa', '.sub'],
};
