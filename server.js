// Good Luck Cafe ordering server. No dependencies: Node 22.13+ (built-in SQLite).
// Runs on the cafe's own computer. One server, one database, two doors:
//   customer door  PORT (8080)        order page + ordering API. The ONLY door the internet tunnel points at.
//   staff door     STAFF_PORT (8081)  receptionist/kitchen screen + QR cards. Only this computer can open it.
//
//   npm start                         start the server
//   npm run set-password -- <new>     set the staff password
//
// Environment (all optional):
//   PORT            8080                customer door
//   STAFF_PORT      8081                staff door (always this computer only)
//   PUBLIC_HOST     127.0.0.1           customer door listens here; the tunnel connects to it locally.
//                                       Use 0.0.0.0 only for testing with phones on the same network.
//   TABLE_GPS       on                  table phones must share a location within 150 m of the cafe ("off" to disable)
//   PUBLIC_URL      ""                  the customers' address, e.g. https://order.goodluckcafe.in (used on QR cards)
//   Online orders (delivery / pickup, pay on delivery): within DELIVERY_KM of the cafe, fee by distance (see DELIVERY below).
//   TABLES          12                  number of tables
//   ORDER_HOURS     "06:00-23:30"       India time, or "always"
//   SESSION_HOURS   4                   a table left switched on turns itself off after this long
//   JOIN_MINUTES    10                  phones can join a table only this long after it's switched on
//   STAFF_PASSWORD  ""                  overrides the saved staff password
//   DB              data/orders.db
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const STAFF_PORT = Number(process.env.STAFF_PORT) || 8081;
const PUBLIC_HOST = process.env.PUBLIC_HOST || '127.0.0.1';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const TABLES = Number(process.env.TABLES) || 12;
const ORDER_HOURS = process.env.ORDER_HOURS || '06:00-23:30';
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 4;
const JOIN_MINUTES = Number(process.env.JOIN_MINUTES) || 10;
// Online orders. The cafe's spot is the pin on its Google Maps listing.
const DELIVERY = {
  cafe: { lat: 18.6195977, lng: 73.8746089 },
  maxKm: 10,
  fees: [[3, 0], [6, 20], [10, 40]], // up to 3 km free, up to 6 km ₹20, up to 10 km ₹40
  maxAccuracyM: 1500,                 // phone location must be at least this precise
};
// Table ordering: a phone joins a table only if its location says it's at the cafe.
// TABLE_GPS=off turns the check off (e.g. for a demo away from the cafe).
const ONSITE = {
  on: process.env.TABLE_GPS !== 'off',
  radiusM: 150,        // counts as "at the cafe" within this distance of the cafe's map pin
  maxAccuracyM: 500,   // indoors GPS is rough; anything vaguer than this is asked to try again
};
// The customer door only sees the tunnel (it listens on this computer only), so it can trust the
// visitor address and https flag the tunnel adds. With PUBLIC_HOST=0.0.0.0 (testing) it can't.
const TUNNEL_ONLY = PUBLIC_HOST === '127.0.0.1' || PUBLIC_HOST === 'localhost' || PUBLIC_HOST === '::1';
const DB_FILE = process.env.DB || path.join(ROOT, 'data', 'orders.db');
const STAFF_FILE = path.join(path.dirname(DB_FILE), 'staff.json');
const STAFF_SESSION_HOURS = 12;
const PRIVACY_DAYS = Number(process.env.PRIVACY_DAYS) || 30; // customer phone / address / location are erased after this
const LOG_DAYS = 90;                                           // staff activity log is kept this long

// ======================================================================
// Staff password: scrypt hash on disk, never the password itself.
// ======================================================================
// Orders hold customers' phone numbers and addresses: only this computer user may read the data folder.
process.umask(0o077);
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(DB_FILE), 0o700);
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
if (process.argv[2] === '--set-password') {
  const pw = process.argv[3] || '';
  if (pw.length < 8) { console.error('Use at least 8 characters: npm run set-password -- "your new password"'); process.exit(1); }
  fs.writeFileSync(STAFF_FILE, JSON.stringify(hashPassword(pw)), { mode: 0o600 });
  console.log('Staff password saved. Staff who are logged in stay logged in until they log out.');
  process.exit(0);
}
let staffSecret;
if (process.env.STAFF_PASSWORD) staffSecret = hashPassword(process.env.STAFF_PASSWORD);
else if (fs.existsSync(STAFF_FILE)) staffSecret = JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8'));
else {
  const pw = crypto.randomBytes(9).toString('base64url');
  staffSecret = hashPassword(pw);
  fs.writeFileSync(STAFF_FILE, JSON.stringify(staffSecret), { mode: 0o600 });
  console.log(`\n  First start: staff password is  ${pw}\n  Write it down. Change it with: npm run set-password -- "new password"\n`);
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length > 200) return false;
  const a = Buffer.from(hashPassword(pw, staffSecret.salt).hash, 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(staffSecret.hash, 'hex'));
}

// ======================================================================
// Menu: the server's prices are the only prices that count.
// ======================================================================
const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'menu.json'), 'utf8'));
const items = new Map();
for (const c of menu.categories) for (const i of c.items) items.set(i.id, { ...i, category: c.name });

// ======================================================================
// Database
// ======================================================================
const db = new DatabaseSync(DB_FILE);
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm', STAFF_FILE]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, table_no INTEGER NOT NULL, items TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
  CREATE TABLE IF NOT EXISTS table_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_no INTEGER NOT NULL, pin TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL, expires_at TEXT NOT NULL, closed_at TEXT, join_until TEXT);
  CREATE INDEX IF NOT EXISTS sessions_table ON table_sessions(table_no, closed_at);
  CREATE TABLE IF NOT EXISTS staff_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS staff_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
  -- Dish ratings: one per dish per served order, given by whoever holds that order's token.
  CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, item_id TEXT NOT NULL,
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5), created_at TEXT NOT NULL, UNIQUE (order_id, item_id));
`);
// Upgrades for databases made by earlier versions.
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('orders').includes('session_id')) db.exec('ALTER TABLE orders ADD COLUMN session_id INTEGER');
if (!cols('orders').includes('seat_id')) db.exec('ALTER TABLE orders ADD COLUMN seat_id INTEGER');
for (const [c, def] of [['kind', "TEXT NOT NULL DEFAULT 'table'"], ['phone', "TEXT NOT NULL DEFAULT ''"], ['address', "TEXT NOT NULL DEFAULT ''"],
  ['lat', 'REAL'], ['lng', 'REAL'], ['distance_m', 'INTEGER'], ['fee', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!cols('orders').includes(c)) db.exec(`ALTER TABLE orders ADD COLUMN ${c} ${def}`);
}
if (!cols('table_sessions').includes('join_until')) db.exec('ALTER TABLE table_sessions ADD COLUMN join_until TEXT');
if (cols('seats').length && !cols('seats').includes('approved')) db.exec('DROP TABLE seats'); // old PIN-era seats: temporary data
db.exec(`CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, session_id INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
if (!cols('seats').includes('distance_m')) db.exec('ALTER TABLE seats ADD COLUMN distance_m INTEGER'); // how far from the cafe the phone was when it joined
const q = {
  insertOrder: db.prepare(`INSERT INTO orders (token, table_no, items, note, name, total, status, created_at, updated_at, session_id, seat_id, distance_m)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  order: db.prepare('SELECT * FROM orders WHERE id = ?'),
  active: db.prepare(`SELECT * FROM orders WHERE status IN ('pending','new','preparing','ready') ORDER BY id`),
  servedSince: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amount FROM orders WHERE status = 'served' AND created_at >= ?`),
  setStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
  pendingOfSeat: db.prepare(`SELECT * FROM orders WHERE seat_id = ? AND status = 'pending'`),
  insertOnline: db.prepare(`INSERT INTO orders (token, table_no, kind, items, note, name, phone, address, lat, lng, distance_m, fee, total, status, created_at, updated_at)
                            VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`),
  pendingOfPhone: db.prepare(`SELECT COUNT(*) n FROM orders WHERE phone = ? AND status = 'pending'`),
  bill: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amount FROM orders WHERE session_id = ? AND status NOT IN ('cancelled','pending')`),
  openSession: db.prepare(`SELECT * FROM table_sessions WHERE table_no = ? AND closed_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1`),
  allOpen: db.prepare(`SELECT * FROM table_sessions WHERE closed_at IS NULL AND expires_at > ?`),
  newSession: db.prepare("INSERT INTO table_sessions (table_no, pin, opened_at, expires_at, join_until) VALUES (?, '', ?, ?, ?)"),
  session: db.prepare('SELECT * FROM table_sessions WHERE id = ?'),
  closeSession: db.prepare('UPDATE table_sessions SET closed_at = ? WHERE id = ?'),
  setJoinUntil: db.prepare('UPDATE table_sessions SET join_until = ? WHERE id = ?'),
  addSeat: db.prepare('INSERT INTO seats (token_hash, session_id, created_at, distance_m) VALUES (?, ?, ?, ?)'),
  seat: db.prepare('SELECT * FROM seats WHERE token_hash = ?'),
  seatById: db.prepare('SELECT * FROM seats WHERE id = ?'),
  approveSeat: db.prepare('UPDATE seats SET approved = 1 WHERE id = ?'),
  dropSeat: db.prepare('DELETE FROM seats WHERE id = ?'),
  dropSeats: db.prepare('DELETE FROM seats WHERE session_id = ?'),
  seatCount: db.prepare('SELECT COUNT(*) n FROM seats WHERE session_id = ?'),
  addStaff: db.prepare('INSERT INTO staff_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)'),
  staff: db.prepare('SELECT * FROM staff_sessions WHERE token_hash = ? AND expires_at > ?'),
  dropStaff: db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?'),
  cleanStaff: db.prepare('DELETE FROM staff_sessions WHERE expires_at <= ?'),
  log: db.prepare('INSERT INTO staff_log (at, action, detail) VALUES (?, ?, ?)'),
  logRecent: db.prepare('SELECT at, action, detail FROM staff_log ORDER BY id DESC LIMIT ?'),
  logPrune: db.prepare('DELETE FROM staff_log WHERE at < ?'),
  ratings: db.prepare('SELECT item_id, AVG(stars) avg, COUNT(*) n FROM reviews GROUP BY item_id'),
  reviewedOrder: db.prepare('SELECT COUNT(*) n FROM reviews WHERE order_id = ?'),
  addReview: db.prepare('INSERT INTO reviews (order_id, item_id, stars, created_at) VALUES (?, ?, ?, ?)'),
  // 3. privacy: after PRIVACY_DAYS keep only what the accounts need (items, totals, time), drop who and where
  erasePersonal: db.prepare(`UPDATE orders SET name = '', phone = '', address = '', note = '', lat = NULL, lng = NULL
                             WHERE created_at < ? AND (name != '' OR phone != '' OR address != '' OR note != '' OR lat IS NOT NULL)`),
  dropOldSeats: db.prepare('DELETE FROM seats WHERE session_id IN (SELECT id FROM table_sessions WHERE closed_at IS NOT NULL OR expires_at <= ?)'),
};
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const orderOut = (r) => r && { id: r.id, kind: r.kind || 'table', table: r.table_no, distanceM: r.distance_m, items: JSON.parse(r.items), note: r.note, name: r.name,
  phone: r.phone || '', address: r.address || '', lat: r.lat, lng: r.lng, distanceKm: r.distance_m == null ? null : Math.round(r.distance_m / 100) / 10,
  fee: r.fee || 0, total: r.total, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };

// Allowed moves for staff. Anything else is refused.
// 'pending' (a new phone's first order) only moves through approve / reject below.
const NEXT = { pending: [], new: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served'], served: [], cancelled: [] };

// ======================================================================
// Table sessions. The receptionist switches each table on and off.
// Table lock: phones can join only in the first JOIN_MINUTES after switching on (or when the receptionist
// reopens joining). Approval: a phone's first order waits for the receptionist to approve it.
// ======================================================================
function activeSession(table) { return q.openSession.get(table, now()); }
const joinOpen = (s) => !!(s && s.join_until && s.join_until > now());
function tableView(table, s = activeSession(table)) {
  if (!s) return { table, open: false };
  const b = q.bill.get(s.id);
  return { table, open: true, openedAt: s.opened_at, expiresAt: s.expires_at, joinUntil: joinOpen(s) ? s.join_until : null,
    phones: q.seatCount.get(s.id).n, orders: b.n, bill: b.amount };
}
// The phone's seat for this request, if its table is still switched on.
function seatFor(req) {
  const tok = cookies(req).glc_seat;
  if (!tok) return null;
  const seat = q.seat.get(sha(tok));
  if (!seat) return null;
  const s = q.session.get(seat.session_id);
  if (!s || s.closed_at || s.expires_at <= now()) return null;
  return { seat, session: s };
}
const minutesFromNow = (m) => new Date(Date.now() + m * 60e3).toISOString();

// ======================================================================
// Rate limits (in memory; reset on restart, which is fine for these)
// ======================================================================
const hits = new Map();
const HITS_MAX = 50000; // a flood from many addresses can't grow memory without limit
function remember(key, list) {
  hits.delete(key); hits.set(key, list); // newest last
  if (hits.size > HITS_MAX) for (const k of hits.keys()) { hits.delete(k); if (hits.size <= HITS_MAX * 0.9) break; }
}
function limited(key, max, windowMs) {
  const t = Date.now();
  const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) { remember(key, list); return true; }
  list.push(t); remember(key, list);
  return false;
}
function countFail(key, windowMs) { // record a hit without blocking
  const t = Date.now();
  remember(key, (hits.get(key) || []).filter((x) => t - x < windowMs).concat(t));
}
function failures(key, windowMs) { const t = Date.now(); return (hits.get(key) || []).filter((x) => t - x < windowMs).length; }
function housekeeping() {
  const t = Date.now(), daysAgo = (d) => new Date(t - d * 864e5).toISOString();
  for (const [k, v] of hits) if (!v.some((x) => t - x < 3600e3)) hits.delete(k);
  q.cleanStaff.run(now());
  q.dropOldSeats.run(now());
  q.erasePersonal.run(daysAgo(PRIVACY_DAYS));
  q.logPrune.run(daysAgo(LOG_DAYS));
}
setInterval(housekeeping, 600e3).unref();

// ======================================================================
// Client address (rate limits only; not trusted for anything else)
// ======================================================================
function clientIp(req) {
  const viaTunnel = req.side === 'public' && TUNNEL_ONLY;
  let ip = viaTunnel ? String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  if (!ip) ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// ======================================================================
// HTTP helpers
// ======================================================================
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) { return req.socket.encrypted || (req.side === 'public' && TUNNEL_ONLY && req.headers['x-forwarded-proto'] === 'https'); }
function cookie(req, name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const fail = (res, status, error, message, extra) => send(res, status, { error, message, ...extra });
function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return Promise.reject(Object.assign(new Error('Send JSON.'), { status: 415 }));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function indiaNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
function isOpen() {
  if (ORDER_HOURS === 'always') return true;
  const [a, b] = ORDER_HOURS.split('-').map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  const m = indiaNow().minutes;
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
// Prices come from menu.json only. Returns { lines, total } or { error, message }.
function priceItems(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'empty', message: 'Your order is empty.' };
  if (list.length > 40) return { error: 'too-many', message: 'That order is too large to place online. Please call the cafe.' };
  const merged = new Map();
  for (const it of list) {
    const item = items.get(it && it.id);
    const qty = Number(it && it.qty);
    if (!item || item.price == null) return { error: 'item', message: 'One of the items is no longer on the menu. Please refresh.' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) return { error: 'qty', message: 'Quantities must be between 1 and 20.' };
    merged.set(item.id, Math.min(20, (merged.get(item.id) || 0) + qty));
  }
  const lines = [...merged].map(([id, qty]) => { const i = items.get(id); return { id, name: i.name, qty, price: i.price, veg: i.veg }; });
  return { lines, total: lines.reduce((sum, l) => sum + l.price * l.qty, 0) };
}
// Straight-line distance in metres (haversine).
function distanceM(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const deliveryFee = (km) => { for (const [upTo, fee] of DELIVERY.fees) if (km <= upTo) return fee; return null; };
// Indian mobile number -> 10 digits, or '' if it isn't one.
function mobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

const startOfIndiaDay = () => new Date(`${indiaNow().date}T00:00:00+05:30`).toISOString();

// ======================================================================
// Live updates to logged-in kitchen screens
// ======================================================================
const listeners = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

// Staff activity log: what was done and when (for "who rejected my order?" questions).
const staffLog = (action, detail = '') => q.log.run(now(), action, String(detail).slice(0, 200));
const orderLabel = (r) => `#${r.id} ` + (r.kind === 'delivery' ? `delivery for ${r.name}` : r.kind === 'pickup' ? `pickup for ${r.name}` : `table ${r.table_no}`);

function isStaff(req) {
  const tok = cookies(req).glc_staff;
  return !!(tok && q.staff.get(sha(tok), now()));
}

// ======================================================================
// API
// ======================================================================
async function api(req, res, url) {
  const p = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const ip = clientIp(req);
  // Staff API doesn't exist on the customer door.
  if (req.side === 'public' && (p[1] === 'kitchen' || p[1] === 'staff')) return fail(res, 404, 'not-found', 'Not found.');

  // Requests that change something must come from our own pages (blocks other sites posting on a visitor's behalf).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    let host = null;
    try { host = origin ? new URL(origin).host : null; } catch { /* "null" or junk origin */ }
    if (origin && host !== req.headers.host) return fail(res, 403, 'origin', 'Request blocked.');
  }

  // ---------------- public ----------------
  if (req.method === 'GET' && url.pathname === '/api/menu') {
    // Real averages only: a dish nobody has rated yet is 0.0 from 0 ratings.
    const ratings = {};
    for (const r of q.ratings.all()) ratings[r.item_id] = { avg: Math.round(r.avg * 10) / 10, count: r.n };
    return send(res, 200, { ...menu, tables: TABLES, open: isOpen(), hours: ORDER_HOURS, publicUrl: PUBLIC_URL, ratings,
      delivery: { cafe: DELIVERY.cafe, maxKm: DELIVERY.maxKm, fees: DELIVERY.fees, maxAccuracyM: DELIVERY.maxAccuracyM },
      onsite: { on: ONSITE.on, radiusM: ONSITE.radiusM, maxAccuracyM: ONSITE.maxAccuracyM } });
  }

  // Table status for the customer page.
  if (p[1] === 'tables' && p[2]) {
    const table = Number(p[2]);
    if (!Number.isInteger(table) || table < 1 || table > TABLES) return fail(res, 404, 'table', 'Unknown table number.');
    const s = activeSession(table), mine = seatFor(req);
    const joined = !!(s && mine && mine.session.id === s.id);

    if (req.method === 'GET' && p.length === 3) {
      return send(res, 200, { table, open: !!s, joined, joinOpen: joinOpen(s), approved: joined && !!mine.seat.approved });
    }
    // Join: only while the table is in its joining window.
    if (req.method === 'POST' && p[3] === 'join') {
      if (!s) return fail(res, 409, 'table-closed', 'Ordering isn\'t switched on for this table. Please ask at the counter.');
      if (joined) return send(res, 200, { table, joined: true, approved: !!mine.seat.approved });
      if (limited(`join:${ip}`, 20, 600e3)) return fail(res, 429, 'slow-down', 'Too many tries. Please ask at the counter.');
      if (!joinOpen(s)) return fail(res, 409, 'table-locked', 'This table is already in use. If you\'re sitting here, please ask at the counter.');
      // Location check: the phone must be at the cafe (stops orders from a photo of the QR code taken home).
      let dist = null;
      if (ONSITE.on) {
        const { lat, lng, accuracy } = await readJson(req, 1024);
        const la = Number(lat), lo = Number(lng), acc = Number(accuracy);
        if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
          return fail(res, 400, 'location', 'Please share your location so we can check you\'re at the cafe.');
        }
        if (!Number.isFinite(acc) || acc <= 0 || acc > ONSITE.maxAccuracyM) {
          return fail(res, 400, 'accuracy', 'Your location isn\'t precise enough yet. Turn on GPS / precise location and try again.');
        }
        dist = distanceM(DELIVERY.cafe, { lat: la, lng: lo });
        // Allow for GPS error: the phone counts as here if the cafe is inside its accuracy circle plus the radius.
        if (dist - Math.min(acc, ONSITE.radiusM) > ONSITE.radiusM) {
          const away = dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m';
          return fail(res, 403, 'not-here', `You seem to be ${away} from the cafe. Table ordering only works inside the cafe. To order from elsewhere, use "Order online".`);
        }
      }
      const tok = newToken();
      q.addSeat.run(sha(tok), s.id, now(), dist == null ? null : Math.round(dist));
      broadcast('table', tableView(table));
      const maxAge = Math.max(60, Math.round((new Date(s.expires_at) - Date.now()) / 1000));
      return send(res, 200, { table, joined: true, approved: false }, { 'Set-Cookie': cookie(req, 'glc_seat', tok, maxAge) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    if (!isOpen()) return fail(res, 409, 'closed', 'The kitchen is closed right now. Orders open again at 6:00 am.');
    const body = await readJson(req);
    const table = Number(body.table);
    if (!Number.isInteger(table) || table < 1 || table > TABLES) return fail(res, 400, 'table', 'Unknown table number.');
    const s = activeSession(table), mine = seatFor(req);
    if (!s) return fail(res, 409, 'table-closed', 'Ordering isn\'t switched on for this table. Please ask at the counter.');
    if (!mine || mine.session.id !== s.id) {
      return joinOpen(s) ? fail(res, 401, 'not-joined', 'Please reload the page and try again.')
        : fail(res, 409, 'table-locked', 'This table is already in use. If you\'re sitting here, please ask at the counter.');
    }
    if (!mine.seat.approved && q.pendingOfSeat.all(mine.seat.id).length >= 2) {
      return fail(res, 429, 'wait-approval', 'Your first order is waiting for the counter to confirm it. Please wait a moment.');
    }
    // Flood guard, counting only orders that go through: 5 per phone and 15 per table per 10 min.
    // The address limit is loose because mobile networks put many customers behind one address.
    const keys = [[`ord:${mine.seat.id}`, 5], [`ordt:${s.id}`, 15], [`ordip:${ip}`, 40]];
    if (keys.some(([k, max]) => failures(k, 600e3) >= max)) {
      return fail(res, 429, 'slow-down', 'That\'s a lot of orders in a short time. Please ask at the counter if you need more.');
    }
    const priced = priceItems(body.items);
    if (priced.error) return fail(res, 400, priced.error, priced.message);
    const { lines, total } = priced;
    const status = mine.seat.approved ? 'new' : 'pending';
    const t = now(), token = crypto.randomBytes(12).toString('hex');
    const { lastInsertRowid } = q.insertOrder.run(token, table, JSON.stringify(lines), clean(body.note, 200), clean(body.name, 40), total, status, t, t, s.id, mine.seat.id, mine.seat.distance_m);
    for (const [k] of keys) countFail(k, 600e3); // count this order against the limits
    const order = orderOut(q.order.get(lastInsertRowid));
    broadcast('order', order);
    broadcast('table', tableView(table));
    return send(res, 201, { ...order, token });
  }

  // Online order: delivery (within DELIVERY.maxKm, by the phone's location) or pickup. Pay on delivery / at pickup.
  // Every online order waits for the receptionist to call the customer and confirm it.
  if (req.method === 'POST' && url.pathname === '/api/online-orders') {
    if (!isOpen()) return fail(res, 409, 'closed', 'The kitchen is closed right now. Orders open again at 6:00 am.');
    const body = await readJson(req);
    const kind = body.kind === 'delivery' || body.kind === 'pickup' ? body.kind : null;
    if (!kind) return fail(res, 400, 'kind', 'Choose delivery or pickup.');
    const name = clean(body.name, 40);
    if (name.length < 2) return fail(res, 400, 'name', 'Please enter your name.');
    const phone = mobile(body.phone);
    if (!phone) return fail(res, 400, 'phone', 'Please enter a valid 10-digit mobile number. We\'ll call it to confirm your order.');
    // Fake-order guard: 3 online orders per mobile number and 10 per visitor address per hour; 2 unconfirmed per number.
    // (The address limit is loose: mobile networks put many people behind one address.)
    const keys = [[`onl:${phone}`, 3], [`onlip:${ip}`, 10]];
    if (keys.some(([k, max]) => failures(k, 3600e3) >= max)) return fail(res, 429, 'slow-down', 'Too many orders in a short time. Please call the cafe.');
    if (q.pendingOfPhone.get(phone).n >= 2) return fail(res, 429, 'wait-approval', 'Your earlier order is still waiting to be confirmed. We\'ll call you shortly.');
    const priced = priceItems(body.items);
    if (priced.error) return fail(res, 400, priced.error, priced.message);

    let address = '', lat = null, lng = null, dist = null, fee = 0;
    if (kind === 'delivery') {
      address = clean(body.address, 300);
      if (address.length < 10) return fail(res, 400, 'address', 'Please enter your full address: flat or house, building, street and a landmark.');
      lat = Number(body.lat); lng = Number(body.lng);
      const acc = Number(body.accuracy);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return fail(res, 400, 'location', 'We need your location to check you\'re within delivery range. Tap "Use my location".');
      }
      if (!Number.isFinite(acc) || acc <= 0 || acc > DELIVERY.maxAccuracyM) {
        return fail(res, 400, 'accuracy', 'Your location isn\'t precise enough. Turn on GPS / location services and try again, or choose pickup.');
      }
      dist = distanceM(DELIVERY.cafe, { lat, lng });
      fee = deliveryFee(dist / 1000);
      if (fee == null) return fail(res, 400, 'too-far', `Sorry, you're ${(dist / 1000).toFixed(1)} km away. We deliver within ${DELIVERY.maxKm} km. You can choose pickup instead.`);
    }
    const t = now(), token = crypto.randomBytes(12).toString('hex');
    const { lastInsertRowid } = q.insertOnline.run(token, kind, JSON.stringify(priced.lines), clean(body.note, 200), name, phone, address,
      lat, lng, dist == null ? null : Math.round(dist), fee, priced.total + fee, t, t);
    for (const [k] of keys) countFail(k, 3600e3);
    const order = orderOut(q.order.get(lastInsertRowid));
    broadcast('order', order);
    return send(res, 201, { ...order, token });
  }

  // Customer: track one order, and rate it once it's served. Both need the token given when the order
  // was placed, so nobody can look at or rate someone else's order.
  if (p[1] === 'orders' && p[2] && (p.length === 3 || p[3] === 'review')) {
    const r = q.order.get(Number(p[2]));
    const t = url.searchParams.get('t') || '';
    if (!r || t.length !== r.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(r.token))) return fail(res, 404, 'not-found', 'Order not found.');
    const reviewed = q.reviewedOrder.get(r.id).n > 0;
    if (req.method === 'GET' && p.length === 3) return send(res, 200, { ...orderOut(r), reviewed });

    if (req.method === 'POST' && p[3] === 'review') {
      if (r.status !== 'served') return fail(res, 409, 'not-served', 'You can rate your order once it has been served.');
      if (reviewed) return fail(res, 409, 'reviewed', 'You\'ve already rated this order. Thank you!');
      if (limited(`rev:${ip}`, 20, 3600e3)) return fail(res, 429, 'slow-down', 'Too many ratings in a short time. Please try later.');
      const { ratings } = await readJson(req, 4096);
      const inOrder = new Set(JSON.parse(r.items).map((l) => l.id));
      if (!Array.isArray(ratings) || ratings.length === 0 || ratings.length > inOrder.size) return fail(res, 400, 'ratings', 'Please rate at least one dish.');
      const seen = new Set();
      for (const x of ratings) {
        if (!x || !inOrder.has(x.id) || seen.has(x.id)) return fail(res, 400, 'ratings', 'You can only rate the dishes in this order, once each.');
        if (!Number.isInteger(x.stars) || x.stars < 1 || x.stars > 5) return fail(res, 400, 'ratings', 'Ratings are 1 to 5 stars.');
        seen.add(x.id);
      }
      const t2 = now();
      db.exec('BEGIN');
      try { for (const x of ratings) q.addReview.run(r.id, x.id, x.stars, t2); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 201, { reviewed: true });
    }
  }

  // ---------------- staff login ----------------
  if (p[1] === 'staff') {
    if (req.method === 'POST' && p[2] === 'login') {
      if (failures(`login:${ip}`, 900e3) >= 5) return fail(res, 429, 'locked', 'Too many wrong passwords. Wait 15 minutes and try again.');
      const { password } = await readJson(req, 1024);
      if (!checkPassword(password)) { countFail(`login:${ip}`, 900e3); staffLog('Wrong password'); return fail(res, 401, 'password', 'Wrong password.'); }
      staffLog('Logged in');
      const tok = newToken(), t = Date.now();
      q.addStaff.run(sha(tok), new Date(t).toISOString(), new Date(t + STAFF_SESSION_HOURS * 3600e3).toISOString());
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'glc_staff', tok, STAFF_SESSION_HOURS * 3600) });
    }
    if (req.method === 'POST' && p[2] === 'logout') {
      staffLog('Logged out');
      const tok = cookies(req).glc_staff;
      if (tok) q.dropStaff.run(sha(tok));
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'glc_staff', '', 0) });
    }
    if (req.method === 'GET' && p[2] === 'me') return isStaff(req) ? send(res, 200, { ok: true }) : fail(res, 401, 'login', 'Please log in.');
  }

  // ---------------- staff only ----------------
  if (p[1] === 'kitchen') {
    if (!isStaff(req)) return fail(res, 401, 'login', 'Please log in.');

    if (req.method === 'GET' && p[2] === 'orders') {
      const done = q.servedSince.get(startOfIndiaDay());
      return send(res, 200, { orders: q.active.all().map(orderOut), servedToday: done.n, takingsToday: done.amount, open: isOpen() });
    }
    // Approve / reject a new phone's first order. Approving trusts the phone for the rest of the visit;
    // rejecting cancels its waiting orders and removes the phone from the table.
    if (req.method === 'POST' && p[2] === 'orders' && p[3] && (p[4] === 'approve' || p[4] === 'reject')) {
      const r = q.order.get(Number(p[3]));
      if (!r || r.status !== 'pending') return fail(res, 409, 'status', 'That order isn\'t waiting for approval any more.');
      // (online orders have no seat: only this one order is approved / rejected)
      const seat = r.seat_id && q.seatById.get(r.seat_id);
      const waiting = seat ? q.pendingOfSeat.all(seat.id) : [r];
      const to = p[4] === 'approve' ? 'new' : 'cancelled';
      for (const o of waiting) { q.setStatus.run(to, now(), o.id); staffLog(p[4] === 'approve' ? 'Approved' : 'Rejected', orderLabel(o)); }
      if (seat) p[4] === 'approve' ? q.approveSeat.run(seat.id) : q.dropSeat.run(seat.id);
      for (const o of waiting) broadcast('order', orderOut(q.order.get(o.id)));
      if (r.table_no) broadcast('table', tableView(r.table_no));
      return send(res, 200, orderOut(q.order.get(r.id)));
    }
    if (req.method === 'PATCH' && p[2] === 'orders' && p[3]) {
      const id = Number(p[3]);
      const r = q.order.get(id);
      if (!r) return fail(res, 404, 'not-found', 'Order not found.');
      const { status } = await readJson(req, 1024);
      if (!NEXT[r.status].includes(status)) return fail(res, 409, 'status', `Can't move an order from ${r.status} to ${status}.`);
      q.setStatus.run(status, now(), id);
      staffLog({ preparing: 'Started preparing', ready: 'Marked ready', served: r.kind === 'delivery' ? 'Delivered' : r.kind === 'pickup' ? 'Collected' : 'Served', cancelled: 'Cancelled' }[status] || status, orderLabel(r));
      const order = orderOut(q.order.get(id));
      broadcast('order', order);
      if (status === 'cancelled' && r.table_no) broadcast('table', tableView(r.table_no));
      return send(res, 200, order);
    }
    if (req.method === 'GET' && p[2] === 'log') {
      return send(res, 200, { entries: q.logRecent.all(100), keptDays: LOG_DAYS });
    }
    if (req.method === 'GET' && p[2] === 'tables') {
      const open = new Map(q.allOpen.all(now()).map((s) => [s.table_no, s]));
      const list = [];
      for (let t = 1; t <= TABLES; t++) list.push(tableView(t, open.get(t)));
      return send(res, 200, { tables: list, sessionHours: SESSION_HOURS, joinMinutes: JOIN_MINUTES });
    }
    if (req.method === 'POST' && p[2] === 'tables' && p[3] && p[4]) {
      const table = Number(p[3]);
      if (!Number.isInteger(table) || table < 1 || table > TABLES) return fail(res, 404, 'table', 'Unknown table number.');
      const s = activeSession(table);
      if (p[4] === 'open') {
        if (!s) staffLog('Turned on', `table ${table}`);
        if (!s) { const t = Date.now(); q.newSession.run(table, new Date(t).toISOString(), new Date(t + SESSION_HOURS * 3600e3).toISOString(), minutesFromNow(JOIN_MINUTES)); }
      } else if (p[4] === 'close') {
        if (!s) return fail(res, 409, 'not-open', 'That table is already off.');
        const view = tableView(table, s);
        q.closeSession.run(now(), s.id);
        staffLog('Turned off', `table ${table} · bill ₹${view.bill} for ${view.orders} order${view.orders === 1 ? '' : 's'}`);
        q.dropSeats.run(s.id); // every phone at that table loses access
        for (const o of q.active.all().filter((o) => o.session_id === s.id && o.status === 'pending')) {
          q.setStatus.run('cancelled', now(), o.id); broadcast('order', orderOut(q.order.get(o.id)));
        }
        const closed = { table, open: false, closedBill: view.bill, closedOrders: view.orders };
        broadcast('table', closed);
        return send(res, 200, closed);
      } else if (p[4] === 'allow-join') {
        if (!s) return fail(res, 409, 'not-open', 'Turn the table on first.');
        q.setJoinUntil.run(minutesFromNow(JOIN_MINUTES), s.id);
        staffLog('Let more phones join', `table ${table}`);
      } else return fail(res, 404, 'not-found', 'Not found.');
      const view = tableView(table);
      broadcast('table', view);
      return send(res, 200, view);
    }
    if (req.method === 'GET' && p[2] === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
  }
  return fail(res, 404, 'not-found', 'Not found.');
}

// ======================================================================
// Static files: public file types only; never the database, code or dotfiles.
// ======================================================================
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const PRIVATE = new Set(['server.js', 'package.json', 'package-lock.json']);
// Strict browser rules for the app pages (no inline scripts, no framing).
const APP_CSP = ["default-src 'self'", "script-src 'self' https://cdnjs.cloudflare.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"].join('; ');
const APP_PAGES = new Set(['order.html', 'online.html', 'kitchen.html', 'tables.html']);
const STAFF_ONLY = new Set(['kitchen.html', 'kitchen.js', 'tables.html', 'tables.js']); // never on the customer door

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (req.side === 'staff' && rel === '/') { res.writeHead(302, { Location: '/kitchen.html' }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const name = path.relative(ROOT, file);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || name.startsWith('..') || path.isAbsolute(name) || name.split(path.sep).some((x) => x.startsWith('.')) || name.split(path.sep)[0] === 'data' || PRIVATE.has(name)
      || (req.side === 'public' && STAFF_ONLY.has(name))) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const headers = { 'Content-Type': type, 'Cache-Control': /\.(html|json|js|css)$/.test(file) ? 'no-cache' : 'public, max-age=3600' };
    if (APP_PAGES.has(name)) headers['Content-Security-Policy'] = APP_CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// The staff door answers only a browser on this computer that asked for localhost by name.
// - Anything that came through a tunnel or proxy carries forwarding headers: refused (protects against
//   the tunnel being pointed at the wrong port by mistake).
// - The Host must be localhost / 127.0.0.1: refused otherwise (blocks "DNS rebinding", where a website
//   open in the receptionist's browser tries to talk to this computer under its own name).
const FORWARDED = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];
const STAFF_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'].map((h) => `${h}:${STAFF_PORT}`));
const PUBLIC_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'].map((h) => `${h}:${PORT}`));
if (PUBLIC_URL) { try { PUBLIC_HOSTS.add(new URL(PUBLIC_URL).host); } catch { console.error(`PUBLIC_URL "${PUBLIC_URL}" isn't a valid address.`); process.exit(1); } }
function doorRefuses(side, req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (side === 'staff') {
    if (FORWARDED.some((h) => h in req.headers)) return 'The staff screen only works on the cafe computer.';
    if (!STAFF_HOSTS.has(host)) return 'Open the staff screen as http://localhost:' + STAFF_PORT;
  } else if (PUBLIC_URL && TUNNEL_ONLY && !PUBLIC_HOSTS.has(host)) {
    return 'Unknown address.';
  }
  return null;
}

function handler(side) {
  return async (req, res) => {
    req.side = side;
    const refused = doorRefuses(side, req);
    if (refused) {
      if (side === 'staff') console.warn(`Staff door refused a request: ${refused} (host "${req.headers.host || ''}")`);
      return send(res, 403, refused, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad-request', message: 'Bad request.' }); }
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else send(res, 405, { error: 'method', message: 'Method not allowed.' });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: 'server', message: e.status ? e.message : 'Something went wrong. Please try again.' });
      if (!e.status) console.error(e);
    }
  };
}
const onListenError = (what, port) => (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} (${what}) is already in use. Is the server already running?` : e);
  process.exit(1);
};
// Customer door: listens on this computer only (the tunnel connects to it here).
// Slow-request guard on the customer door: whole request within 15 s, headers within 10 s.
const publicServer = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000, connectionsCheckingInterval: 2000 }, handler('public'));
publicServer.on('error', onListenError('customer door', PORT)).listen(PORT, PUBLIC_HOST, () => {
  console.log(`Good Luck Cafe ordering  (tables 1-${TABLES}, ordering ${ORDER_HOURS}, phones can join for ${JOIN_MINUTES} min, tables switch off after ${SESSION_HOURS} h)`);
  console.log(`  Customer door:  http://${PUBLIC_HOST}:${PORT}/order.html?table=1   ${PUBLIC_URL ? '-> public as ' + PUBLIC_URL : '(set PUBLIC_URL to your tunnel address)'}`);
  if (!TUNNEL_ONLY) console.log(`  WARNING: customer door is open to the network (PUBLIC_HOST=${PUBLIC_HOST}). Use this only for testing.`);
});
// Staff door: hard-wired to this computer. Not configurable on purpose.
http.createServer(handler('staff')).on('error', onListenError('staff door', STAFF_PORT)).listen(STAFF_PORT, '127.0.0.1', () => {
  console.log(`  Staff door:     http://localhost:${STAFF_PORT}   (receptionist + kitchen screen, QR cards: /tables.html; this computer only)`);
  console.log(ONSITE.on ? `  Table GPS check ON: phones must be within ${ONSITE.radiusM} m of the cafe to join a table` : '  Table GPS check OFF (TABLE_GPS=off)');
  console.log(`  Privacy: customer phone numbers, addresses and locations are erased after ${PRIVACY_DAYS} days.`);
});
housekeeping();
