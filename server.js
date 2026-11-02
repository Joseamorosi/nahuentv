// NahuenTV — cloud control panel + TV player server.
// Run: node --disable-warning=ExperimentalWarning server.js
'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);
const APP_BUILD = String(Date.now()); // players reload when the server is updated/restarted
const ONLINE_MS = 90 * 1000;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'signage.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, position INTEGER DEFAULT 0,
  screen_on TEXT, screen_off TEXT
);
CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY, filename TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
  type TEXT NOT NULL, mime TEXT, size INTEGER, created INTEGER
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, duration INTEGER DEFAULT 10, muted INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tvs (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER DEFAULT 0,
  key TEXT NOT NULL UNIQUE,
  playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  live_capable INTEGER DEFAULT 0, live_app TEXT DEFAULT '',
  mode TEXT DEFAULT 'signage',
  last_seen INTEGER, now_playing TEXT, player_info TEXT
);
CREATE TABLE IF NOT EXISTS live_schedules (
  id INTEGER PRIMARY KEY,
  tv_id INTEGER NOT NULL REFERENCES tvs(id) ON DELETE CASCADE,
  days TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL
);
`);

const q = (sql) => db.prepare(sql);
// Media folders (added after v1: create/upgrade in place).
db.exec('CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
if (!q("SELECT 1 FROM pragma_table_info('media') WHERE name='folder_id'").get()) {
  db.exec('ALTER TABLE media ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL');
}
const getSetting = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
const setSetting = (k, v) => q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
// Short TV links, easy to type with a remote: no 0/o or 1/l/i.
// shortcut: 6 chars (~30 bits) is guessable only by brute force and a guess just shows a slideshow; lengthen if links ever grant control.
const KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newKey() {
  for (;;) {
    let k = '';
    for (let i = 0; i < 6; i++) k += KEY_CHARS[crypto.randomInt(KEY_CHARS.length)];
    if (!q('SELECT 1 FROM tvs WHERE key=?').get(k)) return k;
  }
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// First run: create the stores and TVs.
if (!q('SELECT COUNT(*) AS n FROM stores').get().n) {
  const seed = [['Tamarac', 5], ['Key Biscayne', 5], ['Doral', 6]];
  tx(() => seed.forEach(([name, count], i) => {
    const sid = q('INSERT INTO stores(name, position) VALUES(?,?)').run(name, i).lastInsertRowid;
    for (let n = 1; n <= count; n++) q('INSERT INTO tvs(store_id,name,position,key) VALUES(?,?,?,?)').run(sid, `TV ${n}`, n, newKey());
  }));
}
// One-time: swap the long links from the first version for short ones (no sticks were set up yet).
for (const t of q('SELECT id FROM tvs WHERE length(key) > 6').all()) q('UPDATE tvs SET key=? WHERE id=?').run(newKey(), t.id);
if (!getSetting('timezone')) setSetting('timezone', 'America/New_York');
if (!getSetting('session_secret')) setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
const SESSION_SECRET = getSetting('session_secret');

// ---------------------------------------------------------------- auth
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeSession() {
  // Includes a password fingerprint so changing the password logs out every other session.
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const body = `${exp}.${sign(getSetting('admin_password') || '').slice(0, 10)}`;
  return `${body}.${sign(body)}`;
}
function validSession(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  const body = token.slice(0, i), mac = token.slice(i + 1);
  const expected = sign(body);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const [exp, fp] = body.split('.');
  return Number(exp) > Date.now() && fp === sign(getSetting('admin_password') || '').slice(0, 10);
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(req, res, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
const requireAdmin = (req, res, next) => validSession(cookies(req).sid) ? next() : res.status(401).json({ error: 'Not logged in' });

const loginFailures = new Map(); // ip -> [timestamps]
function tooManyFailures(ip) {
  const recent = (loginFailures.get(ip) || []).filter((t) => t > Date.now() - 15 * 60 * 1000);
  loginFailures.set(ip, recent);
  return recent.length >= 10;
}

// ---------------------------------------------------------------- time helpers
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function localNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getSetting('timezone'), weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: DAY_NAMES.indexOf(get('weekday')), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const validTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
// Is "now" inside [start, end)? Windows that cross midnight (e.g. 22:00–02:00) belong to the start day.
function inWindow(now, days, start, end) {
  const s = toMin(start), e = toMin(end);
  if (s === e) return false;
  if (s < e) return days.includes(now.day) && now.minutes >= s && now.minutes < e;
  return (days.includes(now.day) && now.minutes >= s) || (days.includes((now.day + 6) % 7) && now.minutes < e);
}

function effectiveMode(tv, store, now = localNow()) {
  if (store.screen_on && store.screen_off && !inWindow(now, [0, 1, 2, 3, 4, 5, 6], store.screen_on, store.screen_off)) return 'off';
  if (tv.live_capable && tv.live_app) {
    if (tv.mode === 'live') return 'live';
    if (tv.mode === 'auto') {
      const sched = q('SELECT * FROM live_schedules WHERE tv_id=?').all(tv.id);
      if (sched.some((s) => inWindow(now, s.days.split(',').map(Number), s.start, s.end))) return 'live';
    }
  }
  return 'signage';
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

const pub = path.join(__dirname, 'public');
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/tv/:key', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'player.html')); });
app.get('/sw.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'sw.js')); });
app.use('/static', express.static(pub, { maxAge: 0 }));
// Media filenames are random and never reused, so they can be cached forever.
app.use('/media', express.static(MEDIA_DIR, { maxAge: '365d', immutable: true, index: false }));

// ---- auth endpoints
app.get('/api/me', (req, res) => res.json({
  setupNeeded: !getSetting('admin_password'),
  loggedIn: validSession(cookies(req).sid),
}));
app.post('/api/setup', (req, res) => {
  if (getSetting('admin_password')) return res.status(400).json({ error: 'Already set up' });
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  setSetting('admin_password', hashPassword(pw));
  setSessionCookie(req, res, makeSession(), 30 * 24 * 3600);
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!checkPassword(String(req.body.password || ''), getSetting('admin_password'))) {
    loginFailures.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Wrong password' });
  }
  setSessionCookie(req, res, makeSession(), 30 * 24 * 3600);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { setSessionCookie(req, res, '', 0); res.json({ ok: true }); });
app.post('/api/password', requireAdmin, (req, res) => {
  if (!checkPassword(String(req.body.current || ''), getSetting('admin_password'))) return res.status(400).json({ error: 'Current password is wrong' });
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  setSetting('admin_password', hashPassword(pw));
  setSessionCookie(req, res, makeSession(), 30 * 24 * 3600);
  res.json({ ok: true });
});

// ---- full state for the control panel
function mediaUrl(m) { return `/media/${m.filename}`; }
app.get('/api/state', requireAdmin, (req, res) => {
  const now = localNow();
  const stores = q('SELECT * FROM stores ORDER BY position, id').all().map((s) => ({
    ...s,
    tvs: q('SELECT * FROM tvs WHERE store_id=? ORDER BY position, id').all(s.id).map((t) => ({
      id: t.id, name: t.name, key: t.key, playlist_id: t.playlist_id,
      live_capable: !!t.live_capable, live_app: t.live_app, mode: t.mode,
      last_seen: t.last_seen, online: !!t.last_seen && Date.now() - t.last_seen < ONLINE_MS,
      now_playing: t.now_playing, player_info: t.player_info ? JSON.parse(t.player_info) : null,
      effective_mode: effectiveMode(t, s, now),
      schedule: q('SELECT id, days, start, "end" FROM live_schedules WHERE tv_id=?').all(t.id)
        .map((x) => ({ days: x.days.split(',').map(Number), start: x.start, end: x.end })),
    })),
  }));
  const media = q('SELECT * FROM media ORDER BY created DESC, id DESC').all().map((m) => ({ ...m, url: mediaUrl(m) }));
  const playlists = q('SELECT * FROM playlists ORDER BY name COLLATE NOCASE').all().map((p) => ({
    ...p,
    items: q('SELECT media_id, duration, muted FROM playlist_items WHERE playlist_id=? ORDER BY position').all(p.id)
      .map((i) => ({ ...i, muted: !!i.muted })),
  }));
  const folders = q('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all();
  res.json({ stores, media, folders, playlists, timezone: getSetting('timezone'), serverTime: Date.now() });
});

// ---- media
const ALLOWED = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}.${ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!ALLOWED[file.mimetype]),
});
const folderOrNull = (v) => (v && q('SELECT 1 FROM folders WHERE id=?').get(Number(v)) ? Number(v) : null);
app.post('/api/media', requireAdmin, upload.array('files', 50), (req, res) => {
  const folder = folderOrNull(req.query.folder);
  const added = (req.files || []).map((f) => {
    const type = f.mimetype.startsWith('video/') ? 'video' : 'image';
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    q('INSERT INTO media(filename, original_name, type, mime, size, created, folder_id) VALUES(?,?,?,?,?,?,?)')
      .run(f.filename, name, type, f.mimetype, f.size, Date.now(), folder);
    return name;
  });
  if (!added.length) return res.status(400).json({ error: 'No supported files. Use JPG, PNG, WEBP, GIF, MP4, WEBM or MOV.' });
  res.json({ ok: true, added });
});
app.patch('/api/media/:id', requireAdmin, (req, res) => {
  const m = q('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  let name = m.original_name, folder = m.folder_id;
  if (req.body.name !== undefined) {
    name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
  }
  if (req.body.folder_id !== undefined) {
    folder = folderOrNull(req.body.folder_id);
    if (req.body.folder_id && !folder) return res.status(400).json({ error: 'Unknown folder' });
  }
  q('UPDATE media SET original_name=?, folder_id=? WHERE id=?').run(name, folder, m.id);
  res.json({ ok: true });
});

// ---- media folders (deleting a folder keeps its files: they become "No folder")
app.post('/api/folders', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name required' });
  res.json({ id: Number(q('INSERT INTO folders(name) VALUES(?)').run(name).lastInsertRowid) });
});
app.patch('/api/folders/:id', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name required' });
  q('UPDATE folders SET name=? WHERE id=?').run(name, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/folders/:id', requireAdmin, (req, res) => {
  q('DELETE FROM folders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/media/:id', requireAdmin, (req, res) => {
  const m = q('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  q('DELETE FROM media WHERE id=?').run(m.id); // also removes it from playlists (cascade)
  fs.rm(path.join(MEDIA_DIR, m.filename), { force: true }, () => {});
  res.json({ ok: true });
});

// ---- playlists
app.post('/api/playlists', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim() || 'New playlist';
  res.json({ id: Number(q('INSERT INTO playlists(name) VALUES(?)').run(name).lastInsertRowid) });
});
app.put('/api/playlists/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!q('SELECT 1 FROM playlists WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name || '').trim() || 'Untitled playlist';
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  tx(() => {
    q('UPDATE playlists SET name=? WHERE id=?').run(name, id);
    q('DELETE FROM playlist_items WHERE playlist_id=?').run(id);
    items.forEach((it, i) => {
      if (!q('SELECT 1 FROM media WHERE id=?').get(Number(it.media_id))) return;
      const dur = Math.min(3600, Math.max(1, Math.round(Number(it.duration) || 10)));
      q('INSERT INTO playlist_items(playlist_id, media_id, position, duration, muted) VALUES(?,?,?,?,?)')
        .run(id, Number(it.media_id), i, dur, it.muted === false ? 0 : 1);
    });
  });
  res.json({ ok: true });
});
app.delete('/api/playlists/:id', requireAdmin, (req, res) => {
  q('DELETE FROM playlists WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- assigning playlists
app.post('/api/assign', requireAdmin, (req, res) => {
  const pid = req.body.playlist_id ? Number(req.body.playlist_id) : null;
  if (pid && !q('SELECT 1 FROM playlists WHERE id=?').get(pid)) return res.status(400).json({ error: 'Unknown playlist' });
  const { scope, id } = req.body;
  if (scope === 'tv') q('UPDATE tvs SET playlist_id=? WHERE id=?').run(pid, id);
  else if (scope === 'store') q('UPDATE tvs SET playlist_id=? WHERE store_id=?').run(pid, id);
  else if (scope === 'all') q('UPDATE tvs SET playlist_id=?').run(pid);
  else return res.status(400).json({ error: 'Bad scope' });
  res.json({ ok: true });
});

// ---- stores & TVs
app.post('/api/stores', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const pos = q('SELECT COALESCE(MAX(position),0)+1 AS p FROM stores').get().p;
  res.json({ id: Number(q('INSERT INTO stores(name, position) VALUES(?,?)').run(name, pos).lastInsertRowid) });
});
app.put('/api/stores/:id', requireAdmin, (req, res) => {
  const s = q('SELECT * FROM stores WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name ?? s.name).trim() || s.name;
  const on = req.body.screen_on || null, off = req.body.screen_off || null;
  if ((on && !validTime(on)) || (off && !validTime(off)) || (!!on !== !!off)) {
    return res.status(400).json({ error: 'Set both an on time and an off time, or leave both empty' });
  }
  q('UPDATE stores SET name=?, screen_on=?, screen_off=? WHERE id=?').run(name, on, off, s.id);
  res.json({ ok: true });
});
app.delete('/api/stores/:id', requireAdmin, (req, res) => {
  q('DELETE FROM stores WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/stores/:id/tvs', requireAdmin, (req, res) => {
  const s = q('SELECT * FROM stores WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const pos = q('SELECT COALESCE(MAX(position),0)+1 AS p FROM tvs WHERE store_id=?').get(s.id).p;
  const name = String(req.body.name || '').trim() || `TV ${pos}`;
  res.json({ id: Number(q('INSERT INTO tvs(store_id,name,position,key) VALUES(?,?,?,?)').run(s.id, name, pos, newKey()).lastInsertRowid) });
});
app.put('/api/tvs/:id', requireAdmin, (req, res) => {
  const t = q('SELECT * FROM tvs WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  const mode = ['signage', 'live', 'auto'].includes(b.mode) ? b.mode : t.mode;
  const liveApp = b.live_app !== undefined ? String(b.live_app).trim() : t.live_app;
  if (liveApp && !/^[A-Za-z0-9_.]+$/.test(liveApp)) return res.status(400).json({ error: 'App package name looks wrong (example: com.google.android.youtube.tvunplugged)' });
  tx(() => {
    q('UPDATE tvs SET name=?, live_capable=?, live_app=?, mode=? WHERE id=?').run(
      String(b.name ?? t.name).trim() || t.name,
      b.live_capable !== undefined ? (b.live_capable ? 1 : 0) : t.live_capable,
      liveApp, mode, t.id);
    if (Array.isArray(b.schedule)) {
      q('DELETE FROM live_schedules WHERE tv_id=?').run(t.id);
      for (const s of b.schedule) {
        const days = (s.days || []).map(Number).filter((d) => d >= 0 && d <= 6);
        if (!days.length || !validTime(s.start) || !validTime(s.end)) continue;
        q('INSERT INTO live_schedules(tv_id, days, start, "end") VALUES(?,?,?,?)').run(t.id, days.join(','), s.start, s.end);
      }
    }
  });
  res.json({ ok: true });
});
app.post('/api/tvs/:id/rekey', requireAdmin, (req, res) => {
  q('UPDATE tvs SET key=?, last_seen=NULL WHERE id=?').run(newKey(), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/tvs/:id', requireAdmin, (req, res) => {
  q('DELETE FROM tvs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// ---- software update ("Update now" button; the installer sets up the helper that does the work)
const UPDATE_FLAG = path.join(DATA_DIR, 'update-requested');
const UPDATE_LOG = path.join(DATA_DIR, 'update.log');
function installedVersion() {
  try {
    const [commit, date, repo] = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim().split(' ');
    return commit && repo ? { commit, date, repo } : null;
  } catch { return null; }
}
app.get('/api/update', requireAdmin, async (req, res) => {
  const installed = installedVersion();
  let latest = null;
  if (installed && req.query.check) { // only on request: GitHub allows 60 unauthenticated checks per hour
    try {
      const r = await fetch(`https://api.github.com/repos/${installed.repo}/commits/main`, {
        headers: { 'User-Agent': 'nahuentv', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000),
      });
      if (r.ok) { const j = await r.json(); latest = { commit: j.sha, date: j.commit.committer.date, message: j.commit.message.split('\n')[0] }; }
    } catch { /* offline or rate-limited: show "could not check" */ }
  }
  let lines = [];
  try { lines = fs.readFileSync(UPDATE_LOG, 'utf8').trim().split('\n'); } catch { /* never updated */ }
  const last = lines[lines.length - 1] || '';
  const state = fs.existsSync(UPDATE_FLAG) ? 'requested' : !lines.length ? 'never'
    : last.startsWith('DONE') ? 'done' : last.startsWith('FAILED') ? 'failed' : 'running';
  res.json({
    supported: !!installed, installed, latest, state,
    startedAt: (lines[0] || '').startsWith('STARTED ') ? lines[0].slice(8) : null,
    logTail: lines.slice(-20).join('\n'), serverTime: Date.now(),
  });
});
app.post('/api/update', requireAdmin, (req, res) => {
  if (!installedVersion()) return res.status(400).json({ error: 'The Update button is not set up on this server yet. Run the update command in the Droplet Console once.' });
  fs.writeFileSync(UPDATE_FLAG, String(Date.now()));
  res.json({ ok: true, serverTime: Date.now() });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const tz = String(req.body.timezone || '');
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return res.status(400).json({ error: 'Unknown time zone' }); }
  setSetting('timezone', tz);
  res.json({ ok: true });
});

// ---- player endpoints (authenticated by the TV's secret link)
function tvByKey(key) { return q('SELECT * FROM tvs WHERE key=?').get(key); }
app.get('/api/player/:key/config', (req, res) => {
  const tv = tvByKey(req.params.key);
  if (!tv) return res.status(404).json({ error: 'Unknown TV link. Copy the link again from the control panel.' });
  const store = q('SELECT * FROM stores WHERE id=?').get(tv.store_id);
  const items = tv.playlist_id ? q(`
    SELECT m.filename, m.original_name, m.type, pi.duration, pi.muted
    FROM playlist_items pi JOIN media m ON m.id = pi.media_id
    WHERE pi.playlist_id=? ORDER BY pi.position`).all(tv.playlist_id).map((i) => ({
      url: `/media/${i.filename}`, name: i.original_name, type: i.type, duration: i.duration, muted: !!i.muted,
    })) : [];
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    build: APP_BUILD,
    tv: tv.name, store: store.name,
    mode: effectiveMode(tv, store),
    liveApp: tv.live_app || '',
    items,
  });
});
app.post('/api/player/:key/heartbeat', (req, res) => {
  const tv = tvByKey(req.params.key);
  if (!tv) return res.status(404).json({ error: 'Unknown TV' });
  const b = req.body || {};
  const info = {
    mode: String(b.mode || '').slice(0, 20), kiosk: !!b.kiosk, visible: !!b.visible,
    screen: String(b.screen || '').slice(0, 20), ua: String(req.headers['user-agent'] || '').slice(0, 200),
  };
  q('UPDATE tvs SET last_seen=?, now_playing=?, player_info=? WHERE id=?')
    .run(Date.now(), String(b.nowPlaying || '').slice(0, 200), JSON.stringify(info), tv.id);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_UPLOAD_MB} MB)` : err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`NahuenTV running on http://localhost:${PORT}  (data: ${DATA_DIR})`));
