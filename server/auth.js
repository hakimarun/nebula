// Optional authentication. When settings.authEnabled is false every request
// runs as a virtual admin, so the whole app works with zero login friction.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, getSetting, userRow } = require('./db');
const { JWT_SECRET } = require('./config');

const ANON_ADMIN = {
  id: 0, username: 'guest', role: 'admin',
  perms: { upload: true, editMedia: true, deleteMedia: true, music: true, images: true, manageUsers: true, settings: true },
  prefs: {},
};

const DEFAULT_USER_PERMS = { upload: false, editMedia: false, deleteMedia: false, music: true, images: true, manageUsers: false, settings: false };
const ADMIN_PERMS = { upload: true, editMedia: true, deleteMedia: true, music: true, images: true, manageUsers: true, settings: true };

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function getUser(id) {
  return userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

const PROFILE_ID_BASE = 1000000; // profile "user ids" live far above real user ids

/** Attaches req.user. If auth is disabled, everyone is an anonymous admin —
 *  optionally scoped to a local profile (X-Nebula-Profile header). */
function authMiddleware(req, res, next) {
  if (!getSetting('authEnabled')) {
    req.user = ANON_ADMIN;
    const pid = Number(req.headers['x-nebula-profile'] || req.query.profile || 0);
    if (pid && getSetting('profilesEnabled')) {
      const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(pid);
      if (p) {
        req.user = {
          ...ANON_ADMIN,
          id: PROFILE_ID_BASE + p.id,
          username: p.name,
          profile: { id: p.id, name: p.name, hue: p.hue, kid: !!p.kid },
          perms: p.kid
            ? { upload: false, editMedia: false, deleteMedia: false, music: true, images: true, manageUsers: false, settings: false }
            : ANON_ADMIN.perms,
          role: p.kid ? 'user' : 'admin',
        };
        if (p.kid) req.kidMode = true;
      }
    }
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  if (!token) { req.user = null; return next(); }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = getUser(payload.uid);
  } catch { req.user = null; }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'auth_required' });
    if (req.user.role === 'admin' || req.user.perms[perm]) return next();
    res.status(403).json({ error: 'forbidden', perm });
  };
}

/* ---------- routes ---------- */
const router = express.Router();

/* login rate limiting: 10 attempts per 10 minutes per IP */
const loginAttempts = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600e3;
  for (const [ip, hits] of loginAttempts) {
    const fresh = hits.filter((t) => t > cutoff);
    if (fresh.length) loginAttempts.set(ip, fresh); else loginAttempts.delete(ip);
  }
}, 60e3);

router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '?';
  const hits = (loginAttempts.get(ip) || []).filter((t) => t > Date.now() - 600e3);
  if (hits.length >= 10) return res.status(429).json({ error: 'too_many_attempts' });
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase());
  if (!row || !bcrypt.compareSync(String(password || ''), row.pass_hash)) {
    hits.push(Date.now());
    loginAttempts.set(ip, hits);
    return res.status(401).json({ error: 'bad_credentials' });
  }
  loginAttempts.delete(ip);
  const user = userRow(row);
  res.json({ token: signToken(user), user });
});

router.post('/register', (req, res) => {
  if (!getSetting('allowRegistration')) return res.status(403).json({ error: 'registration_disabled' });
  const { username, password, email } = req.body || {};
  const name = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9_.-]{2,32}$/.test(name)) return res.status(400).json({ error: 'invalid_username' });
  if (String(password || '').length < 4) return res.status(400).json({ error: 'password_too_short' });
  try {
    const info = db.prepare(
      'INSERT INTO users (username, email, pass_hash, role, perms, prefs, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(name, email || null, bcrypt.hashSync(password, 10), 'user',
        JSON.stringify(DEFAULT_USER_PERMS), '{}', Date.now());
    const user = getUser(Number(info.lastInsertRowid));
    res.json({ token: signToken(user), user });
  } catch {
    res.status(409).json({ error: 'username_taken' });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user, authEnabled: !!getSetting('authEnabled') });
});

router.put('/me/prefs', authMiddleware, requireUser, (req, res) => {
  if (req.user.id === 0) return res.json({ ok: true, prefs: req.body || {} }); // anon: client keeps prefs locally
  const prefs = { ...req.user.prefs, ...(req.body || {}) };
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.json({ ok: true, prefs });
});

router.put('/me/password', authMiddleware, requireUser, (req, res) => {
  const { current, next } = req.body || {};
  if (req.user.id === 0) return res.status(400).json({ error: 'anonymous' });
  const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), row.pass_hash)) return res.status(401).json({ error: 'bad_credentials' });
  if (String(next || '').length < 4) return res.status(400).json({ error: 'password_too_short' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.user.id);
  res.json({ ok: true });
});

/* ---- user management (admin) ---- */
router.get('/users', authMiddleware, requirePerm('manageUsers'), (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(userRow));
});

router.post('/users', authMiddleware, requirePerm('manageUsers'), (req, res) => {
  const { username, password, email, role, perms } = req.body || {};
  const name = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9_.-]{2,32}$/.test(name)) return res.status(400).json({ error: 'invalid_username' });
  if (String(password || '').length < 4) return res.status(400).json({ error: 'password_too_short' });
  try {
    const info = db.prepare(
      'INSERT INTO users (username, email, pass_hash, role, perms, prefs, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(name, email || null, bcrypt.hashSync(password, 10),
        role === 'admin' ? 'admin' : 'user',
        JSON.stringify(role === 'admin' ? ADMIN_PERMS : { ...DEFAULT_USER_PERMS, ...(perms || {}) }),
        '{}', Date.now());
    res.json(getUser(Number(info.lastInsertRowid)));
  } catch {
    res.status(409).json({ error: 'username_taken' });
  }
});

router.put('/users/:id', authMiddleware, requirePerm('manageUsers'), (req, res) => {
  const id = Number(req.params.id);
  const user = getUser(id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const { role, perms, email, password } = req.body || {};
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'user', id);
  if (perms) db.prepare('UPDATE users SET perms = ? WHERE id = ?').run(JSON.stringify({ ...user.perms, ...perms }), id);
  if (email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || null, id);
  if (password) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), id);
  res.json(getUser(id));
});

router.delete('/users/:id', authMiddleware, requirePerm('manageUsers'), (req, res) => {
  const id = Number(req.params.id);
  if (req.user.id === id) return res.status(400).json({ error: 'cannot_delete_self' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.prepare('DELETE FROM progress WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM my_list WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

function createAdmin(username, password, email) {
  const name = String(username).toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (existing) {
    db.prepare('UPDATE users SET pass_hash = ?, role = ?, perms = ? WHERE id = ?')
      .run(bcrypt.hashSync(password, 10), 'admin', JSON.stringify(ADMIN_PERMS), existing.id);
    return getUser(existing.id);
  }
  const info = db.prepare(
    'INSERT INTO users (username, email, pass_hash, role, perms, prefs, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(name, email || null, bcrypt.hashSync(password, 10), 'admin', JSON.stringify(ADMIN_PERMS), '{}', Date.now());
  return getUser(Number(info.lastInsertRowid));
}

module.exports = { router, authMiddleware, requireUser, requirePerm, createAdmin, signToken };
