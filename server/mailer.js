// Email notifications via user-configured SMTP.
const nodemailer = require('nodemailer');
const { db, getSetting } = require('./db');

function transporter() {
  const smtp = getSetting('smtp') || {};
  if (!smtp.host) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: !!smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
}

async function sendMail(to, subject, html) {
  const t = transporter();
  const smtp = getSetting('smtp') || {};
  if (!t) return { ok: false, error: 'smtp_not_configured' };
  try {
    await t.sendMail({ from: smtp.from || smtp.user, to, subject, html });
    db.prepare('INSERT INTO email_log (recipient, subject, ok, sent_at) VALUES (?,?,1,?)').run(to, subject, Date.now());
    return { ok: true };
  } catch (e) {
    db.prepare('INSERT INTO email_log (recipient, subject, ok, error, sent_at) VALUES (?,?,0,?,?)')
      .run(to, subject, String(e.message).slice(0, 400), Date.now());
    return { ok: false, error: String(e.message) };
  }
}

function frame(appName, bodyHtml) {
  return `<div style="background:#07090d;color:#e9eef6;font-family:Arial,sans-serif;padding:32px">
    <div style="max-width:560px;margin:0 auto;background:#0b0e15;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:28px">
      <div style="font-size:22px;font-weight:900;letter-spacing:-1px;margin-bottom:18px">
        <span style="display:inline-block;width:16px;height:16px;background:#59e0b8;border-radius:4px;margin-right:8px"></span>${appName}
      </div>
      ${bodyHtml}
      <div style="margin-top:24px;padding-top:14px;border-top:1px solid rgba(255,255,255,.1);color:#8995a8;font-size:12px">
        ${appName} · self-hosted media server
      </div>
    </div></div>`;
}

/** Notify all opted-in users about media added by a scan. */
async function notifyNewMedia(newItems) {
  if (!getSetting('notifyOnNewMedia') || !newItems.length) return;
  const appName = getSetting('appName') || 'NEBULA';
  const users = db.prepare("SELECT email, prefs FROM users WHERE email IS NOT NULL").all()
    .filter((u) => { try { return JSON.parse(u.prefs).emailNotify !== false; } catch { return true; } });
  if (!users.length) return;
  const titles = newItems.filter((i) => i.type === 'movie' || i.type === 'episode').slice(0, 25);
  if (!titles.length) return;
  const rows = titles.map((t) =>
    `<li style="margin:6px 0">${t.title}${t.year ? ` <span style="color:#8995a8">(${t.year})</span>` : ''}</li>`).join('');
  const html = frame(appName,
    `<h2 style="margin:0 0 10px;font-size:17px">New on your server</h2>
     <p style="color:#c3ccd9">${newItems.length} new item(s) were just added to the library:</p>
     <ul style="color:#e9eef6;padding-left:18px">${rows}</ul>`);
  for (const u of users) await sendMail(u.email, `${appName}: ${titles.length} new title(s) added`, html);
}

/** Watchlist arrivals: a wanted trending title just appeared in the library. */
async function checkWatchlistArrivals() {
  const appName = getSetting('appName') || 'NEBULA';
  const pending = db.prepare('SELECT * FROM watchlist WHERE notified = 0').all();
  if (!pending.length) return;
  const byTmdb = new Map();
  for (const r of db.prepare('SELECT id, tmdb_id, title FROM media WHERE tmdb_id IS NOT NULL AND missing = 0').all()) {
    byTmdb.set(r.tmdb_id, r);
  }
  for (const w of pending) {
    const hit = byTmdb.get(w.tmdb_id);
    if (!hit) continue;
    db.prepare('UPDATE watchlist SET notified = 1 WHERE user_id = ? AND tmdb_id = ?').run(w.user_id, w.tmdb_id);
    require('./events').emit('global', 'watchlistArrived', { title: w.title, localId: hit.id });
    const user = w.user_id > 0 && w.user_id < 1000000
      ? db.prepare('SELECT email FROM users WHERE id = ?').get(w.user_id) : null;
    if (user?.email) {
      await sendMail(user.email, `${appName}: “${w.title}” is now available`,
        frame(appName, `<h2 style="margin:0 0 10px;font-size:17px">It's here 🎬</h2>
          <p style="color:#c3ccd9"><b style="color:#e9eef6">${w.title}</b>${w.year ? ` (${w.year})` : ''} from your watchlist just landed on your server.</p>`));
    }
  }
}

async function sendTest(to) {
  const appName = getSetting('appName') || 'NEBULA';
  return sendMail(to, `${appName} test email`,
    frame(appName, `<p style="color:#c3ccd9">SMTP is configured correctly — notifications will arrive at this address.</p>`));
}

function emailLog(limit = 50) {
  return db.prepare('SELECT * FROM email_log ORDER BY sent_at DESC LIMIT ?').all(limit);
}

module.exports = { sendMail, notifyNewMedia, checkWatchlistArrivals, sendTest, emailLog };
