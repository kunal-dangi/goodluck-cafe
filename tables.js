// Printable table QR cards.
(function () {
  'use strict';
  var base = document.getElementById('base'), count = document.getElementById('count'), cards = document.getElementById('cards');
  base.value = location.origin;
  function build() {
    var root = base.value.trim().replace(/\/+$/, '');
    var n = Math.max(1, Math.min(100, parseInt(count.value, 10) || 1));
    document.getElementById('localWarn').hidden = !/localhost|127\.0\.0\.1|^https?:\/\/(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(root);
    cards.replaceChildren();
    for (var t = 1; t <= n; t++) {
      var url = root + '/order.html?table=' + t;
      var card = document.createElement('article'); card.className = 'card';
      var logo = document.createElement('img'); logo.className = 'logo'; logo.src = 'images/logo.jpg'; logo.alt = '';
      var tbl = document.createElement('div'); tbl.className = 'tbl'; tbl.textContent = 'Table ' + t;
      var qr = document.createElement('div'); qr.className = 'qr'; qr.title = url;
      var cta = document.createElement('p'); cta.className = 'cta'; cta.textContent = 'Scan to see the menu & order';
      var small = document.createElement('p'); small.className = 'small'; small.textContent = 'Pay at the counter after your meal';
      card.append(logo, tbl, qr, cta, small);
      cards.append(card);
      new QRCode(qr, { text: url, width: 360, height: 360, colorDark: '#1f1a17', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    }
  }
  fetch('/api/menu').then(function (r) { return r.json(); }).then(function (m) { count.value = m.tables; })
    .catch(function () { count.value = 10; }).then(build);
  base.addEventListener('change', build);
  count.addEventListener('change', build);
  document.getElementById('print').addEventListener('click', function () { window.print(); });
})();
