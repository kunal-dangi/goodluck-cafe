// Customer ordering: table orders (order.html) and online delivery / pickup (online.html, body data-mode="online").
// Talks to server.js; the server re-prices every order and makes every decision. This page only helps.
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
  var STAR = '<path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/>';
  function starSvg() { var s = svg(STAR); s.removeAttribute('class'); return s; }

  var menu = null, items = {}, table = null, cart = {}, poll = null, current = null; // current: { id, token } shown in Done
  var ONLINE = document.body.dataset.mode === 'online';
  var views = ONLINE ? ['Menu', 'Cart', 'Done'] : ['Picker', 'Here', 'Menu', 'Cart', 'Done'];
  var askedHere = false; // shown the location screen once this visit
  var loc = null; // online delivery: { lat, lng, accuracy, km, fee } once the phone shares its location
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
            el('div', { class: 'item-price money' }, i.price == null ? 'MRP' : rupees(i.price), ratingBadge(i.id))),
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
    if (ONLINE) updateSummary();
    placeLabel();
  }
  function needLocation() { return !ONLINE && seat.open && !seat.joined && seat.joinOpen && menu.onsite && menu.onsite.on; }
  function placeLabel() {
    if (ONLINE) return onlineLabel();
    var btn = $('placeBtn'), ok = seat.open && seat.joined;
    btn.disabled = !count() || !(ok || needLocation());
    btn.textContent = ok ? 'Place order' : needLocation() ? 'Share location to order' : !seat.open ? 'Ordering is off for this table' : 'This table is in use';
    $('cartError').replaceChildren(ok ? '' : el('p', { class: 'notice warn', style: 'margin-top:14px', text: tableMessage() }));
  }

  // ---------- table status: switched on? this phone part of it? ----------
  function tableMessage() {
    if (!seat.open) return 'Ordering isn\'t switched on for Table ' + table + ' right now. Please ask at the counter. You can look at the menu meanwhile.';
    if (!seat.joined && seat.joinOpen && menu.onsite && menu.onsite.on) return 'Share your location to order from Table ' + table + '. It only checks you\'re inside the cafe.';
    if (!seat.joined) return 'Table ' + table + ' is already in use. If you\'re sitting here, please ask at the counter to let your phone join.';
    return '';
  }
  function checkTable() {
    return api('/api/tables/' + table).then(function (s) {
      seat.open = s.open; seat.joined = s.joined; seat.joinOpen = s.joinOpen; seat.approved = s.approved;
      if (s.open && !s.joined && s.joinOpen) {
        if (menu.onsite && menu.onsite.on) { if (!askedHere) { askedHere = true; show('Here'); } return; }
        return join({});
      }
    }).then(function () {
      var quiet = (seat.open && seat.joined) || !$('viewHere').hidden; // the location screen explains itself
      banner(quiet ? '' : 'warn', quiet ? '' : tableMessage());
      return seat;
    });
  }
  function join(body) {
    return api('/api/tables/' + table + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (j) { seat.joined = true; seat.approved = j.approved; });
  }

  // ---------- "are you at the cafe?" (table ordering location check) ----------
  function hereMsg(kind, text) { $('hereMsg').replaceChildren(text ? el('p', { class: 'notice ' + kind, role: kind === 'error' ? 'alert' : null, text: text }) : ''); }
  function shareLocation() {
    var btn = $('hereBtn');
    if (!window.isSecureContext || !navigator.geolocation) return hereMsg('error', 'This browser can\'t share your location. Please ask at the counter to order.');
    btn.disabled = true; btn.textContent = 'Checking…'; hereMsg('', '');
    navigator.geolocation.getCurrentPosition(function (p) {
      join({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }).then(function () {
        var m = Math.round(distanceKm(menu.delivery.cafe, { lat: p.coords.latitude, lng: p.coords.longitude }) * 1000);
        $('hereOkText').textContent = 'You\'re at the cafe · Table ' + table;
        $('hereOk').hidden = false; $('hereOk').title = 'About ' + m + ' m from our map pin';
        banner('', ''); show('Menu'); refreshBar();
      }, function (e) {
        hereMsg(e.code === 'not-here' ? 'error' : 'warn', e.message);
        if (e.code === 'table-locked' || e.code === 'table-closed') checkTable().then(function () { show('Menu'); });
      }).then(function () { btn.disabled = false; btn.textContent = 'Try again'; });
    }, function (err) {
      btn.disabled = false; btn.textContent = 'Try again';
      hereMsg('error', err.code === 1
        ? 'Location is blocked for this page. Open your browser settings, allow location for this site, then tap Try again.'
        : 'Couldn\'t find your location. Turn on location / GPS on your phone and tap Try again.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }
  if (!ONLINE) $('hereBtn').addEventListener('click', shareLocation);
  function place() {
    if (ONLINE) return placeOnline();
    if (needLocation()) return show('Here');
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
        askedHere = false;
        return checkTable().then(placeLabel);
      }
      $('cartError').replaceChildren(el('p', { class: 'notice error', style: 'margin-top:14px', role: 'alert', text: e.message }));
    }).then(function () { if (!$('viewCart').hidden) placeLabel(); });
  }

  // ---------- online: delivery or pickup ----------
  function kind() { var r = document.querySelector('input[name="kind"]:checked'); return r ? r.value : 'delivery'; }
  function distanceKm(a, b) {
    var R = 6371, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function feeFor(km) { var f = menu.delivery.fees; for (var i = 0; i < f.length; i++) if (km <= f[i][0]) return f[i][1]; return null; }
  function locStatus(kindOf, text) { $('locStatus').replaceChildren(text ? el('p', { class: 'notice ' + kindOf, text: text }) : ''); }
  function locate() {
    var btn = $('locBtn');
    if (!window.isSecureContext || !navigator.geolocation) {
      return locStatus('error', 'This browser can\'t share your location. Try Chrome or Safari on your phone, or choose pickup.');
    }
    btn.disabled = true; btn.lastChild.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(function (p) {
      btn.disabled = false; btn.lastChild.textContent = 'Update my location';
      var c = p.coords, km = distanceKm(menu.delivery.cafe, { lat: c.latitude, lng: c.longitude });
      if (c.accuracy > menu.delivery.maxAccuracyM) {
        loc = null;
        locStatus('warn', 'Your location isn\'t precise enough (about ' + Math.round(c.accuracy / 100) / 10 + ' km). Turn on GPS / precise location and try again, or choose pickup.');
      } else if (feeFor(km) == null) {
        loc = null;
        locStatus('error', 'Sorry, you\'re ' + km.toFixed(1) + ' km away. We deliver within ' + menu.delivery.maxKm + ' km. You can choose pickup instead.');
      } else {
        loc = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, km: km, fee: feeFor(km) };
        locStatus('info', 'You\'re ' + km.toFixed(1) + ' km from the cafe. Delivery: ' + (loc.fee ? rupees(loc.fee) : 'free') + '.');
      }
      updateSummary(); placeLabel();
    }, function (err) {
      btn.disabled = false; btn.lastChild.textContent = 'Use my location';
      loc = null;
      locStatus('error', err.code === 1
        ? 'Location is blocked for this site. Allow location in your browser settings to get delivery, or choose pickup.'
        : 'Couldn\'t find your location. Turn on location / GPS and try again, or choose pickup.');
      updateSummary(); placeLabel();
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  function updateSummary() {
    var delivery = kind() === 'delivery', fee = delivery && loc ? loc.fee : 0;
    $('deliveryBox').hidden = !delivery;
    $('sumFeeRow').hidden = !delivery;
    $('sumItems').textContent = rupees(total());
    $('sumFee').textContent = !loc ? 'Share location to see' : fee ? rupees(fee) : 'Free';
    $('cartTotal').textContent = rupees(total() + fee);
    $('payNote').textContent = delivery
      ? 'Pay by cash or UPI when your food arrives. We\'ll call you to confirm the order before we start cooking.'
      : 'Pay by cash or UPI when you collect it at the counter. We\'ll call you to confirm the order before we start cooking.';
  }
  function onlineLabel() {
    var btn = $('placeBtn'), needLoc = kind() === 'delivery' && !loc;
    btn.disabled = !count() || needLoc || (menu && !menu.open);
    btn.textContent = needLoc ? 'Share your location to order delivery' : 'Place order · ' + rupees(total() + (kind() === 'delivery' && loc ? loc.fee : 0));
  }
  function placeOnline() {
    var btn = $('placeBtn'), err = $('cartError');
    err.replaceChildren();
    var problem = $('name').value.trim().length < 2 ? 'Please enter your name.'
      : !/^(\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}$/.test($('phone').value.trim()) ? 'Please enter a valid 10-digit mobile number.'
      : kind() === 'delivery' && $('address').value.trim().length < 10 ? 'Please enter your full delivery address.' : '';
    if (problem) return err.replaceChildren(el('p', { class: 'notice error', style: 'margin-top:14px', role: 'alert', text: problem }));
    btn.disabled = true; btn.textContent = 'Placing order…';
    var body = { kind: kind(), name: $('name').value, phone: $('phone').value, note: $('note').value,
      items: Object.keys(cart).map(function (id) { return { id: id, qty: cart[id] }; }) };
    if (body.kind === 'delivery') { body.address = $('address').value; body.lat = loc.lat; body.lng = loc.lng; body.accuracy = loc.accuracy; }
    api('/api/online-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (order) {
        var mine = recentOrders();
        mine.unshift({ id: order.id, t: order.token, at: order.createdAt });
        store.set('glc-orders-' + table, mine.slice(0, 10));
        store.set('glc-contact', { name: $('name').value, phone: $('phone').value, address: $('address').value });
        cart = {}; store.set(cartKey(), cart); $('note').value = '';
        document.querySelectorAll('[data-qty]').forEach(function (slot) { slot.replaceChildren(control(slot.dataset.qty)); });
        showOrder(order.id, order.token, order);
      })
      .catch(function (e) { err.replaceChildren(el('p', { class: 'notice error', style: 'margin-top:14px', role: 'alert', text: e.message })); })
      .then(function () { if (!$('viewCart').hidden) onlineLabel(); });
  }

  // ---------- dish ratings (real averages only; a dish nobody rated shows 0.0) ----------
  function ratingBadge(id) {
    var r = (menu.ratings || {})[id] || { avg: 0, count: 0 };
    var badge = el('span', { class: 'rating' + (r.count ? ' has' : ''), 'data-rating': id,
      'aria-label': r.count ? 'Rated ' + r.avg.toFixed(1) + ' out of 5 from ' + r.count + (r.count === 1 ? ' rating' : ' ratings') : 'No ratings yet' });
    badge.append(starSvg(), el('b', { text: r.avg.toFixed(1) }), el('span', { text: '(' + r.count + ')' }));
    return badge;
  }
  function refreshRatings() {
    return api('/api/menu').then(function (m) {
      menu.ratings = m.ratings;
      document.querySelectorAll('[data-rating]').forEach(function (b) { b.replaceWith(ratingBadge(b.dataset.rating)); });
    }).catch(function () {});
  }
  function renderReview(o) {
    var done = o.reviewed || store.get('glc-reviewed', []).indexOf(o.id) !== -1;
    $('reviewBox').hidden = o.status !== 'served' || done;
    $('reviewThanks').hidden = o.status !== 'served' || !done;
    if ($('reviewBox').hidden || $('reviewItems').dataset.order === String(o.id)) return;
    $('reviewItems').dataset.order = o.id;
    $('reviewErr').replaceChildren();
    $('reviewItems').replaceChildren.apply($('reviewItems'), o.items.map(function (l) {
      var labels = [];
      var box = el('span', { class: 'stars-input', role: 'radiogroup', 'aria-label': 'Stars for ' + l.name });
      for (var n = 1; n <= 5; n++) {
        (function (n) {
          var input = el('input', { type: 'radio', name: 'rate-' + l.id, value: n, 'aria-label': n + (n === 1 ? ' star' : ' stars') });
          input.addEventListener('change', function () { labels.forEach(function (lb, i) { lb.classList.toggle('on', i < n); }); });
          var label = el('label', {}, input, starSvg());
          labels.push(label); box.append(label);
        })(n);
      }
      return el('fieldset', { class: 'rate', 'data-item': l.id }, el('legend', { text: l.name }), box);
    }));
  }
  $('reviewBtn').addEventListener('click', function () {
    var btn = this, ratings = [];
    document.querySelectorAll('#reviewItems .rate').forEach(function (f) {
      var c = f.querySelector('input:checked');
      if (c) ratings.push({ id: f.dataset.item, stars: Number(c.value) });
    });
    if (!ratings.length) return $('reviewErr').replaceChildren(el('p', { class: 'notice error', role: 'alert', text: 'Tap the stars to rate at least one dish.' }));
    btn.disabled = true; btn.textContent = 'Sending…';
    var id = current.id;
    api('/api/orders/' + id + '/review?t=' + encodeURIComponent(current.token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratings: ratings }) })
      .then(function () {
        store.set('glc-reviewed', store.get('glc-reviewed', []).concat(id).slice(-50));
        $('reviewBox').hidden = true; $('reviewThanks').hidden = false;
        refreshRatings();
      }, function (e) {
        if (e.code === 'reviewed') { store.set('glc-reviewed', store.get('glc-reviewed', []).concat(id).slice(-50)); $('reviewBox').hidden = true; $('reviewThanks').hidden = false; return; }
        $('reviewErr').replaceChildren(el('p', { class: 'notice error', role: 'alert', text: e.message }));
      })
      .then(function () { btn.disabled = false; btn.textContent = 'Send rating'; });
  });

  // ---------- pay by UPI ----------
  // The UPI app opens with the cafe's ID, the amount and the order number. The receptionist confirms the money arrived.
  var lastClaim = {}; // order id -> was waiting for confirmation (to notice "not received")
  var PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  function upiLink(o) {
    var u = menu.upi, note = 'Order ' + o.id + (o.kind === 'delivery' ? ' delivery' : o.kind === 'pickup' ? ' pickup' : ' Table ' + o.table);
    return 'upi://pay?pa=' + encodeURIComponent(u.id) + '&pn=' + encodeURIComponent(u.name) + '&am=' + Number(o.total).toFixed(2) +
      '&cu=INR&tn=' + encodeURIComponent(note);
  }
  function renderPay(o) {
    var box = $('payBox'), state = $('payState'), u = menu.upi;
    var payable = o.status !== 'pending' && o.status !== 'cancelled';
    state.hidden = true; state.className = 'pay-state';
    if (o.paidAt) {
      $('doneTotalLabel').textContent = 'Paid';
      box.hidden = true; state.hidden = false; state.classList.add('paid');
      state.textContent = 'Paid ✓ ' + rupees(o.total) + (o.paidMethod === 'cash' ? ' in cash' : ' by UPI') + '. Thank you!';
    } else if (o.payClaimedAt) {
      box.hidden = true; state.hidden = false; state.classList.add('checking');
      state.textContent = 'Thanks! The cafe is checking your UPI payment of ' + rupees(o.total) + '. This takes a minute.';
    } else {
      box.hidden = !u || !payable;
      if (!box.hidden) {
        var table = !o.kind || o.kind === 'table';
        $('payLead').textContent = 'Pay ' + rupees(o.total) + ' straight to ' + u.name + '. ' + (table ? 'You can also pay at the counter.' : 'Or pay in cash ' + (o.kind === 'delivery' ? 'on delivery.' : 'at pickup.'));
        var link = upiLink(o), q = link.slice(link.indexOf('?'));
        // Each app's own link, so the customer picks the app (a plain upi:// link opens whatever the phone set as default).
        $('payGpay').href = 'tez://upi/pay' + q; $('payPhonepe').href = 'phonepe://pay' + q; $('payPaytm').href = 'paytmmp://pay' + q; $('payLink').href = link;
        $('payAmt').textContent = rupees(o.total);
        $('payApps').hidden = !PHONE;
        $('payQr').parentNode.classList.toggle('small', PHONE);
        $('payScan').textContent = PHONE ? 'Paying from another phone? Scan this. Or screenshot it and open it from your UPI app\'s scanner.'
                                         : 'Scan with GPay, PhonePe, Paytm or any UPI app';
        $('payId').textContent = u.id;
        if ($('payQr').dataset.link !== link && window.QRCode) {
          $('payQr').dataset.link = link; $('payQr').replaceChildren();
          new QRCode($('payQr'), { text: link, width: 400, height: 400, colorDark: '#1f1a17', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
        }
        if (lastClaim[o.id]) $('payMsg').replaceChildren(el('p', { class: 'notice warn', text: 'The cafe couldn\'t find your payment yet. If money left your account, show the receipt at the counter; otherwise try again or pay at the counter.' }));
        else $('payMsg').replaceChildren();
      } else if (u && o.status === 'pending') {
        state.hidden = false;
        state.textContent = (!o.kind || o.kind === 'table' ? 'Once the cafe accepts your order' : 'Once we confirm your order on the phone') + ', a "Pay with UPI" button appears here.';
      }
    }
    lastClaim[o.id] = !!o.payClaimedAt && !o.paidAt;
    return !!o.payClaimedAt && !o.paidAt; // still waiting: keep checking
  }
  $('paidBtn').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    api('/api/orders/' + current.id + '/paid?t=' + encodeURIComponent(current.token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (o) { renderOrder(o); keepPolling(); })
      .catch(function (e) { $('payMsg').replaceChildren(el('p', { class: 'notice error', role: 'alert', text: e.message })); })
      .then(function () { btn.disabled = false; });
  });

  // ---------- the cafe cancelled an order: tell the customer wherever they are ----------
  function cancelText(o) {
    var table = !o.kind || o.kind === 'table';
    return (o.cancelledBy === 'kitchen' ? 'Sorry, the kitchen couldn\'t make order #' + o.id + ' and had to cancel it.' : 'Sorry, the cafe cancelled order #' + o.id + '.') +
      (o.paidAt ? ' You paid ' + rupees(o.total) + ', so please ask ' + (table ? 'at the counter' : 'the cafe') + ' for your refund.'
        : table ? ' Please ask at the counter if you have questions.' : ' If that\'s a mistake, please call the cafe.');
  }
  var watched = {}; // order id -> last status we saw
  function acked() { return store.get('glc-cx-ack', []); }
  function showCancelAlert(o, token) {
    if (acked().indexOf(o.id) !== -1) return;
    $('cancelText').textContent = cancelText(o);
    $('cancelAlert').hidden = false;
    $('cancelSee').onclick = function () { ack(o.id); showOrder(o.id, token); };
    $('cancelOk').onclick = function () { ack(o.id); };
    if (navigator.vibrate) try { navigator.vibrate([120, 60, 120]); } catch (e) {}
  }
  function ack(id) { store.set('glc-cx-ack', acked().concat(id).slice(-50)); $('cancelAlert').hidden = true; }
  // Check this phone's recent orders every 8 s, on every screen.
  function watchMyOrders() {
    recentOrders().forEach(function (m) {
      if (watched[m.id] === 'served' || watched[m.id] === 'cancelled') return;
      api('/api/orders/' + m.id + '?t=' + encodeURIComponent(m.t)).then(function (o) {
        if (o.status === 'cancelled' && watched[m.id] !== 'cancelled') showCancelAlert(o, m.t);
        watched[m.id] = o.status;
      }).catch(function () {});
    });
  }
  setInterval(function () { if (table != null) watchMyOrders(); }, 8000);

  // ---------- after ordering ----------
  var STATUS_TEXT = {
    pending: 'Waiting for the counter to confirm your first order. This only happens once per phone.',
    new: 'Sent to the kitchen. They\'ll start on it shortly.',
    preparing: 'The kitchen is preparing your order.',
    ready: 'Ready! It\'s on its way to your table.',
    served: 'Served. Enjoy your meal, and pay at the counter when you\'re done.',
    cancelled: 'This order was cancelled. Please ask at the counter.',
  };
  var ONLINE_TEXT = {
    pending: 'Order received. We\'ll call you shortly to confirm it.',
    new: 'Confirmed! The kitchen will start on it shortly.',
    preparing: 'The kitchen is preparing your order.',
    readydelivery: 'Ready, and on its way to you.',
    readypickup: 'Ready! Collect it from the counter.',
    serveddelivery: 'Delivered. Enjoy your meal!',
    servedpickup: 'Collected. Enjoy your meal!',
    cancelled: 'This order was cancelled. If that\'s a mistake, please call the cafe.',
  };
  var ORDER = ['new', 'preparing', 'ready', 'served'];
  function renderOrder(o) {
    $('doneNum').textContent = '#' + o.id;
    if (o.kind && o.kind !== 'table') {
      var d = o.kind === 'delivery';
      $('doneTable').textContent = (d ? 'Delivery' + (o.distanceKm != null ? ' · ' + o.distanceKm + ' km' : '') : 'Pickup') + ' · ' + o.name;
      $('stepReady').textContent = d ? 'On the way' : 'Ready';
      $('stepDone').textContent = d ? 'Delivered' : 'Collected';
      $('doneTotalLabel').textContent = d ? 'To pay on delivery' : 'To pay at pickup';
    } else {
      $('doneTable').textContent = 'Table ' + o.table + (o.name ? ' · ' + o.name : '');
      $('doneTotalLabel').textContent = 'To pay at the counter';
    }
    var at = ORDER.indexOf(o.status);
    document.querySelectorAll('#steps li').forEach(function (li, idx) {
      li.className = o.status === 'cancelled' ? '' : idx < at || o.status === 'served' ? 'done' : idx === at ? 'now' : '';
    });
    $('statusLine').textContent = o.status === 'cancelled' ? cancelText(o) : (o.kind && o.kind !== 'table'
      ? ONLINE_TEXT[o.status + (o.status === 'ready' || o.status === 'served' ? o.kind : '')] : STATUS_TEXT[o.status]) || '';
    $('doneLines').replaceChildren.apply($('doneLines'), o.items.map(function (l) {
      return el('div', { class: 'line' }, el('span', { class: 'mark ' + (l.veg ? 'veg' : 'nonveg'), role: 'img', 'aria-label': l.veg ? 'Veg' : 'Egg or non-veg' }),
        el('div', { class: 'line-main', text: l.qty + ' × ' + l.name }), el('span', { class: 'money', text: rupees(l.price * l.qty) }));
    }).concat(o.fee ? [el('div', { class: 'line' }, el('div', { class: 'line-main', text: 'Delivery' }), el('span', { class: 'money', text: rupees(o.fee) }))] : [])
      .concat(o.note ? [el('p', { class: 'line line-sub', text: 'Note: ' + o.note })] : []));
    $('doneTotal').textContent = rupees(o.total);
    renderReview(o);
    var waitingPay = renderPay(o);
    return (o.status === 'served' || o.status === 'cancelled') && !waitingPay;
  }
  function keepPolling() {
    if (poll || !current) return;
    var id = current.id, token = current.token;
    poll = setInterval(function () {
      api('/api/orders/' + id + '?t=' + encodeURIComponent(token)).then(function (o) {
        if (!current || current.id !== id) return; // another order is on screen now
        if (renderOrder(o) && poll) { clearInterval(poll); poll = null; }
      }).catch(function () {});
    }, 5000);
  }
  function showOrder(id, token, known) {
    if (poll) { clearInterval(poll); poll = null; } // stop refreshing the order shown before
    current = { id: id, token: token };
    show('Done');
    renderPast(id);
    var finished = known ? renderOrder(known) : false;
    var tick = function () {
      api('/api/orders/' + id + '?t=' + encodeURIComponent(token)).then(function (o) {
        if (!current || current.id !== id) return; // a late reply for an order no longer shown
        if (renderOrder(o) && poll) { clearInterval(poll); poll = null; }
      }).catch(function (e) { if (current && current.id === id) $('statusLine').textContent = e.message; });
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
    if (go.dataset.go === 'cart') { renderCart(); show('Cart'); if (!ONLINE) checkTable().then(placeLabel).catch(function () {}); }
    if (go.dataset.go === 'menu') { updateOrdersLink(); show('Menu'); refreshBar(); }
  });
  $('search').addEventListener('input', filter);
  $('vegOnly').addEventListener('change', filter);
  $('placeBtn').addEventListener('click', place);
  $('myOrdersLink').addEventListener('click', function () { var m = recentOrders()[0]; if (m) showOrder(m.id, m.t); });
  if (ONLINE) {
    $('locBtn').addEventListener('click', locate);
    document.querySelectorAll('input[name="kind"]').forEach(function (r) { r.addEventListener('change', function () { updateSummary(); placeLabel(); }); });
  }
  function startOnline() {
    table = 'online'; // storage keys: glc-cart-online, glc-orders-online
    cart = store.get(cartKey(), {});
    for (var id in cart) if (!items[id] || items[id].price == null) delete cart[id];
    var c = store.get('glc-contact', {});
    $('name').value = c.name || ''; $('phone').value = c.phone || ''; $('address').value = c.address || '';
    renderMenu(); watchSections(); updateOrdersLink();
    show('Menu');
    refreshBar();
  }
  if (!ONLINE) $('tableGo').addEventListener('click', function () {
    var n = Number($('tableSelect').value);
    history.replaceState(null, '', '?table=' + n);
    startTable(n);
  });

  api('/api/menu').then(function (m) {
    menu = m;
    m.categories.forEach(function (c) { c.items.forEach(function (i) { items[i.id] = i; }); });
    if (!m.open) banner('warn', 'The kitchen is closed right now. You can look at the menu; ordering opens at 6:00 am.');
    if (ONLINE) return startOnline();
    var n = Number(new URLSearchParams(location.search).get('table'));
    if (Number.isInteger(n) && n >= 1 && n <= m.tables) return startTable(n);
    var sel = $('tableSelect');
    for (var t = 1; t <= m.tables; t++) sel.append(el('option', { value: t, text: 'Table ' + t }));
    show('Picker');
  }).catch(function (e) { banner('error', 'Couldn\'t load the menu. ' + e.message); });
})();
