// Kitchen screen: staff login, table open/close with PINs, live order board.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var rupees = function (n) { return '₹' + Number(n).toLocaleString('en-IN'); };
  function el(tag, attrs) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) n.append(arguments[i]);
    return n;
  }
  function call(method, path, body) {
    return fetch(path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (r.status === 401 && b.error === 'login') { showLogin(); throw new Error('Please log in again.'); }
          if (!r.ok) throw new Error(b.message || 'Something went wrong.');
          return b;
        });
      }, function () { throw new Error('Can\'t reach the order server. Check the connection.'); });
  }

  var orders = new Map(), tables = new Map(), servedToday = 0, takings = 0;
  var soundOn = false, audio = null, firstLoad = true, stream = null;

  // ---------------- login ----------------
  function showLogin() {
    if (stream) { stream.close(); stream = null; }
    $('app').hidden = true; $('login').hidden = false;
    ['today', 'live', 'sound', 'logout'].forEach(function (id) { $(id).hidden = true; });
    $('password').focus();
  }
  function showApp() {
    $('login').hidden = true; $('app').hidden = false;
    ['today', 'live', 'sound', 'logout'].forEach(function (id) { $(id).hidden = false; });
    connect();
  }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = this.querySelector('button');
    btn.disabled = true; $('loginErr').replaceChildren();
    call('POST', '/api/staff/login', { password: $('password').value })
      .then(function () { $('password').value = ''; showApp(); })
      .catch(function (err) { $('loginErr').replaceChildren(el('p', { class: 'notice error', role: 'alert', text: err.message })); })
      .then(function () { btn.disabled = false; });
  });
  $('logout').addEventListener('click', function () { call('POST', '/api/staff/logout').catch(function () {}).then(showLogin); });

  // ---------------- tables ----------------
  function tile(t) {
    if (!t.open) {
      return el('div', { class: 'tile' },
        el('div', { class: 'tile-top' }, el('span', { class: 'tile-num', text: t.table }), el('span', { class: 'tile-state', text: 'Available' })),
        el('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { tableAction(t.table, 'open'); } }, 'Open table'));
    }
    return el('div', { class: 'tile open' },
      el('div', { class: 'tile-top' }, el('span', { class: 'tile-num', text: t.table }), el('span', { class: 'tile-state', text: 'Occupied' })),
      el('div', { class: 'tile-pin' }, 'PIN', el('b', { text: t.pin })),
      el('div', { class: 'tile-bill money', text: t.orders ? t.orders + (t.orders === 1 ? ' order · ' : ' orders · ') + rupees(t.bill) : 'No orders yet' }),
      el('div', { class: 'tile-actions' },
        el('button', { class: 'btn btn-ink', type: 'button', onclick: function () {
          var msg = 'Close table ' + t.table + '?\n\n' + (t.orders ? 'Bill: ' + rupees(t.bill) + ' for ' + t.orders + (t.orders === 1 ? ' order' : ' orders') + '.\n' : '') + 'Phones at this table will no longer be able to order.';
          if (confirm(msg)) tableAction(t.table, 'close');
        } }, 'Close'),
        el('button', { class: 'btn ghost', type: 'button', title: 'Use if the PIN was shared with someone not at the table', onclick: function () {
          if (confirm('Make a new PIN for table ' + t.table + '? Phones already ordering at this table keep working.')) tableAction(t.table, 'new-pin');
        } }, 'New PIN')));
  }
  function renderTables() {
    var list = [...tables.values()].sort(function (a, b) { return a.table - b.table; });
    $('tiles').replaceChildren(...list.map(tile));
  }
  function tableAction(n, action) {
    error('');
    call('POST', '/api/kitchen/tables/' + n + '/' + action).then(function (t) {
      tables.set(t.table, t); renderTables();
    }).catch(function (e) { error(e.message); });
  }

  // ---------------- orders ----------------
  var ACTIONS = { new: [['preparing', 'Start preparing']], preparing: [['ready', 'Mark ready']], ready: [['served', 'Served']] };
  var EMPTY = { new: 'No new orders. New ones appear here with a sound.', preparing: 'Nothing on the stove.', ready: 'Nothing waiting to be served.' };
  function minutesAgo(iso) { return Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)); }
  function ago(iso) { var m = minutesAgo(iso); return m < 1 ? 'just now' : m === 1 ? '1 min ago' : m + ' min ago'; }

  function ticket(o, fresh) {
    var acts = (ACTIONS[o.status] || []).map(function (a) {
      return el('button', { class: 'btn go', type: 'button', onclick: function () { move(o, a[0]); } }, a[1]);
    });
    if (o.status === 'new' || o.status === 'preparing') {
      acts.push(el('button', { class: 'btn cancel', type: 'button', onclick: function () {
        if (confirm('Cancel order #' + o.id + ' for table ' + o.table + '? The customer will see it was cancelled.')) move(o, 'cancelled');
      } }, 'Cancel'));
    }
    var mins = minutesAgo(o.createdAt);
    return el('article', { class: 'ticket' + (fresh ? ' fresh' : ''), 'data-status': o.status, 'data-id': o.id },
      el('div', { class: 't-head' },
        el('span', { class: 't-table', text: 'Table ' + o.table }),
        el('span', { class: 't-meta' }, el('b', { text: '#' + o.id }), el('span', { class: mins >= 15 && o.status !== 'ready' ? 'late' : '', 'data-ago': o.createdAt, text: ago(o.createdAt) }))),
      el('ul', { class: 't-items' }, ...o.items.map(function (l) {
        return el('li', {}, el('span', { class: 'q', text: l.qty + '×' }),
          el('span', { class: 'mark ' + (l.veg ? 'veg' : 'nonveg'), role: 'img', 'aria-label': l.veg ? 'Veg' : 'Egg or non-veg' }),
          el('span', { text: l.name }));
      })),
      o.note ? el('p', { class: 't-note', text: 'Note: ' + o.note }) : null,
      el('div', { class: 't-foot' }, el('span', { class: 'who', text: o.name ? 'For ' + o.name : '' }), el('b', { class: 'money', text: rupees(o.total) })),
      el('div', { class: 't-actions' }, ...acts));
  }
  function renderOrders(freshId) {
    ['new', 'preparing', 'ready'].forEach(function (s) {
      var list = [...orders.values()].filter(function (o) { return o.status === s; }).sort(function (a, b) { return a.id - b.id; });
      $('n-' + s).textContent = list.length || '';
      $('c-' + s).replaceChildren(...(list.length ? list.map(function (o) { return ticket(o, o.id === freshId); }) : [el('p', { class: 'empty', text: EMPTY[s] })]));
    });
    var waiting = [...orders.values()].filter(function (o) { return o.status === 'new'; }).length;
    document.title = (waiting ? '(' + waiting + ') ' : '') + 'Kitchen · Good Luck Cafe';
    $('today').replaceChildren('Today: ', el('b', { text: servedToday + ' served' }), ' · ', el('b', { class: 'money', text: rupees(takings) }));
  }
  function upsert(o) {
    var isNew = !orders.has(o.id) && o.status === 'new';
    if (o.status === 'served') { if (orders.has(o.id)) { servedToday++; takings += o.total; } orders.delete(o.id); }
    else if (o.status === 'cancelled') orders.delete(o.id);
    else orders.set(o.id, o);
    renderOrders(isNew ? o.id : null);
    if (isNew && !firstLoad) ding();
  }
  function move(o, status) {
    error('');
    call('PATCH', '/api/kitchen/orders/' + o.id, { status: status }).then(upsert).catch(function (e) { error(e.message); load(); });
  }
  function error(msg) { $('err').replaceChildren(msg ? el('p', { class: 'notice error err', role: 'alert', text: msg }) : ''); }

  function load() {
    return Promise.all([call('GET', '/api/kitchen/orders'), call('GET', '/api/kitchen/tables')]).then(function (r) {
      orders = new Map(r[0].orders.map(function (o) { return [o.id, o]; }));
      servedToday = r[0].servedToday; takings = r[0].takingsToday;
      tables = new Map(r[1].tables.map(function (t) { return [t.table, t]; }));
      renderOrders(null); renderTables();
    });
  }

  // two-note chime; browsers only allow sound after a tap, hence the button
  function ding() {
    if (!soundOn || !audio) return;
    [880, 1320].forEach(function (f, i) {
      var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.18;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.55);
    });
  }
  $('sound').addEventListener('click', function () {
    soundOn = !soundOn;
    if (soundOn && !audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    this.setAttribute('aria-pressed', soundOn);
    this.textContent = soundOn ? 'Sound on' : 'Turn sound on';
    if (soundOn) ding();
  });

  function connect() {
    if (stream) stream.close();
    stream = new EventSource('/api/kitchen/stream');
    stream.addEventListener('open', function () {
      $('live').textContent = 'Live'; $('live').classList.add('on');
      load().then(function () { firstLoad = false; error(''); }).catch(function (e) { error(e.message); });
    });
    stream.addEventListener('order', function (e) { upsert(JSON.parse(e.data)); });
    stream.addEventListener('table', function (e) { var t = JSON.parse(e.data); tables.set(t.table, t); renderTables(); });
    stream.addEventListener('error', function () {
      $('live').textContent = 'Reconnecting…'; $('live').classList.remove('on');
      // a 401 also lands here; check whether we were logged out
      call('GET', '/api/staff/me').catch(function () {});
    });
  }
  setInterval(function () { document.querySelectorAll('[data-ago]').forEach(function (s) { s.textContent = ago(s.dataset.ago); }); }, 30000);

  fetch('/api/staff/me').then(function (r) { if (r.ok) showApp(); else showLogin(); }, function () { showLogin(); error('Can\'t reach the order server.'); });
})();
