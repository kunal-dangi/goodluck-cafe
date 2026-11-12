// Customer ordering page. Talks to server.js; the server re-prices every order.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var rupees = function (n) { return '₹' + Number(n).toLocaleString('en-IN'); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: keep going */ } },
  };
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
  function svg(path) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'icon'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = path; // fixed icon markup only, never user data
    return s;
  }
  var PLUS = '<path d="M12 5v14M5 12h14"/>', MINUS = '<path d="M5 12h14"/>';

  var menu = null, items = {}, table = null, cart = {}, poll = null;
  var views = ['Picker', 'Menu', 'Cart', 'Done'];
  var seat = { open: false, joined: false, joinOpen: false, approved: false };

  function show(name) {
    views.forEach(function (v) { $('view' + v).hidden = v !== name; });
    $('cartbar').hidden = name !== 'Menu' || count() === 0;
    window.scrollTo(0, 0);
    if (name !== 'Done' && poll) { clearInterval(poll); poll = null; }
  }
  function banner(kind, text) {
    $('banner').replaceChildren(text ? el('p', { class: 'notice ' + kind, style: 'margin-top:14px', text: text }) : '');
  }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw Object.assign(new Error(body.message || 'Something went wrong. Please try again.'), { code: body.error });
        return body;
      });
    }, function () { throw new Error('No connection. Check your internet and try again.'); });
  }

  // ---------- cart ----------
  var cartKey = function () { return 'glc-cart-' + table; };
  function count() { var n = 0; for (var k in cart) n += cart[k]; return n; }
  function total() { var t = 0; for (var k in cart) t += items[k].price * cart[k]; return t; }
  function setQty(id, qty) {
    qty = Math.max(0, Math.min(20, qty));
    if (qty) cart[id] = qty; else delete cart[id];
    store.set(cartKey(), cart);
    document.querySelectorAll('[data-qty="' + id + '"]').forEach(function (slot) { slot.replaceChildren(control(id)); });
    refreshBar();
    if (!$('viewCart').hidden) renderCart();
  }
  function refreshBar() {
    var n = count();
    $('barCount').textContent = n + (n === 1 ? ' item' : ' items');
    $('barTotal').textContent = rupees(total());
    $('cartbar').hidden = $('viewMenu').hidden || n === 0;
  }
  function control(id) {
    var q = cart[id] || 0, name = items[id].name;
    if (!q) return el('button', { class: 'add-btn', type: 'button', 'aria-label': 'Add ' + name, onclick: function () { setQty(id, 1); } }, 'Add');
    return el('span', { class: 'stepper' },
      el('button', { type: 'button', 'aria-label': 'One less ' + name, onclick: function () { setQty(id, q - 1); } }, svg(MINUS)),
      el('output', { 'aria-live': 'polite', text: q }),
      el('button', { type: 'button', 'aria-label': 'One more ' + name, onclick: function () { setQty(id, q + 1); } }, svg(PLUS)));
  }

  // ---------- menu ----------
  function renderMenu() {
    var list = $('menuList'), chips = $('chips');
    list.replaceChildren(); chips.replaceChildren();
    menu.categories.forEach(function (c) {
      var sec = el('section', { class: 'section', id: 's-' + c.id, 'data-cat': c.id }, el('h2', { text: c.name }));
      c.items.forEach(function (i) {
        var row = el('div', { class: 'item' + (i.addon ? ' addon' : ''), 'data-veg': i.veg ? '1' : '0', 'data-search': (i.name + ' ' + c.name).toLowerCase() },
          el('span', { class: 'mark ' + (i.veg ? 'veg' : 'nonveg'), role: 'img', 'aria-label': i.veg ? 'Veg' : 'Egg or non-veg' }),
          el('div', { class: 'item-main' }, el('div', { class: 'item-name', text: i.name }),
            el('div', { class: 'item-price money', text: i.price == null ? 'MRP' : rupees(i.price) })),
          i.price == null ? el('span', { class: 'na', text: 'Ask at the counter' }) : el('span', { 'data-qty': i.id }, control(i.id)));
        sec.append(row);
      });
      list.append(sec);
      chips.append(el('a', { href: '#s-' + c.id, 'data-chip': c.id, text: c.name }));
    });
    filter();
  }
  function filter() {
    var term = $('search').value.trim().toLowerCase(), veg = $('vegOnly').checked, any = false;
    document.querySelectorAll('.section').forEach(function (sec) {
      var shown = 0;
      sec.querySelectorAll('.item').forEach(function (row) {
        var ok = (!veg || row.dataset.veg === '1') && (!term || row.dataset.search.indexOf(term) !== -1);
        row.hidden = !ok; if (ok) shown++;
      });
      sec.hidden = shown === 0;
      var chip = document.querySelector('[data-chip="' + sec.dataset.cat + '"]');
      if (chip) chip.hidden = shown === 0;
      if (shown) any = true;
    });
    $('noResults').hidden = any;
  }
  // highlight the chip of the section being read
  function watchSections() {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        document.querySelectorAll('.chips a').forEach(function (a) { a.classList.toggle('on', a.dataset.chip === e.target.dataset.cat); });
        var on = document.querySelector('.chips a.on');
        if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
    }, { rootMargin: '-130px 0px -60% 0px' });
    document.querySelectorAll('.section').forEach(function (s) { io.observe(s); });
  }

  // ---------- review + place ----------
  function renderCart() {
    var lines = $('cartLines');
    lines.replaceChildren();
    Object.keys(cart).forEach(function (id) {
      var i = items[id];
      lines.append(el('div', { class: 'line' },
        el('span', { class: 'mark ' + (i.veg ? 'veg' : 'nonveg'), role: 'img', 'aria-label': i.veg ? 'Veg' : 'Egg or non-veg' }),
        el('div', { class: 'line-main' }, el('div', { text: i.name }), el('div', { class: 'line-sub money', text: rupees(i.price) + ' each' })),
        el('span', { 'data-qty': id }, control(id))));
    });
    if (!count()) lines.append(el('p', { class: 'line', text: 'Your order is empty.' }));
    $('cartTotal').textContent = rupees(total());
    placeLabel();
  }
  function placeLabel() {
    var btn = $('placeBtn'), ok = seat.open && seat.joined;
    btn.disabled = !count() || !ok;
    btn.textContent = ok ? 'Place order' : !seat.open ? 'Ordering is off for this table' : 'This table is in use';
    $('cartError').replaceChildren(ok ? '' : el('p', { class: 'notice warn', style: 'margin-top:14px', text: tableMessage() }));
  }

  // ---------- table status: switched on? this phone part of it? ----------
  function tableMessage() {
    if (!seat.open) return 'Ordering isn\'t switched on for Table ' + table + ' right now. Please ask at the counter. You can look at the menu meanwhile.';
    if (!seat.joined) return 'Table ' + table + ' is already in use. If you\'re sitting here, please ask at the counter to let your phone join.';
    return '';
  }
  function checkTable() {
    return api('/api/tables/' + table).then(function (s) {
      seat.open = s.open; seat.joined = s.joined; seat.joinOpen = s.joinOpen; seat.approved = s.approved;
      if (s.open && !s.joined && s.joinOpen) {
        return api('/api/tables/' + table + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (j) { seat.joined = true; seat.approved = j.approved; }, function () { /* message below */ });
      }
    }).then(function () { banner(seat.open && seat.joined ? '' : 'warn', tableMessage()); return seat; });
  }
  function place() {
    var btn = $('placeBtn');
    btn.disabled = true; btn.textContent = 'Placing order…';
    $('cartError').replaceChildren();
    api('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: table, note: $('note').value, name: $('name').value,
        items: Object.keys(cart).map(function (id) { return { id: id, qty: cart[id] }; }) }),
    }).then(function (order) {
      var mine = recentOrders();
      mine.unshift({ id: order.id, t: order.token, at: order.createdAt });
      store.set('glc-orders-' + table, mine.slice(0, 10));
      store.set('glc-name', $('name').value);
      cart = {}; store.set(cartKey(), cart); $('note').value = '';
      document.querySelectorAll('[data-qty]').forEach(function (slot) { slot.replaceChildren(control(slot.dataset.qty)); });
      showOrder(order.id, order.token, order);
    }).catch(function (e) {
      if (e.code === 'table-closed' || e.code === 'table-locked' || e.code === 'not-joined') {
        return checkTable().then(placeLabel);
      }
      $('cartError').replaceChildren(el('p', { class: 'notice error', style: 'margin-top:14px', role: 'alert', text: e.message }));
    }).then(function () { if (!$('viewCart').hidden) placeLabel(); });
  }

  // ---------- after ordering ----------
  var STATUS_TEXT = {
    pending: 'Waiting for the counter to confirm your first order. This only happens once per phone.',
    new: 'Sent to the kitchen. They\'ll start on it shortly.',
    preparing: 'The kitchen is preparing your order.',
    ready: 'Ready! It\'s on its way to your table.',
    served: 'Served. Enjoy your meal, and pay at the counter when you\'re done.',
    cancelled: 'This order was cancelled. Please ask at the counter.',
  };
  var ORDER = ['new', 'preparing', 'ready', 'served'];
  function renderOrder(o) {
    $('doneNum').textContent = '#' + o.id;
    $('doneTable').textContent = 'Table ' + o.table + (o.name ? ' · ' + o.name : '');
    var at = ORDER.indexOf(o.status);
    document.querySelectorAll('#steps li').forEach(function (li, idx) {
      li.className = o.status === 'cancelled' ? '' : idx < at || o.status === 'served' ? 'done' : idx === at ? 'now' : '';
    });
    $('statusLine').textContent = STATUS_TEXT[o.status] || '';
    $('doneLines').replaceChildren.apply($('doneLines'), o.items.map(function (l) {
      return el('div', { class: 'line' }, el('span', { class: 'mark ' + (l.veg ? 'veg' : 'nonveg'), role: 'img', 'aria-label': l.veg ? 'Veg' : 'Egg or non-veg' }),
        el('div', { class: 'line-main', text: l.qty + ' × ' + l.name }), el('span', { class: 'money', text: rupees(l.price * l.qty) }));
    }).concat(o.note ? [el('p', { class: 'line line-sub', text: 'Note: ' + o.note })] : []));
    $('doneTotal').textContent = rupees(o.total);
    return o.status === 'served' || o.status === 'cancelled';
  }
  function showOrder(id, token, known) {
    show('Done');
    renderPast(id);
    var finished = known ? renderOrder(known) : false;
    var tick = function () {
      api('/api/orders/' + id + '?t=' + encodeURIComponent(token)).then(function (o) {
        if (renderOrder(o) && poll) { clearInterval(poll); poll = null; }
      }).catch(function (e) { $('statusLine').textContent = e.message; });
    };
    if (!known) tick();
    if (!finished) poll = setInterval(tick, 5000);
  }
  // Only this visit's orders: anything older than a few hours was a previous customer at this table.
  function recentOrders() {
    return store.get('glc-orders-' + table, []).filter(function (o) { return Date.now() - new Date(o.at) < 4 * 3600e3; });
  }
  function renderPast(currentId) {
    var mine = recentOrders().filter(function (o) { return o.id !== currentId; });
    $('past').hidden = !mine.length;
    $('pastList').replaceChildren.apply($('pastList'), mine.map(function (o) {
      return el('button', { type: 'button', onclick: function () { showOrder(o.id, o.t); } },
        el('span', { text: 'Order #' + o.id }), el('span', { class: 'line-sub', text: new Date(o.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) }));
    }));
  }
  function updateOrdersLink() {
    var mine = recentOrders();
    var a = $('myOrdersLink');
    a.hidden = !mine.length;
    a.textContent = mine.length === 1 ? 'Track your order #' + mine[0].id : 'Track your orders (' + mine.length + ')';
  }

  // ---------- start ----------
  function startTable(n) {
    table = n;
    $('tablePill').textContent = 'Table ' + n; $('tablePill').hidden = false;
    cart = store.get(cartKey(), {});
    for (var id in cart) if (!items[id] || items[id].price == null) delete cart[id]; // menu changed since last visit
    $('name').value = store.get('glc-name', '');
    renderMenu(); watchSections(); updateOrdersLink();
    show('Menu');
    refreshBar();
    checkTable().catch(function (e) { banner('error', e.message); });
  }

  document.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (!go) return;
    if (go.dataset.go === 'cart') { renderCart(); show('Cart'); checkTable().then(placeLabel).catch(function () {}); }
    if (go.dataset.go === 'menu') { updateOrdersLink(); show('Menu'); refreshBar(); }
  });
  $('search').addEventListener('input', filter);
  $('vegOnly').addEventListener('change', filter);
  $('placeBtn').addEventListener('click', place);
  $('myOrdersLink').addEventListener('click', function () { var m = recentOrders()[0]; if (m) showOrder(m.id, m.t); });
  $('tableGo').addEventListener('click', function () {
    var n = Number($('tableSelect').value);
    history.replaceState(null, '', '?table=' + n);
    startTable(n);
  });

  api('/api/menu').then(function (m) {
    menu = m;
    m.categories.forEach(function (c) { c.items.forEach(function (i) { items[i.id] = i; }); });
    if (!m.open) banner('warn', 'The kitchen is closed right now. You can look at the menu; ordering opens at 6:00 am.');
    var n = Number(new URLSearchParams(location.search).get('table'));
    if (Number.isInteger(n) && n >= 1 && n <= m.tables) return startTable(n);
    var sel = $('tableSelect');
    for (var t = 1; t <= m.tables; t++) sel.append(el('option', { value: t, text: 'Table ' + t }));
    show('Picker');
  }).catch(function (e) { banner('error', 'Couldn\'t load the menu. ' + e.message); });
})();
