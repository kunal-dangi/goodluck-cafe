// Good Luck Cafe ordering server. No dependencies: Node 22.5+ (built-in SQLite).
// Run:  node --disable-warning=ExperimentalWarning server.js
// Env:  PORT (8080)  TABLES (20)  ORDER_HOURS ("06:00-23:30" India time, or "always")  DB (data/orders.db)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const TABLES = Number(process.env.TABLES) || 20;
const ORDER_HOURS = process.env.ORDER_HOURS || '06:00-23:30';
const DB_FILE = process.env.DB || path.join(ROOT, 'data', 'orders.db');

// ---------- menu: the server's prices are the only prices that count ----------
const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'menu.json'), 'utf8'));
const items = new Map();
for (const c of menu.categories) for (const i of c.items) items.set(i.id, { ...i, category: c.name });

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT    NOT NULL,
    table_no   INTEGER NOT NULL,
    items      TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    name       TEXT    NOT NULL DEFAULT '',
    total      INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'new',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
`);
const q = {
  insert: db.prepare(`INSERT INTO orders (token, table_no, items, note, name, total, status, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`),
  byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
  active: db.prepare(`SELECT * FROM orders WHERE status IN ('new','preparing','ready') ORDER BY id`),
  servedToday: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) amount FROM orders
                           WHERE status = 'served' AND created_at >= ?`),
  setStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
};
const row = (r) => r && { id: r.id, table: r.table_no, items: JSON.parse(r.items), note: r.note, name: r.name,
  total: r.total, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };

// Allowed moves for staff. Anything else is refused.
const NEXT = { new: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served'], served: [], cancelled: [] };

// ---------- helpers ----------
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
function startOfIndiaDayUTC() {
  return new Date(`${indiaNow().date}T00:00:00+05:30`).toISOString();
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// ---------- live updates for the kitchen screen ----------
const listeners = new Set();
function broadcast(order) {
  const msg = `event: order\ndata: ${JSON.stringify(order)}\n\n`;
  for (const res of listeners) res.write(msg);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && url.pathname === '/api/menu') {
    return send(res, 200, { ...menu, tables: TABLES, open: isOpen(), hours: ORDER_HOURS });
  }

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    if (!isOpen()) return send(res, 409, { error: 'closed', message: 'The kitchen is closed right now. Orders open again at 6:00 am.' });
    const body = await readJson(req);
    const table = Number(body.table);
    if (!Number.isInteger(table) || table < 1 || table > TABLES) return send(res, 400, { error: 'table', message: 'Unknown table number.' });
    if (!Array.isArray(body.items) || body.items.length === 0) return send(res, 400, { error: 'empty', message: 'Your order is empty.' });
    if (body.items.length > 40) return send(res, 400, { error: 'too-many', message: 'That order is too large to place online. Please ask the staff.' });

    const merged = new Map();
    for (const it of body.items) {
      const item = items.get(it && it.id);
      const qty = Number(it && it.qty);
      if (!item || item.price == null) return send(res, 400, { error: 'item', message: 'One of the items is no longer on the menu. Please refresh.' });
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) return send(res, 400, { error: 'qty', message: 'Quantities must be between 1 and 20.' });
      merged.set(item.id, Math.min(20, (merged.get(item.id) || 0) + qty));
    }
    const lines = [...merged].map(([id, qty]) => { const i = items.get(id); return { id, name: i.name, qty, price: i.price, veg: i.veg }; });
    const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const now = new Date().toISOString();
    const token = crypto.randomBytes(12).toString('hex');
    const { lastInsertRowid } = q.insert.run(token, table, JSON.stringify(lines), clean(body.note, 200), clean(body.name, 40), total, now, now);
    const order = row(q.byId.get(lastInsertRowid));
    broadcast(order);
    return send(res, 201, { ...order, token });
  }

  // Customer: track one order. The token from placing the order is required, so order numbers can't be guessed.
  if (req.method === 'GET' && parts[1] === 'orders' && parts.length === 3) {
    const r = q.byId.get(Number(parts[2]));
    const t = url.searchParams.get('t') || '';
    if (!r || t.length !== r.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(r.token))) {
      return send(res, 404, { error: 'not-found', message: 'Order not found.' });
    }
    return send(res, 200, row(r));
  }

  // ----- staff (kitchen). TODO security phase: put these behind staff login. -----
  if (parts[1] === 'kitchen') {
    if (req.method === 'GET' && parts[2] === 'orders') {
      const done = q.servedToday.get(startOfIndiaDayUTC());
      return send(res, 200, { orders: q.active.all().map(row), servedToday: done.n, takingsToday: done.amount, open: isOpen() });
    }
    if (req.method === 'PATCH' && parts[2] === 'orders' && parts[3]) {
      const id = Number(parts[3]);
      const r = q.byId.get(id);
      if (!r) return send(res, 404, { error: 'not-found', message: 'Order not found.' });
      const { status } = await readJson(req);
      if (!NEXT[r.status].includes(status)) return send(res, 409, { error: 'status', message: `Can't move an order from ${r.status} to ${status}.` });
      q.setStatus.run(status, new Date().toISOString(), id);
      const order = row(q.byId.get(id));
      broadcast(order);
      return send(res, 200, order);
    }
    if (req.method === 'GET' && parts[2] === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
  }
  return send(res, 404, { error: 'not-found', message: 'Not found.' });
}

// ---------- static files (only public file types; never the database, code or dotfiles) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const PRIVATE = new Set(['server.js', 'package.json']);
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const name = path.relative(ROOT, file);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || name.startsWith('..') || name.split(path.sep).some((p) => p.startsWith('.')) || name.startsWith('data') || PRIVATE.has(name)) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': /\.(html|json)$/.test(file) ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else send(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: 'server', message: e.status ? e.message : 'Something went wrong. Please try again.' });
    if (!e.status) console.error(e);
  }
}).listen(PORT, () => {
  console.log(`Good Luck Cafe ordering: http://localhost:${PORT}  (tables 1-${TABLES}, hours ${ORDER_HOURS})`);
  console.log(`  Customer page:  /order.html?table=1    Kitchen screen:  /kitchen.html    Table QR cards:  /tables.html`);
});
