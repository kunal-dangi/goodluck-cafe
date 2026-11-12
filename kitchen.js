// Receptionist + kitchen screen: staff login, tables on/off, approving new phones, live order board.
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
    ['today', 'live', 'sound', 'logout', 'boardLink'].forEach(function (id) { $(id).hidden = true; });
    $('password').focus();
  }
  function showApp() {
    $('login').hidden = true; $('app').hidden = false;
    ['today', 'live', 'sound', 'logout', 'boardLink'].forEach(function (id) { $(id).hidden = false; });
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

  // Confirm risky taps on the button itself: first tap arms it, a second tap within 4 s does it.
  // (No confirm() pop-ups: many tablet / kiosk browsers block them and silently answer "Cancel".)
  function twoTap(btn, armedText, action) {
    if (btn.dataset.armed) { clearTimeout(Number(btn.dataset.armed)); action(); return; }
    var original = btn.textContent;
    btn.classList.add('armed'); btn.textContent = armedText;
    btn.dataset.armed = setTimeout(function () {
      delete btn.dataset.armed; btn.classList.remove('armed'); btn.textContent = original;
    }, 4000);
  }

  // ---------------- tables ----------------
  function tile(t) {
    if (!t.open) {
      return el('div', { class: 'tile' },
        el('div', { class: 'tile-top' }, el('span', { class: 'tile-num', text: t.table }), el('span', { class: 'tile-state', text: 'Off' })),
        el('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { tableAction(t.table, 'open'); } }, 'Turn on'));
    }
    var left = t.joinUntil ? Math.max(1, Math.ceil((new Date(t.joinUntil) - Date.now()) / 60000)) : 0;
    var info = (t.phones || 0) + (t.phones === 1 ? ' phone' : ' phones') + (t.orders ? ' · ' + t.orders + (t.orders === 1 ? ' order · ' : ' orders · ') + rupees(t.bill) : '');
    return el('div', { class: 'tile open' },
      el('div', { class: 'tile-top' }, el('span', { class: 'tile-num', text: t.table }), el('span', { class: 'tile-state', text: 'On' })),
      el('div', { class: 'tile-bill money', text: info }),
      left ? el('div', { class: 'tile-join' }, el('b', { text: 'New phones can join' }), ' · ' + left + ' min left')
           : el('div', { class: 'tile-join', text: 'Locked to these phones' }),
      left ? null : el('button', { class: 'link', type: 'button', onclick: function () { tableAction(t.table, 'allow-join'); } }, 'Let more phones join'),
      el('div', { class: 'tile-actions' },
        el('button', { class: 'btn btn-ink', type: 'button', 'aria-label': 'Turn off table ' + t.table, onclick: function (e) {
          twoTap(e.currentTarget, t.orders ? 'Tap again · bill ' + rupees(t.bill) : 'Tap again to turn off', function () { tableAction(t.table, 'close'); });
        } }, 'Turn off')));
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

  // Online orders (delivery / pickup) vs table orders
  var isOnline = function (o) { return o.kind === 'delivery' || o.kind === 'pickup'; };
  function where(o) { return o.kind === 'delivery' ? 'Delivery' : o.kind === 'pickup' ? 'Pickup' : 'Table ' + o.table; }
  function whereLong(o) { return o.kind === 'delivery' ? 'delivery to ' + o.name : o.kind === 'pickup' ? 'pickup by ' + o.name : 'table ' + o.table; }
  function prettyPhone(p) { return p ? p.slice(0, 5) + ' ' + p.slice(5) : ''; }
  // Name, tap-to-call number, address and map link for online orders.
  function contact(o) {
    if (!isOnline(o)) return null;
    var maps = o.lat != null ? 'https://www.google.com/maps/search/?api=1&query=' + o.lat + ',' + o.lng : null;
    return el('div', { class: 'contact' },
      el('div', {}, el('b', { text: o.name }), ' · ', el('a', { href: 'tel:+91' + o.phone, text: prettyPhone(o.phone) })),
      o.kind === 'delivery' ? el('div', { class: 'addr', text: o.address }) : null,
      o.kind === 'delivery' ? el('div', { class: 'addr-meta' }, (o.distanceKm != null ? o.distanceKm + ' km · ' : '') + 'delivery ' + (o.fee ? rupees(o.fee) : 'free') + ' · ',
        maps ? el('a', { href: maps, target: '_blank', rel: 'noopener', text: 'Open in Maps' }) : null) : null);
  }
  function ticket(o, fresh) {
    var acts = (ACTIONS[o.status] || []).map(function (a) {
      var label = a[0] === 'served' && o.kind === 'delivery' ? 'Delivered' : a[0] === 'served' && o.kind === 'pickup' ? 'Collected' : a[1];
      return el('button', { class: 'btn go', type: 'button', onclick: function () { move(o, a[0]); } }, label);
    });
    if (o.status === 'new' || o.status === 'preparing') {
      acts.push(el('button', { class: 'btn cancel', type: 'button', 'aria-label': 'Cancel order ' + o.id + ', ' + whereLong(o), onclick: function (e) {
        twoTap(e.currentTarget, 'Tap again', function () { move(o, 'cancelled'); });
      } }, 'Cancel'));
    }
    var mins = minutesAgo(o.createdAt);
    return el('article', { class: 'ticket' + (fresh ? ' fresh' : ''), 'data-status': o.status, 'data-id': o.id },
      el('div', { class: 't-head' },
        el('span', { class: 't-table' + (isOnline(o) ? ' online' : ''), text: where(o) }),
        el('span', { class: 't-meta' }, el('b', { text: '#' + o.id }), el('span', { class: mins >= 15 && o.status !== 'ready' ? 'late' : '', 'data-ago': o.createdAt, text: ago(o.createdAt) }))),
      el('ul', { class: 't-items' }, ...o.items.map(function (l) {
        return el('li', {}, el('span', { class: 'q', text: l.qty + '×' }),
          el('span', { class: 'mark ' + (l.veg ? 'veg' : 'nonveg'), role: 'img', 'aria-label': l.veg ? 'Veg' : 'Egg or non-veg' }),
          el('span', { text: l.name }));
      })),
      o.note ? el('p', { class: 't-note', text: 'Note: ' + o.note }) : null,
      contact(o),
      el('div', { class: 't-foot' }, el('span', { class: 'who', text: !isOnline(o) && o.name ? 'For ' + o.name : isOnline(o) ? 'Cash / UPI on ' + (o.kind === 'delivery' ? 'delivery' : 'pickup') : '' }), el('b', { class: 'money', text: rupees(o.total) })),
      el('div', { class: 't-actions' }, ...acts));
  }
  function approvalCard(o, fresh) {
    var online = isOnline(o);
    return el('article', { class: 'approve' + (online ? ' online' : '') + (fresh ? ' fresh' : '') },
      el('div', { class: 'ap-head' }, el('span', { class: 't-table', text: where(o) }), el('span', { class: 't-meta', 'data-ago': o.createdAt, text: ago(o.createdAt) })),
      online ? el('p', { class: 'ap-hint', text: 'Call ' + prettyPhone(o.phone) + ' to confirm before cooking.' }) : null,
      el('div', { class: 'ap-items', text: o.items.map(function (l) { return l.qty + '× ' + l.name; }).join(', ') }),
      o.note ? el('p', { class: 't-note', text: 'Note: ' + o.note }) : null,
      contact(o),
      el('div', { class: 't-foot' }, el('span', { class: 'who', text: online ? '' : o.name ? 'For ' + o.name : 'New phone' }), el('b', { class: 'money', text: rupees(o.total) })),
      el('div', { class: 'ap-actions' },
        el('button', { class: 'btn ok', type: 'button', onclick: function () { decide(o, 'approve'); } }, online ? 'Confirmed on call' : 'Approve'),
        el('button', { class: 'btn cancel', type: 'button', 'aria-label': 'Reject order ' + o.id + ', ' + whereLong(o), onclick: function (e) {
          twoTap(e.currentTarget, 'Tap again', function () { decide(o, 'reject'); });
        } }, 'Reject')));
  }
  function decide(o, what) {
    error('');
    call('POST', '/api/kitchen/orders/' + o.id + '/' + what).then(upsert).catch(function (e) { error(e.message); load(); });
  }
  function renderOrders(freshId) {
    var pending = [...orders.values()].filter(function (o) { return o.status === 'pending'; }).sort(function (a, b) { return a.id - b.id; });
    $('approvals').hidden = !pending.length;
    $('approveList').replaceChildren(...pending.map(function (o) { return approvalCard(o, o.id === freshId); }));
    ['new', 'preparing', 'ready'].forEach(function (s) {
      var list = [...orders.values()].filter(function (o) { return o.status === s; }).sort(function (a, b) { return a.id - b.id; });
      $('n-' + s).textContent = list.length || '';
      $('c-' + s).replaceChildren(...(list.length ? list.map(function (o) { return ticket(o, o.id === freshId); }) : [el('p', { class: 'empty', text: EMPTY[s] })]));
    });
    var waiting = [...orders.values()].filter(function (o) { return o.status === 'new' || o.status === 'pending'; }).length;
    document.title = (waiting ? '(' + waiting + ') ' : '') + (document.body.classList.contains('board-only') ? 'Kitchen board' : 'Kitchen') + ' · Good Luck Cafe';
    $('today').replaceChildren('Today: ', el('b', { text: servedToday + ' served' }), ' · ', el('b', { class: 'money', text: rupees(takings) }));
  }
  function upsert(o) {
    var was = orders.get(o.id);
    var isNew = (!was && (o.status === 'new' || o.status === 'pending')) || (o.status === 'new' && was && was.status === 'pending');
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

  // ---------------- activity log ----------------
  function loadActivity() {
    if (!$('activity').open) return;
    call('GET', '/api/kitchen/log').then(function (d) {
      $('activityList').replaceChildren(...(d.entries.length ? d.entries.map(function (e) {
        var t = new Date(e.at);
        return el('li', {}, el('time', { datetime: e.at, text: t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' ' + t.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) }),
          el('b', { text: e.action }), el('span', { text: e.detail }));
      }) : [el('li', { text: 'Nothing yet.' })]));
    }).catch(function (e) { error(e.message); });
  }
  $('activity').addEventListener('toggle', loadActivity);

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
    stream.addEventListener('order', function (e) { upsert(JSON.parse(e.data)); loadActivity(); });
    stream.addEventListener('table', function (e) { var t = JSON.parse(e.data); tables.set(t.table, t); renderTables(); loadActivity(); });
    stream.addEventListener('error', function () {
      $('live').textContent = 'Reconnecting…'; $('live').classList.remove('on');
      // a 401 also lands here; check whether we were logged out
      call('GET', '/api/staff/me').catch(function () {});
    });
  }
  setInterval(function () {
    document.querySelectorAll('[data-ago]').forEach(function (s) { s.textContent = ago(s.dataset.ago); });
    if (!$('app').hidden) renderTables(); // joining countdown
  }, 30000);

  // ?view=board shows only New / Preparing / Ready (a kitchen screen); the full page is for the receptionist.
  if (new URLSearchParams(location.search).get('view') === 'board') {
    document.body.classList.add('board-only');
    $('pageTitle').textContent = 'Kitchen board';
    document.title = 'Kitchen board · Good Luck Cafe';
  }
  fetch('/api/staff/me').then(function (r) { if (r.ok) showApp(); else showLogin(); }, function () { showLogin(); error('Can\'t reach the order server.'); });
})();
