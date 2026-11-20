/* eslint-disable no-var */
/* Gate page: checks if the ordering server is reachable, then forwards or shows a calm down page.
   Vanilla JS, no libraries. Runs on GitHub Pages. */
(function () {
  'use strict';

  var NTFY_TOPIC = 'glc-9be741c9a43793e8f52e';
  var CHECK_INTERVAL = 15;    // seconds between re-checks when down
  var MAX_WAIT = 10 * 60;     // seconds: stop re-checking after 10 minutes
  var HEALTH_TIMEOUT = 4000;  // ms

  // DOM
  var stateChecking   = document.getElementById('state-checking');
  var stateForwarding = document.getElementById('state-forwarding');
  var stateDown       = document.getElementById('state-down');
  var statusEl        = document.getElementById('gate-status');
  var errorEl         = document.getElementById('gate-error');
  var checkAgainBtn   = document.getElementById('check-again');
  var signEl          = document.querySelector('.shop-sign');

  var liveUrl = null;
  var failCount = 0;
  var totalWaited = 0;
  var checkTimer = null;
  var countdownTimer = null;
  var alertSent = false;

  // ---- State management ----
  function showState(el) {
    [stateChecking, stateForwarding, stateDown].forEach(function (s) {
      s.classList.toggle('active', s === el);
    });
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setError(text) {
    if (errorEl) errorEl.textContent = text;
  }

  // ---- Settle the sign illustration ----
  if (signEl) {
    setTimeout(function () { signEl.classList.add('settled'); }, 100);
  }

  // ---- Parse incoming query string ----
  function getIncomingParams() {
    try {
      return new URLSearchParams(window.location.search);
    } catch (e) {
      return new URLSearchParams();
    }
  }

  // ---- Fetch live.json ----
  function fetchLive() {
    return fetch('live.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('live.json ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || typeof data.url !== 'string' || !data.url.startsWith('https://')) {
          throw new Error('live.json malformed');
        }
        return data.url.replace(/\/+$/, '');
      });
  }

  // ---- Fetch /api/health ----
  function fetchHealth(baseUrl) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, HEALTH_TIMEOUT);
    return fetch(baseUrl + '/api/health', {
      cache: 'no-store',
      signal: controller.signal
    })
      .then(function (r) {
        clearTimeout(timer);
        if (r.status !== 200) throw new Error('health ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error('health not ok');
        return true;
      })
      .catch(function (e) {
        clearTimeout(timer);
        throw e;
      });
  }

  // ---- Send ntfy alert ----
  function sendAlert() {
    if (alertSent) return;
    // Rate limit: one alert per browser per 10 minutes
    try {
      var last = localStorage.getItem('glc_gate_alert');
      if (last && Date.now() - Number(last) < 600000) return;
    } catch (e) { /* localStorage unavailable */ }

    alertSent = true;
    try {
      localStorage.setItem('glc_gate_alert', String(Date.now()));
    } catch (e) { /* ignore */ }

    try {
      fetch('https://ntfy.sh/' + NTFY_TOPIC, {
        method: 'POST',
        body: 'A customer just tried to order online and the ordering server is not reachable. Check the reception computer and the tunnel.',
        mode: 'no-cors'
      }).catch(function () {
        setError('Could not alert reception. Please call the cafe to order.');
      });
    } catch (e) {
      setError('Could not alert reception. Please call the cafe to order.');
    }
  }

  // ---- Forward the customer ----
  function forward(baseUrl) {
    showState(stateForwarding);
    var params = getIncomingParams();
    var target;
    if (params.has('table')) {
      target = baseUrl + '/order.html?table=' + encodeURIComponent(params.get('table'));
    } else {
      // Carry any other query string to online.html
      var qs = params.toString();
      target = baseUrl + '/online.html' + (qs ? '?' + qs : '');
    }
    location.replace(target);
  }

  // ---- Main check ----
  function check() {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    if (!stateDown.classList.contains('active')) {
      showState(stateChecking);
    }

    fetchLive()
      .then(function (url) {
        liveUrl = url;
        return fetchHealth(url);
      })
      .then(function () {
        // Server is up
        failCount = 0;
        setError('');
        forward(liveUrl);
      })
      .catch(function (err) {
        failCount++;
        if (err && err.message && err.message.indexOf('live.json') !== -1) {
          setError('Ordering configuration could not be loaded.');
        } else {
          setError('Ordering server is currently unreachable.');
        }
        if (failCount >= 2) {
          sendAlert();
        }
        showDown();
      });
  }

  // ---- Show the down page and start countdown ----
  function showDown() {
    showState(stateDown);
    if (totalWaited >= MAX_WAIT) {
      setStatus('We have been checking for 10 minutes. Please try again later or call the cafe.');
      return;
    }

    var remaining = CHECK_INTERVAL;
    setStatus('Checking again in ' + remaining + ' seconds');

    countdownTimer = setInterval(function () {
      remaining--;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        setStatus('Checking now\u2026');
      } else {
        setStatus('Checking again in ' + remaining + ' second' + (remaining === 1 ? '' : 's'));
      }
    }, 1000);

    checkTimer = setTimeout(function () {
      totalWaited += CHECK_INTERVAL;
      check();
    }, CHECK_INTERVAL * 1000);
  }

  // ---- Manual check again ----
  if (checkAgainBtn) {
    checkAgainBtn.addEventListener('click', function (e) {
      e.preventDefault();
      totalWaited = 0;
      failCount = 0;
      setStatus('Checking now\u2026');
      check();
    });
  }

  // ---- Start ----
  check();
})();
