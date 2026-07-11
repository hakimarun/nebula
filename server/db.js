// SQLite layer — uses Node's built-in node:sqlite (no native build step).
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE } = require('./config');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- admin | user
  perms TEXT NOT NULL DEFAULT '{}',           -- JSON: {upload, editMedia, deleteMedia, music, images, manageUsers}
  prefs TEXT NOT NULL DEFAULT '{}',           -- JSON: {hue, locale, emailNotify, autoplayTrailers, ...}
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                         -- movie | series | episode | track | image
  title TEXT NOT NULL,
  sort_title TEXT,
  year INTEGER,
  path TEXT,                                  -- absolute file path for local media
  size INTEGER,
  duration REAL,
  parent_id INTEGER,                          -- episodes/tracks/images -> parent series/album/folder
  season INTEGER,
  episode INTEGER,
  genres TEXT NOT NULL DEFAULT '[]',          -- JSON array of genre names
  overview TEXT,
  poster TEXT,
  backdrop TEXT,
  trailer_key TEXT,                           -- YouTube video key
  tmdb_id INTEGER,
  imdb_id TEXT,
  rating REAL,                                -- TMDB vote average 0-10
  votes INTEGER,
  cert TEXT,                                  -- age certification e.g. PG-13
  source TEXT NOT NULL DEFAULT 'local',       -- local | youtube | vimeo | dailymotion | streamtape | spotify | soundcloud | url
  external_url TEXT,
  artist TEXT,                                -- music
  album TEXT,
  missing INTEGER NOT NULL DEFAULT 0,         -- file vanished on last scan
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_parent ON media(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_path ON media(path) WHERE path IS NOT NULL;

CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL,
  media_id INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE TABLE IF NOT EXISTS my_list (
  user_id INTEGER NOT NULL,
  media_id INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL,
  author TEXT,
  rating REAL,
  content TEXT,
  source TEXT DEFAULT 'tmdb',
  url TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reviews_media ON reviews(media_id);

CREATE TABLE IF NOT EXISTS intro_markers (
  series_id INTEGER NOT NULL,
  season INTEGER NOT NULL DEFAULT 0,
  start REAL NOT NULL,
  end REAL NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto',        -- auto | manual
  PRIMARY KEY (series_id, season)
);

-- Per-episode intro window: intros with a variable-length cold open (e.g. Game
-- of Thrones) start at a different time each episode, so a single per-season
-- marker is wrong. When audio detection locates the shared intro inside each
-- episode individually, it stores the exact window here (takes precedence).
CREATE TABLE IF NOT EXISTS intro_ep (
  media_id INTEGER PRIMARY KEY,
  start REAL NOT NULL,
  end REAL NOT NULL,
  confidence REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skip_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL,
  season INTEGER NOT NULL DEFAULT 0,
  from_sec REAL NOT NULL,
  to_sec REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skip_series ON skip_events(series_id, season);

CREATE TABLE IF NOT EXISTS trending_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'movie',
  title TEXT NOT NULL,
  year INTEGER,
  poster TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tmdb_id)
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hue INTEGER NOT NULL DEFAULT 165,
  kid INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT,
  subject TEXT,
  ok INTEGER,
  error TEXT,
  sent_at INTEGER NOT NULL
);
`);

/* ---------- settings helpers ---------- */
const DEFAULT_SETTINGS = {
  setupComplete: false,
  appName: 'NEBULA',
  authEnabled: false,
  allowRegistration: false,
  tmdbApiKey: '',
  tmdbLanguage: 'en-US',
  libraryPaths: { movies: [], series: [], music: [], images: [] },
  scanIntervalMin: 60,
  defaultHue: 165,
  defaultLocale: 'en',
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  notifyOnNewMedia: false,
  trendingRefreshHours: 12,
  introDefault: { start: 0, end: 0 },      // fallback marker when nothing detected
  playback: { autoplayNext: true, skipIntroAuto: true, defaultSubtitleLang: 'en', watchedThreshold: 0.92, maxHeight: 0 },
  ui: { showMatch: true, cardSize: 268, heroEnabled: true, top10Enabled: true, rowsOrder: ['continue','top10','trending','movies','series','genres'] },
  ffmpegPath: '',
  profilesEnabled: false,
  openSubtitles: { apiKey: '', username: '', password: '', langs: ['en'] },
  dlnaEnabled: false,
  backupSchedule: { enabled: false, intervalHours: 24, keep: 7 },
  uploadCleanNames: true,
  offlineMode: false,   // auto-download external streams for offline playback
  offlinePath: '',      // where downloads land (empty = <data>/offline)
  ytdlpPath: '',        // optional yt-dlp binary/folder for platform downloads
  mdnsEnabled: true,    // advertise <localHostname>.local on the LAN via mDNS
  localHostname: 'nebula',
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

// Fill in keys that a stored object-setting is missing from the defaults, so
// newly-added default fields (e.g. a new playback flag) take effect on installs
// that already have the object persisted. Stored values still win when present.
function withDefaults(key, stored) {
  const def = DEFAULT_SETTINGS[key];
  if (def && typeof def === 'object' && !Array.isArray(def)
      && stored && typeof stored === 'object' && !Array.isArray(stored)) {
    return { ...def, ...stored };
  }
  return stored;
}

function getSetting(key) {
  const row = getSettingStmt.get(key);
  if (!row) return structuredClone(DEFAULT_SETTINGS[key]);
  let val; try { val = JSON.parse(row.value); } catch { return row.value; }
  return withDefaults(key, val);
}

function setSetting(key, value) {
  setSettingStmt.run(key, JSON.stringify(value));
}

function getAllSettings() {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    let val; try { val = JSON.parse(row.value); } catch { val = row.value; }
    out[row.key] = withDefaults(row.key, val);
  }
  return out;
}

/* ---------- row mappers ---------- */
function mediaRow(r) {
  if (!r) return null;
  return {
    id: r.id, type: r.type, title: r.title, year: r.year,
    path: r.path, size: r.size, duration: r.duration,
    parentId: r.parent_id, season: r.season, episode: r.episode,
    genres: JSON.parse(r.genres || '[]'),
    overview: r.overview, poster: r.poster, backdrop: r.backdrop,
    trailerKey: r.trailer_key, tmdbId: r.tmdb_id, imdbId: r.imdb_id,
    rating: r.rating, votes: r.votes, cert: r.cert,
    source: r.source, externalUrl: r.external_url,
    artist: r.artist, album: r.album, missing: !!r.missing,
    addedAt: r.added_at, updatedAt: r.updated_at,
    extra: JSON.parse(r.extra || '{}'),
  };
}

function userRow(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, email: r.email, role: r.role,
    perms: JSON.parse(r.perms || '{}'), prefs: JSON.parse(r.prefs || '{}'),
    createdAt: r.created_at,
  };
}

module.exports = { db, getSetting, setSetting, getAllSettings, DEFAULT_SETTINGS, mediaRow, userRow };
