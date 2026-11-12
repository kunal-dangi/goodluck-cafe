// Good Luck Cafe ordering server. No dependencies: Node 22.13+ (built-in SQLite).
//
//   npm start                         start the server
//   npm run set-password -- <new>     set the staff password
//
// Environment (all optional):
//   PORT            8080
//   TABLES          12                  number of tables
//   ORDER_HOURS     "06:00-23:30"       India time, or "always"
//   SESSION_HOURS   4                   a table left switched on turns itself off after this long
//   JOIN_MINUTES    10                  phones can join a table only this long after it's switched on
//   TRUST_PROXY     0                   1 when running behind a reverse proxy / hosting platform (reads X-Forwarded-For)
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
const TABLES = Number(process.env.TABLES) || 12;
const ORDER_HOURS = process.env.ORDER_HOURS || '06:00-23:30';
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 4;
const JOIN_MINUTES = Number(process.env.JOIN_MINUTES) || 10;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DB_FILE = process.env.DB || path.join(ROOT, 'data', 'orders.db');
const STAFF_FILE = path.join(path.dirname(DB_FILE), 'staff.json');
const STAFF_SESSION_HOURS = 12;

// ======================================================================
// Staff password: scrypt hash on disk, never the password itself.
// ======================================================================
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
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
`);
// Upgrades for databases made by earlier versions.
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('orders').includes('session_id')) db.exec('ALTER TABLE orders ADD COLUMN session_id INTEGER');
if (!cols('orders').includes('seat_id')) db.exec('ALTER TABLE orders ADD COLUMN seat_id INTEGER');
if (!cols('table_sessions').includes('join_until')) db.exec('ALTER TABLE table_sessions ADD COLUMN join_until TEXT');
if (cols('seats').length && !cols('seats').includes('approved')) db.exec('DROP TABLE seats'); // old PIN-era seats: temporary data
db.exec(`CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, session_id INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
const q = {
  insertOrder: db.prepare(`INSERT INTO orders (token, table_no, items, note, name, total, status, created_at, updated_at, session_id, seat_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  order: db.prepare('SELECT * FROM orders WHERE id = ?'),
  active: db.prepare(`SELECT * FROM orders WHERE status IN ('pending','new','preparing','ready') ORDER BY id`),
  servedSince: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amount FROM orders WHERE status = 'served' AND created_at >= ?`),
  setStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
  pendingOfSeat: db.prepare(`SELECT * FROM orders WHERE seat_id = ? AND status = 'pending'`),
  bill: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amount FROM orders WHERE session_id = ? AND status NOT IN ('cancelled','pending')`),
  openSession: db.prepare(`SELECT * FROM table_sessions WHERE table_no = ? AND closed_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1`),
  allOpen: db.prepare(`SELECT * FROM table_sessions WHERE closed_at IS NULL AND expires_at > ?`),
  newSession: db.prepare("INSERT INTO table_sessions (table_no, pin, opened_at, expires_at, join_until) VALUES (?, '', ?, ?, ?)"),
  session: db.prepare('SELECT * FROM table_sessions WHERE id = ?'),
  closeSession: db.prepare('UPDATE table_sessions SET closed_at = ? WHERE id = ?'),
  setJoinUntil: db.prepare('UPDATE table_sessions SET join_until = ? WHERE id = ?'),
  addSeat: db.prepare('INSERT INTO seats (token_hash, session_id, created_at) VALUES (?, ?, ?)'),
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
};
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const orderOut = (r) => r && { id: r.id, table: r.table_no, items: JSON.parse(r.items), note: r.note, name: r.name,
  total: r.total, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };

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
function limited(key, max, windowMs) {
  const t = Date.now();
  const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(t); hits.set(key, list);
  return false;
}
function countFail(key, windowMs) { // record a hit without blocking
  const t = Date.now();
  hits.set(key, (hits.get(key) || []).filter((x) => t - x < windowMs).concat(t));
}
function failures(key, windowMs) { const t = Date.now(); return (hits.get(key) || []).filter((x) => t - x < windowMs).length; }
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of hits) if (!v.some((x) => t - x < 3600e3)) hits.delete(k);
  q.cleanStaff.run(now());
}, 600e3).unref();

// ======================================================================
// Client address (rate limits only; not trusted for anything else)
// ======================================================================
function clientIp(req) {
  let ip = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
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
function isHttps(req) { return req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https'); }
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

  // Requests that change something must come from our own pages (blocks other sites posting on a visitor's behalf).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    let host = null;
    try { host = origin ? new URL(origin).host : null; } catch { /* "null" or junk origin */ }
    if (origin && host !== req.headers.host) return fail(res, 403, 'origin', 'Request blocked.');
  }

  // ---------------- public ----------------
  if (req.method === 'GET' && url.pathname === '/api/menu') {
    return send(res, 200, { ...menu, tables: TABLES, open: isOpen(), hours: ORDER_HOURS });
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
      const tok = newToken();
      q.addSeat.run(sha(tok), s.id, now());
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
    if (!Array.isArray(body.items) || body.items.length === 0) return fail(res, 400, 'empty', 'Your order is empty.');
    if (body.items.length > 40) return fail(res, 400, 'too-many', 'That order is too large to place online. Please ask at the counter.');
    const merged = new Map();
    for (const it of body.items) {
      const item = items.get(it && it.id);
      const qty = Number(it && it.qty);
      if (!item || item.price == null) return fail(res, 400, 'item', 'One of the items is no longer on the menu. Please refresh.');
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) return fail(res, 400, 'qty', 'Quantities must be between 1 and 20.');
      merged.set(item.id, Math.min(20, (merged.get(item.id) || 0) + qty));
    }
    const lines = [...merged].map(([id, qty]) => { const i = items.get(id); return { id, name: i.name, qty, price: i.price, veg: i.veg }; });
    const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
    const status = mine.seat.approved ? 'new' : 'pending';
    const t = now(), token = crypto.randomBytes(12).toString('hex');
    const { lastInsertRowid } = q.insertOrder.run(token, table, JSON.stringify(lines), clean(body.note, 200), clean(body.name, 40), total, status, t, t, s.id, mine.seat.id);
    for (const [k] of keys) countFail(k, 600e3); // count this order against the limits
    const order = orderOut(q.order.get(lastInsertRowid));
    broadcast('order', order);
    broadcast('table', tableView(table));
    return send(res, 201, { ...order, token });
  }

  // Customer: track one order. Needs the token given when it was placed, so order numbers can't be guessed.
  if (req.method === 'GET' && p[1] === 'orders' && p.length === 3) {
    const r = q.order.get(Number(p[2]));
    const t = url.searchParams.get('t') || '';
    if (!r || t.length !== r.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(r.token))) return fail(res, 404, 'not-found', 'Order not found.');
    return send(res, 200, orderOut(r));
  }

  // ---------------- staff login ----------------
  if (p[1] === 'staff') {
    if (req.method === 'POST' && p[2] === 'login') {
      if (failures(`login:${ip}`, 900e3) >= 5) return fail(res, 429, 'locked', 'Too many wrong passwords. Wait 15 minutes and try again.');
      const { password } = await readJson(req, 1024);
      if (!checkPassword(password)) { countFail(`login:${ip}`, 900e3); return fail(res, 401, 'password', 'Wrong password.'); }
      const tok = newToken(), t = Date.now();
      q.addStaff.run(sha(tok), new Date(t).toISOString(), new Date(t + STAFF_SESSION_HOURS * 3600e3).toISOString());
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'glc_staff', tok, STAFF_SESSION_HOURS * 3600) });
    }
    if (req.method === 'POST' && p[2] === 'logout') {
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
      const seat = r.seat_id && q.seatById.get(r.seat_id);
      const waiting = seat ? q.pendingOfSeat.all(seat.id) : [r];
      const to = p[4] === 'approve' ? 'new' : 'cancelled';
      for (const o of waiting) q.setStatus.run(to, now(), o.id);
      if (seat) p[4] === 'approve' ? q.approveSeat.run(seat.id) : q.dropSeat.run(seat.id);
      for (const o of waiting) broadcast('order', orderOut(q.order.get(o.id)));
      broadcast('table', tableView(r.table_no));
      return send(res, 200, orderOut(q.order.get(r.id)));
    }
    if (req.method === 'PATCH' && p[2] === 'orders' && p[3]) {
      const id = Number(p[3]);
      const r = q.order.get(id);
      if (!r) return fail(res, 404, 'not-found', 'Order not found.');
      const { status } = await readJson(req, 1024);
      if (!NEXT[r.status].includes(status)) return fail(res, 409, 'status', `Can't move an order from ${r.status} to ${status}.`);
      q.setStatus.run(status, now(), id);
      const order = orderOut(q.order.get(id));
      broadcast('order', order);
      if (status === 'cancelled') broadcast('table', tableView(r.table_no));
      return send(res, 200, order);
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
        if (!s) { const t = Date.now(); q.newSession.run(table, new Date(t).toISOString(), new Date(t + SESSION_HOURS * 3600e3).toISOString(), minutesFromNow(JOIN_MINUTES)); }
      } else if (p[4] === 'close') {
        if (!s) return fail(res, 409, 'not-open', 'That table is already off.');
        const view = tableView(table, s);
        q.closeSession.run(now(), s.id);
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
const APP_PAGES = new Set(['order.html', 'kitchen.html', 'tables.html']);

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const name = path.relative(ROOT, file);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || name.startsWith('..') || path.isAbsolute(name) || name.split(path.sep).some((x) => x.startsWith('.')) || name.split(path.sep)[0] === 'data' || PRIVATE.has(name)) {
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

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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
}).listen(PORT, () => {
  console.log(`Good Luck Cafe ordering on http://localhost:${PORT}  (tables 1-${TABLES}, ordering ${ORDER_HOURS}, phones can join for ${JOIN_MINUTES} min, tables switch off after ${SESSION_HOURS} h)`);
  console.log(`  Kitchen + tables:  /kitchen.html     Customer:  /order.html?table=1     QR cards:  /tables.html`);
});
