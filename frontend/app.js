(function() {
  'use strict';

  // ── State ──
  var accessToken = null;
  var currentUser = null;
  var bundle = null;
  var currentView = null;
  var pendingEmail = null;
  var pendingFlow = null; // 'login' | 'signup'
  window.__pendingFlow = null;

  // ── Session Replay (rrweb) ──
  var _replaySessionId = null;
  var _replaySegmentId = null;
  var _replayStopFn = null;
  var _replayEventBuffer = [];
  var _replayFlushTimer = null;
  var _replayLastEventTime = 0;
  var _replayInactivityTimer = null;
  var _rrwebLoaded = false;
  var REPLAY_FLUSH_INTERVAL = 500; // flush events every 500ms for near-real-time shadow viewing
  var REPLAY_INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1 hour

  function loadRrweb(cb) {
    if (_rrwebLoaded && window.rrweb) { cb(); return; }
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.13/dist/rrweb.min.js';
    script.onload = function() { _rrwebLoaded = true; cb(); };
    script.onerror = function() { console.warn('[XRay Replay] Failed to load rrweb from CDN'); };
    document.head.appendChild(script);
  }

  function startReplaySession() {
    if (!currentUser || currentUser.is_platform_admin) return;
    if (!currentUser.replay_enabled) return; // tenant has replay disabled
    if (_replaySessionId) return; // already recording
    console.log('[XRay Replay] Starting session for', currentUser.email);

    loadRrweb(function() {
      if (!window.rrweb || !window.rrweb.record) { console.warn('[XRay Replay] rrweb not available after load'); return; }
      console.log('[XRay Replay] rrweb loaded, creating session...');

      // Create session on server
      var body = {
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
      api.post('/api/v1/replay/sessions', body).then(function(r) {
        if (!r.ok || !r.data) { console.warn('[XRay Replay] Failed to create session:', r.error || r); return; }
        console.log('[XRay Replay] Session created:', r.data.id || r.data.sessionId);
        _replaySessionId = r.data.id || r.data.sessionId;

        // Create initial segment — WAIT for it before starting recording
        var segType = detectSegmentType();
        var segBody = { segmentType: segType.type };
        if (segType.dashboardId) segBody.dashboardId = segType.dashboardId;
        api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments', segBody).then(function(sr) {
          if (sr.ok && sr.data) {
            _replaySegmentId = sr.data.id || sr.data.segmentId;
            _replayPrimarySegmentId = _replaySegmentId; // primary segment stores all events
            console.log('[XRay Replay] Segment created:', _replaySegmentId);
          }

          // Start rrweb recording AFTER segment ID is ready
          _replayStopFn = window.rrweb.record({
            emit: onRrwebEvent,
            recordCanvas: false,
            recordCrossOriginIframes: false,
            collectFonts: false,
            sampling: {
              mousemove: true,
              mouseInteraction: true,
              scroll: 150,
              input: 'last'
            }
          });

          // Start periodic flush
          _replayFlushTimer = setInterval(flushReplayEvents, REPLAY_FLUSH_INTERVAL);

          // Start inactivity timer
          resetInactivityTimer();
        }).catch(function() {});
      }).catch(function() {});
    });
  }

  function stopReplaySession() {
    if (_replayStopFn) { _replayStopFn(); _replayStopFn = null; }
    if (_replayFlushTimer) { clearInterval(_replayFlushTimer); _replayFlushTimer = null; }
    if (_replayInactivityTimer) { clearTimeout(_replayInactivityTimer); _replayInactivityTimer = null; }

    // Flush remaining events
    flushReplayEvents();

    // Close current segment
    if (_replaySegmentId && _replaySessionId) {
      api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments/' + _replaySegmentId + '/close').catch(function() {});
    }

    // Finalize session
    if (_replaySessionId) {
      api.post('/api/v1/replay/sessions/' + _replaySessionId + '/finalize').catch(function() {});
    }

    _replaySessionId = null;
    _replaySegmentId = null;
    _replayPrimarySegmentId = null;
    _replayEventBuffer = [];
  }

  function onRrwebEvent(event) {
    _replayEventBuffer.push(event);
    _replayLastEventTime = Date.now();
    resetInactivityTimer();
  }

  function flushReplayEvents() {
    if (_replayEventBuffer.length === 0) return;
    var flushSegId = _replayPrimarySegmentId || _replaySegmentId;
    if (!_replaySessionId || !flushSegId) return;

    var events = _replayEventBuffer;
    _replayEventBuffer = [];

    // HTTP POST for reliable storage
    api.post('/api/v1/replay/sessions/' + _replaySessionId + '/events', {
      segmentId: flushSegId,
      events: events
    }).then(function(r) {
      if (!r.ok) console.error('[XRay Replay] Event store failed:', r);
    }).catch(function(err) {
      console.error('[XRay Replay] Event store error, re-buffering', err);
      _replayEventBuffer = events.concat(_replayEventBuffer);
    });

    // WS for shadow fan-out only
    if (window.__xrayWs && window.__xrayWs.readyState === WebSocket.OPEN) {
      try {
        window.__xrayWs.send(JSON.stringify({
          type: 'replay:events',
          data: { sessionId: _replaySessionId, segmentId: flushSegId, events: events }
        }));
      } catch(e) {}
    }
  }

  function detectSegmentType() {
    // Check dashboard viewer FIRST - it overlays the dashboard_list view
    var viewer = document.querySelector('.dash-fullview.active');
    if (viewer) {
      var dashId = viewer.dataset && viewer.dataset.dashboardId;
      if (dashId) return { type: 'dashboard', dashboardId: dashId };
    }
    // Otherwise it's a platform view
    return { type: 'platform', dashboardId: null };
  }

  // The primary segment ID used for all event storage — set once at session start
  var _replayPrimarySegmentId = null;

  function createReplaySegment(segType, dashboardId) {
    if (!_replaySessionId) return;
    var oldSegmentId = _replaySegmentId;
    // Flush events before switching
    if (oldSegmentId) {
      flushReplayEvents();
    }
    // Create new segment for metadata tracking, but keep storing events under primary segment
    var body = { segmentType: segType };
    if (dashboardId) body.dashboardId = dashboardId;
    api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments', body).then(function(r) {
      if (r.ok && r.data) {
        _replaySegmentId = r.data.id || r.data.segmentId;
        // First segment becomes the primary — all events stored here
        if (!_replayPrimarySegmentId) {
          _replayPrimarySegmentId = _replaySegmentId;
        }
        // Close the old segment
        if (oldSegmentId) {
          api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments/' + oldSegmentId + '/close').catch(function() {});
        }
      }
    }).catch(function() {});
  }

  function onReplaySegmentChange() {
    if (!_replaySessionId) return;
    var seg = detectSegmentType();
    createReplaySegment(seg.type, seg.dashboardId);
  }

  function resetInactivityTimer() {
    if (_replayInactivityTimer) clearTimeout(_replayInactivityTimer);
    _replayInactivityTimer = setTimeout(function() {
      // 1 hour of inactivity — end session, start new one if user becomes active
      stopReplaySession();
    }, REPLAY_INACTIVITY_TIMEOUT);
  }

  // ── Icons (simple SVG paths) ──
  var icons = {
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'credit-card': '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
  };

  function iconSvg(name) {
    var paths = icons[name] || icons.grid;
    return '<svg viewBox="0 0 24 24">' + paths + '</svg>';
  }

  // ── API helper ──
  var _refreshPromise = null; // mutex: only one refresh at a time
  var _lastRefreshTime = 0;   // debounce: skip refresh if one just completed
  var api = {
    _fetch: function(method, url, body) {
      var tokenAtCall = accessToken; // capture token at call time
      var opts = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      };
      if (accessToken) opts.headers['Authorization'] = 'Bearer ' + accessToken;
      if (body) opts.body = JSON.stringify(body);
      return fetch(url, opts).then(function(r) {
        if (r.status === 401 && tokenAtCall) {
          // If token already changed (another concurrent call refreshed), just retry
          if (accessToken && accessToken !== tokenAtCall) {
            opts.headers['Authorization'] = 'Bearer ' + accessToken;
            return fetch(url, opts).then(function(r2) { return r2.json().catch(function() { return { ok: false }; }); });
          }
          return api.refresh().then(function(ok) {
            if (!ok) {
              // Don't logout if token was updated by another path while we waited
              if (accessToken && accessToken !== tokenAtCall) {
                opts.headers['Authorization'] = 'Bearer ' + accessToken;
                return fetch(url, opts).then(function(r2) { return r2.json().catch(function() { return { ok: false }; }); });
              }
              logout(); return { ok: false, error: { message: 'Session expired' } };
            }
            opts.headers['Authorization'] = 'Bearer ' + accessToken;
            return fetch(url, opts).then(function(r2) { return r2.json().catch(function() { return { ok: false }; }); });
          });
        }
        return r.json().catch(function() { return { ok: r.ok }; });
      });
    },
    get: function(url) { return api._fetch('GET', url); },
    post: function(url, body) { return api._fetch('POST', url, body); },
    patch: function(url, body) { return api._fetch('PATCH', url, body); },
    put: function(url, body) { return api._fetch('PUT', url, body); },
    delete: function(url, body) { return api._fetch('DELETE', url, body); },
    refresh: function() {
      // Mutex: if a refresh is already in flight, return the same promise
      if (_refreshPromise) return _refreshPromise;
      // Debounce: if a refresh just completed < 5s ago, skip (token is fresh)
      if (Date.now() - _lastRefreshTime < 5000 && accessToken) {
        return Promise.resolve(true);
      }
      _refreshPromise = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          _refreshPromise = null;
          if (d.ok && d.data && d.data.accessToken) {
            accessToken = d.data.accessToken;
            _lastRefreshTime = Date.now();
            if (typeof reconnectWebSocket === 'function') reconnectWebSocket();
            return true;
          }
          return false;
        })
        .catch(function() { _refreshPromise = null; return false; });
      return _refreshPromise;
    }
  };

  // ── Toast ──
  function toast(msg, type) {
    type = type || 'info';
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(function() { el.remove(); }, 4000);
  }
  window.__xrayToast = toast;

  // ── Auth UI ──
  function showAuthErr(formId, msg) {
    var el = document.getElementById(formId);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  // Login
  document.getElementById('btn-login').onclick = function() {
    var email = document.getElementById('land-login-email').value.trim();
    if (!email) { showAuthErr('login-err', 'Email is required.'); return; }
    showAuthErr('login-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/magic-link', { email: email }).then(function(d) {
      btn.disabled = false;
      if (!d.ok) { showAuthErr('login-err', (d.error && d.error.message) || 'Failed to send code.'); return; }
      pendingEmail = email;
      pendingFlow = 'login';
      window.__pendingFlow = 'login';
      document.getElementById('verify-sub').textContent = 'We sent a 6-digit code to ' + email;
      showLandingForm('verify');
    }).catch(function() { btn.disabled = false; showAuthErr('login-err', 'Network error.'); });
  };

  document.getElementById('land-login-email').onkeydown = function(e) {
    if (e.key === 'Enter') document.getElementById('btn-login').click();
  };

  // Passkey login
  document.getElementById('btn-passkey-login').onclick = function() {
    if (!window.PublicKeyCredential) {
      showAuthErr('login-err', 'Passkeys are not supported in this browser.');
      return;
    }
    var btn = this;
    btn.disabled = true;
    showAuthErr('login-err', '');

    function b64urlToBytes(b64) {
      var s = b64.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      var bin = atob(s);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    function bytesToB64url(buf) {
      var arr = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    api.post('/api/auth/passkey/begin', {}).then(function(r) {
      if (!r.ok) {
        btn.disabled = false;
        showAuthErr('login-err', (r.error && r.error.message) || 'Failed to start passkey auth.');
        return;
      }
      var opts = r.data;
      var getOpts = {
        publicKey: {
          challenge: b64urlToBytes(opts.challenge),
          timeout: opts.timeout || 60000,
          rpId: opts.rpId,
          userVerification: opts.userVerification || 'preferred'
        }
      };
      if (opts.allowCredentials && opts.allowCredentials.length > 0) {
        getOpts.publicKey.allowCredentials = opts.allowCredentials.map(function(c) {
          return { id: b64urlToBytes(c.id), type: c.type || 'public-key', transports: c.transports };
        });
      }
      return navigator.credentials.get(getOpts);
    }).then(function(credential) {
      if (!credential) { btn.disabled = false; return; }
      var response = credential.response;
      var body = {
        id: credential.id,
        rawId: bytesToB64url(credential.rawId),
        type: credential.type,
        response: {
          authenticatorData: bytesToB64url(response.authenticatorData),
          clientDataJSON: bytesToB64url(response.clientDataJSON),
          signature: bytesToB64url(response.signature)
        }
      };
      if (response.userHandle) body.response.userHandle = bytesToB64url(response.userHandle);
      return api.post('/api/auth/passkey/complete', body);
    }).then(function(r) {
      btn.disabled = false;
      if (!r) return;
      if (r.ok && r.data && r.data.accessToken) {
        accessToken = r.data.accessToken;
        enterApp();
      } else {
        showAuthErr('login-err', (r.error && r.error.message) || 'Passkey verification failed.');
      }
    }).catch(function(err) {
      btn.disabled = false;
      if (err.name === 'NotAllowedError') {
        showAuthErr('login-err', 'Authentication cancelled.');
      } else {
        showAuthErr('login-err', 'Passkey error: ' + (err.message || 'Unknown'));
      }
    });
  };

  // Signup
  document.getElementById('btn-signup').onclick = function() {
    var name = document.getElementById('signup-name').value.trim();
    var email = document.getElementById('signup-email').value.trim();
    var org = document.getElementById('signup-org').value.trim();
    if (!name || !email || !org) { showAuthErr('signup-err', 'All fields are required.'); return; }
    showAuthErr('signup-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/signup', { name: name, email: email, tenantName: org }).then(function(d) {
      btn.disabled = false;
      if (!d.ok) { showAuthErr('signup-err', (d.error && d.error.message) || 'Signup failed.'); return; }
      pendingEmail = email;
      pendingFlow = 'signup';
      window.__pendingFlow = 'signup';
      document.getElementById('verify-sub').textContent = 'We sent a 6-digit code to ' + email;
      showLandingForm('verify');
    }).catch(function() { btn.disabled = false; showAuthErr('signup-err', 'Network error.'); });
  };

  // Signup Enter key
  ['signup-name', 'signup-email', 'signup-org'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.onkeydown = function(e) {
      if (e.key === 'Enter') document.getElementById('btn-signup').click();
    };
  });

  // First-boot setup
  document.getElementById('btn-setup').onclick = function() {
    var name = document.getElementById('setup-name').value.trim();
    var email = document.getElementById('setup-email').value.trim();
    var org = document.getElementById('setup-org').value.trim();
    if (!name) { showAuthErr('setup-err', 'Full name is required.'); document.getElementById('setup-name').focus(); return; }
    if (!email) { showAuthErr('setup-err', 'Admin email is required.'); document.getElementById('setup-email').focus(); return; }
    if (!org) { showAuthErr('setup-err', 'Organization name is required.'); document.getElementById('setup-org').focus(); return; }
    showAuthErr('setup-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/setup', { name: name, email: email, tenantName: org }).then(function(d) {
      btn.disabled = false;
      if (!d.ok) { showAuthErr('setup-err', (d.error && d.error.message) || 'Setup failed.'); return; }
      accessToken = d.data.accessToken;
      enterApp();
    }).catch(function() { btn.disabled = false; showAuthErr('setup-err', 'Network error.'); });
  };

  // Setup Enter key
  ['setup-name', 'setup-email', 'setup-org'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.onkeydown = function(e) {
      if (e.key === 'Enter') document.getElementById('btn-setup').click();
    };
  });

  // Verify
  document.getElementById('btn-verify').onclick = function() {
    var code = document.getElementById('verify-code').value.trim();
    if (!code) { showAuthErr('verify-err', 'Enter the 6-digit code.'); return; }
    showAuthErr('verify-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/verify', { email: pendingEmail, code: code }).then(function(d) {
      btn.disabled = false;
      if (!d.ok) { showAuthErr('verify-err', (d.error && d.error.message) || 'Invalid code.'); return; }
      // Multi-tenant: show tenant picker
      if (d.data.tenants && d.data.tenants.length > 1) {
        showTenantPicker(d.data.tenants, d.data.email);
        return;
      }
      accessToken = d.data.accessToken;
      enterApp();
    }).catch(function() { btn.disabled = false; showAuthErr('verify-err', 'Network error.'); });
  };

  document.getElementById('verify-code').onkeydown = function(e) {
    if (e.key === 'Enter') document.getElementById('btn-verify').click();
  };

  // Tenant picker for multi-tenant users
  function showTenantPicker(tenants, email) {
    showLandingForm('tenant-picker');
    var list = document.getElementById('tenant-picker-list');
    var html = '';
    tenants.forEach(function(t) {
      var roleLabel = t.role === 'owner' ? 'Owner' : t.role === 'admin' ? 'Admin' : t.role === 'platform_admin' ? 'Platform Admin' : 'Member';
      html += '<button class="tenant-picker-btn" data-tid="' + t.id + '">';
      html += '<span class="tp-name">' + (t.name || 'Unnamed').replace(/</g, '&lt;') + '</span>';
      html += '<span class="tp-role">' + roleLabel + '</span>';
      html += '</button>';
    });
    list.innerHTML = html;
    list.querySelectorAll('.tenant-picker-btn').forEach(function(btn) {
      btn.onclick = function() {
        var tid = this.getAttribute('data-tid');
        showAuthErr('tenant-picker-err', '');
        list.querySelectorAll('.tenant-picker-btn').forEach(function(b) { b.disabled = true; });
        api.post('/api/auth/select-tenant', { email: email, tenantId: tid }).then(function(d) {
          list.querySelectorAll('.tenant-picker-btn').forEach(function(b) { b.disabled = false; });
          if (!d.ok) { showAuthErr('tenant-picker-err', (d.error && d.error.message) || 'Failed to select organization.'); return; }
          accessToken = d.data.accessToken;
          enterApp();
        }).catch(function() {
          list.querySelectorAll('.tenant-picker-btn').forEach(function(b) { b.disabled = false; });
          showAuthErr('tenant-picker-err', 'Network error.');
        });
      };
    });
  }

  // ── Check magic link token in URL ──
  function checkUrlToken() {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token');
    if (!token) return false;
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    document.getElementById('landing-screen').style.display = 'none';
    api.post('/api/auth/verify-token', { token: token }).then(function(d) {
      if (d.ok && d.data) {
        if (d.data.tenants && d.data.tenants.length > 1) {
          document.getElementById('landing-screen').style.display = '';
          openModal('tenant-picker');
          showTenantPicker(d.data.tenants, d.data.email);
          return;
        }
        if (d.data.accessToken) {
          accessToken = d.data.accessToken;
          enterApp();
        }
      }
    });
    return true;
  }

  // ── Enter app ──
  function enterApp() {
    document.getElementById('landing-screen').style.display = 'none';
    closeModal();
    document.getElementById('app-shell').style.display = 'block';

    api.get('/api/users/me').then(function(d) {
      if (!d.ok) { logout(); return; }
      currentUser = d.data;
      document.getElementById('user-name').textContent = currentUser.name || currentUser.email;
      buildSidebar();
      buildMobileNav();
      loadBundle();
      // Prompt for passkey setup on first login (no passkeys registered yet)
      promptPasskeySetup();
      // Load tenant switcher for multi-tenant users
      loadTenantSwitcher();
      // Start proactive token refresh to prevent silent logout
      startTokenRefresh();
      // Start WebSocket for real-time updates (all users)
      if (!currentUser.is_platform_admin) { connectWebSocket(); subscribeToPush(); }
      // Platform admins also need WebSocket for live session shadow viewing
      if (currentUser.is_platform_admin) { connectWebSocket(); }
      // Start session replay recording (non-platform-admins only)
      startReplaySession();
      // Also try to start recording when user returns to the tab (covers page refresh edge cases)
      document.addEventListener('visibilitychange', function() {
        if (!document.hidden && currentUser && !_replaySessionId) startReplaySession();
      });
      // Check if we were opened from a push notification with a meet-join hash
      checkMeetJoinHash();
      // Also listen for hash changes (when SW navigates an existing client to a meet-join hash)
      window.addEventListener('hashchange', function() { checkMeetJoinHash(); });
    });
  }

  function promptPasskeySetup() {
    if (!window.PublicKeyCredential) return;
    // Check if user already has passkeys
    api.get('/api/users/me/passkeys').then(function(r) {
      if (!r.ok) return;
      var passkeys = r.data || [];
      if (passkeys.length > 0) return; // already has passkeys
      // Check if user already dismissed the prompt
      try { if (localStorage.getItem('xray_passkey_dismissed')) return; } catch(e) {}
      showPasskeyPrompt();
    }).catch(function() {});
  }

  function showPasskeyPrompt() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '8500';
    overlay.innerHTML = '<div class="modal" style="width:400px">'
      + '<div class="modal-head"><div class="modal-title">Set up passkey?</div></div>'
      + '<div class="modal-body"><p style="font-size:14px;color:var(--t2);margin-bottom:16px">Passkeys let you sign in quickly and securely with your fingerprint, face, or device PIN. Would you like to set one up now?</p></div>'
      + '<div class="modal-foot"><button class="btn" id="passkey-later">Later</button><button class="btn primary" id="passkey-setup-now">Set up now</button></div>'
      + '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#passkey-later').onclick = function() {
      try { localStorage.setItem('xray_passkey_dismissed', '1'); } catch(e) {}
      overlay.remove();
    };
    overlay.querySelector('#passkey-setup-now').onclick = function() {
      overlay.remove();
      window.location.hash = 'account';
    };
    overlay.onclick = function(e) {
      if (e.target === overlay) {
        try { localStorage.setItem('xray_passkey_dismissed', '1'); } catch(e) {}
        overlay.remove();
      }
    };
  }

  // ── Logout ──
  function logout() {
    stopReplaySession();
    stopTokenRefresh();
    if (typeof closeWebSocket === 'function') closeWebSocket();
    // Unsubscribe push notifications so the next user on this device doesn't get them
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(function(reg) {
          reg.pushManager.getSubscription().then(function(sub) {
            if (sub) {
              // Remove from server
              api.post('/api/meet/push/unsubscribe', { endpoint: sub.endpoint }).catch(function() {});
              sub.unsubscribe().catch(function() {});
            }
          });
        });
      }
    } catch(e) {}
    if (accessToken) api.post('/api/auth/logout').catch(function() {});
    accessToken = null;
    currentUser = null;
    currentView = null;
    document.getElementById('landing-screen').style.display = '';
    document.getElementById('app-shell').style.display = 'none';
    closeModal();
  }
  document.getElementById('btn-logout').onclick = logout;

  // Finalize replay session on tab close
  window.addEventListener('beforeunload', function() {
    if (_replaySessionId && accessToken) {
      // Use beacon endpoint: includes token + last events in body (no auth header needed)
      var beaconBody = { token: accessToken };
      if (_replayEventBuffer.length > 0 && _replaySegmentId) {
        beaconBody.segmentId = _replaySegmentId;
        beaconBody.events = _replayEventBuffer;
        _replayEventBuffer = [];
      }
      try {
        navigator.sendBeacon('/api/v1/replay/sessions/' + _replaySessionId + '/beacon',
          new Blob([JSON.stringify(beaconBody)], { type: 'application/json' }));
      } catch(e) {
        // Fallback to sync XHR
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/v1/replay/sessions/' + _replaySessionId + '/finalize', false);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
          xhr.send('{}');
        } catch(e2) {}
      }
    }
  });
  document.getElementById('header-logo').onclick = function() { if (accessToken) navigateTo('dashboard_list'); };
  window.logout = logout;
  window.getAccessToken = function() { return accessToken; };
  window.onReplaySegmentChange = onReplaySegmentChange;

  // ── Proactive token refresh ──
  // Access tokens expire in 15min. Refresh every 12min to avoid silent expiry.
  var _refreshInterval = null;
  var _refreshFailures = 0;
  function startTokenRefresh() {
    stopTokenRefresh();
    _refreshFailures = 0;
    _refreshInterval = setInterval(function() {
      if (!accessToken) return;
      api.refresh().then(function(ok) {
        if (ok) { _refreshFailures = 0; return; }
        _refreshFailures++;
        // Only logout after 3 consecutive failures (avoids transient errors)
        if (_refreshFailures >= 3 && accessToken) { logout(); }
      });
    }, 12 * 60 * 1000); // 12 minutes
  }
  function stopTokenRefresh() {
    if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
  }
  // Refresh when user returns to tab (may have been away > 15min)
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && accessToken) {
      api.refresh().then(function(ok) {
        if (ok) { _refreshFailures = 0; return; }
        // Retry once after 2 seconds before giving up
        setTimeout(function() {
          if (!accessToken) return;
          api.refresh().then(function(ok2) {
            if (ok2) { _refreshFailures = 0; return; }
            if (accessToken) logout();
          });
        }, 2000);
      });
    }
  });

  // ── Tenant Switcher ──
  function loadTenantSwitcher() {
    var switcher = document.getElementById('tenant-switcher');
    if (!switcher) return;
    api.get('/api/users/me/tenants').then(function(d) {
      if (!d.ok || !d.data || d.data.length <= 1) {
        switcher.style.display = 'none';
        return;
      }
      var tenants = d.data;
      var currentTid = currentUser.tenant_id;
      var currentTenant = tenants.filter(function(t) { return t.id === currentTid; })[0];
      if (!currentTenant) { switcher.style.display = 'none'; return; }

      switcher.style.display = '';
      document.getElementById('tenant-switcher-name').textContent = currentTenant.name;

      var dropdown = document.getElementById('tenant-switcher-dropdown');
      var html = '';
      tenants.forEach(function(t) {
        var isCurrent = t.id === currentTid;
        var roleLabel = t.role === 'owner' ? 'Owner' : t.role === 'admin' ? 'Admin' : t.role === 'platform_admin' ? 'Platform Admin' : 'Member';
        html += '<button class="ts-option' + (isCurrent ? ' current' : '') + '" data-tid="' + t.id + '">';
        html += '<span class="ts-opt-name">' + (t.name || '').replace(/</g, '&lt;') + '</span>';
        html += '<span class="ts-opt-role">' + roleLabel + (isCurrent ? ' (current)' : '') + '</span>';
        html += '</button>';
      });
      dropdown.innerHTML = html;

      document.getElementById('tenant-switcher-btn').onclick = function(e) {
        e.stopPropagation();
        var open = dropdown.style.display !== 'none';
        dropdown.style.display = open ? 'none' : '';
      };

      dropdown.querySelectorAll('.ts-option').forEach(function(btn) {
        btn.onclick = function() {
          var tid = this.getAttribute('data-tid');
          if (tid === currentTid) { dropdown.style.display = 'none'; return; }
          dropdown.style.display = 'none';
          toast('Switching organization...', 'info');
          api.post('/api/users/me/switch-tenant', { tenantId: tid }).then(function(d) {
            if (!d.ok) { toast((d.error && d.error.message) || 'Failed to switch', 'error'); return; }
            accessToken = d.data.accessToken;
            currentView = null;
            document.getElementById('view-container').innerHTML = '';
            enterApp();
          }).catch(function() { toast('Network error', 'error'); });
        };
      });

      // Close dropdown when clicking elsewhere
      document.addEventListener('click', function() { dropdown.style.display = 'none'; });

      // Mobile tenant switcher
      var mobSwitcher = document.getElementById('mob-tenant-switcher');
      if (mobSwitcher) {
        mobSwitcher.style.display = '';
        document.getElementById('mob-tenant-switcher-name').textContent = currentTenant.name;
        var mobDropdown = document.getElementById('mob-tenant-switcher-dropdown');
        mobDropdown.innerHTML = html;
        document.getElementById('mob-tenant-switcher-btn').onclick = function(e) {
          e.stopPropagation();
          var open = mobDropdown.style.display !== 'none';
          mobDropdown.style.display = open ? 'none' : '';
        };
        mobDropdown.querySelectorAll('.ts-option').forEach(function(btn) {
          btn.onclick = function() {
            var tid = this.getAttribute('data-tid');
            if (tid === currentTid) { mobDropdown.style.display = 'none'; return; }
            mobDropdown.style.display = 'none';
            if (window._closeMobileMenu) window._closeMobileMenu();
            toast('Switching organization...', 'info');
            api.post('/api/users/me/switch-tenant', { tenantId: tid }).then(function(d) {
              if (!d.ok) { toast((d.error && d.error.message) || 'Failed to switch', 'error'); return; }
              accessToken = d.data.accessToken;
              currentView = null;
              document.getElementById('view-container').innerHTML = '';
              enterApp();
            }).catch(function() { toast('Network error', 'error'); });
          };
        });
      }
    }).catch(function() { switcher.style.display = 'none'; });
  }

  // ── Build sidebar ──
  function buildSidebar() {
    if (!bundle || !bundle.nav) return;
    var sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = '';
    var sections = {};
    var userPerms = [];
    if (currentUser && currentUser.permissions) userPerms = currentUser.permissions;
    var isAdmin = currentUser && currentUser.is_platform_admin;

    // Add collapse toggle at top
    var toggleWrap = document.createElement('div');
    toggleWrap.className = 'sidebar-toggle';
    var toggleBtn = document.createElement('button');
    toggleBtn.title = 'Toggle sidebar';
    toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="1.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    toggleBtn.onclick = function() {
      sidebar.classList.toggle('collapsed');
      try { localStorage.setItem('xray_sidebar', sidebar.classList.contains('collapsed') ? '1' : '0'); } catch(e) {}
    };
    toggleWrap.appendChild(toggleBtn);
    sidebar.appendChild(toggleWrap);

    // Restore collapse state
    try {
      if (localStorage.getItem('xray_sidebar') === '1') sidebar.classList.add('collapsed');
    } catch(e) {}

    bundle.nav.forEach(function(item) {
      if (!isAdmin && item.permission && userPerms.indexOf(item.permission) === -1) return;
      // Hide billing nav for members without billing permission
      if (item.view === 'billing' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_billing) return;
      // Hide team nav for members without admin permission
      if (item.view === 'team' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide connections nav for members without admin permission
      if (item.view === 'connections' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide session replay nav if tenant doesn't have replay visible, or user lacks replay permission
      if (item.view === 'session_replay' && !isAdmin && currentUser && (!currentUser.replay_visible || (!currentUser.is_owner && !currentUser.has_replay))) return;
      var sec = item.section || 'main';
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(item);
    });

    var sectionLabels = {
      main: '', manage: 'Manage', account: 'Account', platform: 'Platform', config: 'Configuration', system: 'System'
    };
    var order = ['main', 'manage', 'account', 'platform', 'config', 'system'];

    order.forEach(function(sec) {
      if (!sections[sec] || sections[sec].length === 0) return;
      if (sectionLabels[sec]) {
        var label = document.createElement('div');
        label.className = 'nav-section';
        label.textContent = sectionLabels[sec];
        sidebar.appendChild(label);
      }
      sections[sec].forEach(function(item) {
        var el = document.createElement('div');
        el.className = 'nav-item';
        el.setAttribute('data-view', item.view);
        var badgeHtml = item.view === 'inbox' ? '<span class="nav-badge" id="inbox-badge" style="display:none"></span>' : '';
        el.innerHTML = iconSvg(item.icon || 'grid') + '<span>' + item.label + '</span>' + badgeHtml;
        el.onclick = function() { navigateTo(item.view); };
        sidebar.appendChild(el);
      });
    });

    // Show MEET header button if configured
    initMeetHeader();
    // Start inbox unread polling
    pollInboxUnread();
  }

  // ── Inbox unread count ──
  var _inboxPollTimer = null;
  function pollInboxUnread() {
    if (_inboxPollTimer) clearInterval(_inboxPollTimer);
    fetchInboxUnread();
    _inboxPollTimer = setInterval(fetchInboxUnread, 60000); // poll every 60s
  }
  function fetchInboxUnread() {
    if (!accessToken) return;
    api.get('/api/inbox/unread').then(function(r) {
      if (!r.ok) return;
      var count = r.data && r.data.count ? r.data.count : 0;
      updateInboxBadge(count);
    }).catch(function() {});
  }
  function updateInboxBadge(count) {
    var badge = document.getElementById('inbox-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
    // Also update mobile drawer badge
    var mobBadge = document.getElementById('mob-inbox-badge');
    if (mobBadge) {
      if (count > 0) {
        mobBadge.textContent = count > 99 ? '99+' : String(count);
        mobBadge.style.display = '';
      } else {
        mobBadge.style.display = 'none';
      }
    }
  }
  window.__xrayRefreshInbox = function() { fetchInboxUnread(); };

  // ── Mobile nav ──
  function buildMobileNav() {
    if (!bundle || !bundle.nav) return;
    var drawerNav = document.getElementById('mob-drawer-nav');
    var overlay = document.getElementById('mobile-menu-overlay');
    var drawer = document.getElementById('mobile-menu-drawer');
    if (!drawerNav) return;

    // Populate drawer with full nav
    drawerNav.innerHTML = '';
    var sections = {};
    var userPerms = (currentUser && currentUser.permissions) || [];
    var isAdmin = currentUser && currentUser.is_platform_admin;
    bundle.nav.forEach(function(item) {
      if (!isAdmin && item.permission && userPerms.indexOf(item.permission) === -1) return;
      // Hide billing nav for members without billing permission
      if (item.view === 'billing' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_billing) return;
      // Hide team nav for members without admin permission
      if (item.view === 'team' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide connections nav for members without admin permission
      if (item.view === 'connections' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide session replay nav if tenant doesn't have replay visible, or user lacks replay permission
      if (item.view === 'session_replay' && !isAdmin && currentUser && (!currentUser.replay_visible || (!currentUser.is_owner && !currentUser.has_replay))) return;
      var sec = item.section || 'main';
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(item);
    });
    var sectionLabels = { main: '', manage: 'Manage', account: 'Account', platform: 'Platform', config: 'Configuration' };
    var order = ['main', 'manage', 'account', 'platform', 'config', 'system'];
    order.forEach(function(sec) {
      if (!sections[sec] || !sections[sec].length) return;
      if (sectionLabels[sec]) {
        var lbl = document.createElement('div');
        lbl.className = 'nav-section';
        lbl.textContent = sectionLabels[sec];
        drawerNav.appendChild(lbl);
      }
      sections[sec].forEach(function(item) {
        var el = document.createElement('div');
        el.className = 'nav-item';
        el.setAttribute('data-view', item.view);
        var mobBadgeHtml = item.view === 'inbox' ? '<span class="nav-badge" id="mob-inbox-badge" style="display:none"></span>' : '';
        el.innerHTML = iconSvg(item.icon || 'grid') + '<span>' + item.label + '</span>' + mobBadgeHtml;
        el.onclick = function() { closeMobileMenu(); navigateTo(item.view); };
        drawerNav.appendChild(el);
      });
    });

    // User name in drawer
    var mobName = document.getElementById('mob-user-name');
    if (mobName && currentUser) mobName.textContent = currentUser.name || currentUser.email;
    var mobLogout = document.getElementById('mob-logout');
    if (mobLogout) mobLogout.onclick = function() { closeMobileMenu(); logout(); };

    // Mobile nav buttons
    var mobDash = document.getElementById('mob-dashboards');
    if (mobDash) mobDash.onclick = function() { closeMobileMenu(); navigateTo('dashboard_list'); };

    var mobMeet = document.getElementById('mob-meet');
    if (mobMeet) mobMeet.onclick = function() {
      if (meetState.inCall) {
        // Toggle between minimized and fullscreen
        if (meetState.viewMode === 'minimized' || meetState.viewMode === null) {
          setMeetViewMode('fullscreen');
        } else {
          setMeetViewMode('minimized');
        }
      } else {
        handleMeetButtonClick();
      }
    };

    var mobEnd = document.getElementById('mob-meet-end');
    if (mobEnd) mobEnd.onclick = function() {
      endMeetCall();
    };

    var mobMenu = document.getElementById('mob-menu');
    if (mobMenu) mobMenu.onclick = function() {
      overlay.classList.add('open');
      drawer.classList.add('open');
    };

    // Close drawer
    var closeBtn = document.getElementById('mob-drawer-close');
    if (closeBtn) closeBtn.onclick = closeMobileMenu;
    if (overlay) overlay.onclick = closeMobileMenu;

    function closeMobileMenu() {
      overlay.classList.remove('open');
      drawer.classList.remove('open');
    }
    window._closeMobileMenu = closeMobileMenu;
  }

  // Update mobile drawer active state on navigation
  function updateMobileActive(viewName) {
    var items = document.querySelectorAll('#mob-drawer-nav .nav-item');
    items.forEach(function(el) {
      el.classList.toggle('active', el.getAttribute('data-view') === viewName);
    });
  }

  // ── Load bundle ──
  function loadBundle() {
    if (bundle) { onBundleReady(); return; }
    fetch('/bundles/general.json?v=' + Date.now()).then(function(r) { return r.json(); })
      .then(function(d) { bundle = d; buildSidebar(); buildMobileNav(); onBundleReady(); })
      .catch(function() { toast('Failed to load UI bundle', 'error'); });
  }

  function onBundleReady() {
    var hash = window.location.hash.replace('#', '').split('?')[0];
    // Skip meet-join hashes — they're handled by checkMeetJoinHash(), not the view router
    if (hash.indexOf('meet-join/') === 0) return;
    navigateTo(hash || 'dashboard_list');
  }

  // ── Navigate to view ──
  function navigateTo(viewName) {
    if (!bundle) return;
    currentView = viewName;
    // Preserve existing query params in hash if navigating to same view
    if (window.location.hash.split('?')[0].replace('#', '') !== viewName) {
      window.location.hash = viewName;
    }

    // Clean up any floating overlays/modals from previous views
    document.querySelectorAll('.modal-overlay').forEach(function(m) {
      if (m.id !== 'loginModal') m.remove();
    });
    // Clear full-viewport dashboard viewer state BEFORE checking segment type
    var hdrTitle = document.getElementById('header-center-title');
    if (hdrTitle) { hdrTitle.style.display = 'none'; hdrTitle.textContent = ''; }
    var sidebar = document.getElementById('sidebar');
    if (sidebar) { sidebar.style.display = ''; if (sidebar.dataset.dashCollapsed) { sidebar.classList.remove('collapsed'); delete sidebar.dataset.dashCollapsed; } }
    // Also explicitly remove active class from dashboard viewer
    var dashViewer = document.querySelector('.dash-fullview.active');
    if (dashViewer) { dashViewer.classList.remove('active'); dashViewer.innerHTML = ''; delete dashViewer.dataset.dashboardId; }

    // Notify replay of segment change (AFTER dashboard viewer is cleared)
    onReplaySegmentChange();

    // Clear inbox badge immediately when navigating to inbox
    if (viewName === 'inbox') {
      updateInboxBadge(0);
    }

    var items = document.querySelectorAll('#sidebar .nav-item');
    items.forEach(function(el) {
      el.classList.toggle('active', el.getAttribute('data-view') === viewName);
    });
    updateMobileActive(viewName);

    var container = document.getElementById('view-container');
    var viewDef = bundle.views[viewName];
    if (!viewDef) {
      container.innerHTML = '<div class="loading-view">View "' + viewName + '" is not available in this bundle.</div>';
      return;
    }

    container.innerHTML = viewDef.html;

    var oldStyle = document.getElementById('view-style');
    if (oldStyle) oldStyle.remove();
    if (viewDef.css) {
      var style = document.createElement('style');
      style.id = 'view-style';
      style.textContent = viewDef.css;
      document.head.appendChild(style);
    }

    if (viewDef.js) {
      try {
        var fn = new Function('container', 'api', 'user', viewDef.js + '\n' + getInitCall(viewName));
        fn(container, api, currentUser);
      } catch (e) {
        console.error('View JS error:', e);
      }
    }
  }

  function getInitCall(viewName) {
    var fnMap = {
      account: 'if(typeof initAccount==="function")initAccount(container,api,user);',
      billing: 'if(typeof initBilling==="function")initBilling(container,api,user);',
      team: 'if(typeof initTeam==="function")initTeam(container,api,user);',
      dashboard_list: 'if(typeof initDashboardList==="function")initDashboardList(container,api,user);',
      connections: 'if(typeof initConnections==="function")initConnections(container,api,user);',
      audit: 'if(typeof initAudit==="function")initAudit(container,api,user);',
      admin_tenants: 'if(typeof initAdminTenants==="function")initAdminTenants(container,api,user);',
      admin_dashboards: 'if(typeof initAdminDashboards==="function")initAdminDashboards(container,api,user);',
      admin_connections: 'if(typeof initAdminConnections==="function")initAdminConnections(container,api,user);',
      admin_roles: 'if(typeof initAdminRoles==="function")initAdminRoles(container,api,user);',
      admin_email: 'if(typeof initAdminEmail==="function")initAdminEmail(container,api,user);',
      admin_bundles: 'if(typeof initAdminBundles==="function")initAdminBundles(container,api,user);',
      admin_stripe: 'if(typeof initAdminStripe==="function")initAdminStripe(container,api,user);',
      admin_builder: 'if(typeof initBuilder==="function")initBuilder(container,api,user);',
      admin_settings: 'if(typeof initSettings==="function")initSettings(container,api,user);',
      admin_apikeys: 'if(typeof initApiKeys==="function")initApiKeys(container,api,user);',
      admin_meet: 'if(typeof initAdminMeet==="function")initAdminMeet(container,api,user);',
      admin_webhooks: 'if(typeof initWebhooks==="function")initWebhooks(container,api,user);',
      admin_audit: 'if(typeof initAdminAudit==="function")initAdminAudit(container,api,user);',
      admin_portability: 'if(typeof initAdminPortability==="function")initAdminPortability(container,api,user);',
      inbox: 'if(typeof initInbox==="function")initInbox(container,api,user);',
      files: 'if(typeof initFiles==="function")initFiles(container,api,user);',
      session_replay: 'if(typeof initSessionReplay==="function")initSessionReplay(container,api,user);',
      admin_replay: 'if(typeof initAdminReplay==="function")initAdminReplay(container,api,user);',
      admin_replay_config: 'if(typeof initReplayConfig==="function")initReplayConfig(container,api,user);'
    };
    return fnMap[viewName] || '';
  }

  // ── Hash routing ──
  window.onhashchange = function() {
    if (!accessToken) return;
    var hash = window.location.hash.replace('#', '').split('?')[0];
    if (hash && hash.indexOf('meet-join/') === 0) return; // handled by checkMeetJoinHash
    if (hash && hash !== currentView) navigateTo(hash);
  };

  // Mobile back button: close modals/drawers/sidebars before navigating back
  window.addEventListener('popstate', function(e) {
    // Close mobile menu drawer if open
    var drawer = document.getElementById('mobile-menu-drawer');
    if (drawer && drawer.classList.contains('open')) {
      if (window._closeMobileMenu) window._closeMobileMenu();
      e.preventDefault();
      return;
    }
    // Close any modal overlay
    var modals = document.querySelectorAll('.modal-overlay[style*="flex"], .modal-overlay.active');
    for (var i = 0; i < modals.length; i++) {
      if (modals[i].style.display === 'flex' || modals[i].classList.contains('active')) {
        modals[i].style.display = 'none';
        modals[i].classList.remove('active');
        return;
      }
    }
    // Close login modal if open
    var loginModal = document.getElementById('loginModal');
    if (loginModal && loginModal.classList.contains('active')) {
      if (window.closeModal) window.closeModal();
      return;
    }
    // Close meet panel
    var meetPanel = document.getElementById('meet-panel');
    if (meetPanel && meetPanel.style.display !== 'none') {
      meetPanel.style.display = 'none';
      return;
    }
    // Close mobile inbox thread view
    var inboxLayout = document.querySelector('.inbox-layout.mob-thread-open');
    if (inboxLayout) {
      inboxLayout.classList.remove('mob-thread-open');
      return;
    }
  });

  // ── Init ──
  function init() {
    if (checkUrlToken()) return;
    api.refresh().then(function(ok) {
      if (ok) {
        enterApp();
        return;
      }
      fetch('/api/auth/setup').then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok && d.data && d.data.setupRequired) {
          openModal('setup');
        }
      }).catch(function() {});
    });
  }

  // ── Meet system ──
  var meetState = {
    serverUrl: '',
    configured: false,
    roomCode: '',
    inCall: false,
    panelOpen: false,
    panelView: 'initial', // initial | new | join
    viewMode: null, // null | fullscreen | pip | minimized
    members: [],
    selectedMembers: [],
    inviteEmails: []
  };

  function generateRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var code = '';
    for (var i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
  }

  function getMeetJoinUrl(room) {
    return meetState.serverUrl + '/?room=' + encodeURIComponent(room);
  }

  function initMeetHeader() {
    var meetBtn = document.getElementById('btn-meet-header');
    if (!meetBtn) return;
    api.get('/api/meet/config').then(function(r) {
      if (!r.ok || !r.data || !r.data.configured) return;
      meetState.serverUrl = r.data.serverUrl.replace(/\/+$/, '');
      meetState.configured = true;
      meetBtn.style.display = '';
      meetBtn.onclick = handleMeetButtonClick;
      // Preload members
      api.get('/api/meet/members').then(function(mr) {
        if (mr.ok && mr.data) meetState.members = mr.data;
      }).catch(function() {});
      setupMeetPanel();
      setupMeetViewport();
      // Platform admin: WebSocket for incoming support calls
      if (currentUser && currentUser.is_platform_admin) {
        startSupportCallWebSocket();
      }
      // Restore active call after page refresh (within 8 hours)
      try {
        var saved = JSON.parse(sessionStorage.getItem('xray_meet_active') || 'null');
        if (saved && saved.roomCode && (Date.now() - saved.ts) < 8 * 60 * 60 * 1000) {
          launchMeetCall(saved.roomCode);
        }
      } catch(e) {}
    }).catch(function() {});
  }

  function handleMeetButtonClick() {
    if (meetState.inCall) {
      // End the call
      endMeetCall();
      return;
    }
    if (meetState.panelOpen) {
      closeMeetPanel();
    } else {
      openMeetPanel();
    }
  }

  function openMeetPanel() {
    var panel = document.getElementById('meet-panel');
    if (!panel) return;
    var btn = document.getElementById('btn-meet-header');
    if (btn) {
      // Desktop: position below the header button
      var rect = btn.getBoundingClientRect();
      panel.style.top = (rect.bottom + 8) + 'px';
      panel.style.right = '20px';
    }
    // On mobile the CSS override positions it at bottom:80px via !important
    panel.style.display = '';
    meetState.panelOpen = true;
    showMeetPanelView('initial');
  }

  function closeMeetPanel() {
    var panel = document.getElementById('meet-panel');
    if (panel) panel.style.display = 'none';
    meetState.panelOpen = false;
  }

  function showMeetPanelView(view) {
    meetState.panelView = view;
    var initial = document.getElementById('meet-panel-initial');
    var newP = document.getElementById('meet-panel-new');
    var joinP = document.getElementById('meet-panel-join');
    if (initial) initial.style.display = view === 'initial' ? '' : 'none';
    if (newP) newP.style.display = view === 'new' ? '' : 'none';
    if (joinP) joinP.style.display = view === 'join' ? '' : 'none';
    if (view === 'new') {
      meetState.roomCode = generateRoomCode();
      meetState.selectedMembers = [];
      meetState.inviteEmails = [];
      _meetMemberLimit = 10;
      var codeEl = document.getElementById('meet-room-code');
      if (codeEl) codeEl.textContent = meetState.roomCode;
      renderMemberList();
      renderEmailTags();
      var allBtn = document.getElementById('meet-select-all');
      if (allBtn) allBtn.classList.remove('active');
    }
  }

  var _meetMemberLimit = 10;

  function renderMemberList(filter) {
    var list = document.getElementById('meet-member-list');
    if (!list) return;
    list.innerHTML = '';
    var search = (filter || '').toLowerCase();
    var filtered = meetState.members.filter(function(m) {
      if (currentUser && m.id === currentUser.id) return false; // exclude self
      if (!search) return true;
      return (m.name && m.name.toLowerCase().indexOf(search) >= 0) || m.email.toLowerCase().indexOf(search) >= 0;
    });
    if (filtered.length === 0) {
      list.innerHTML = '<div style="padding:12px;font-size:13px;color:var(--t3);text-align:center">No members found</div>';
      return;
    }
    var showing = filtered.slice(0, _meetMemberLimit);
    showing.forEach(function(m) {
      var item = document.createElement('div');
      item.className = 'meet-member-item';
      if (meetState.selectedMembers.indexOf(m.id) >= 0) item.classList.add('selected');
      item.innerHTML = '<span class="meet-check">\u2713</span><span class="meet-member-name">' +
        escapeHtml(m.name || m.email) + '</span><span class="meet-member-email">' + escapeHtml(m.email) + '</span>';
      item.onclick = function() {
        var idx = meetState.selectedMembers.indexOf(m.id);
        if (idx >= 0) { meetState.selectedMembers.splice(idx, 1); }
        else { meetState.selectedMembers.push(m.id); }
        item.classList.toggle('selected');
        updateAllBtn();
      };
      list.appendChild(item);
    });
    // Load more button
    if (filtered.length > _meetMemberLimit) {
      var loadMore = document.createElement('div');
      loadMore.style.cssText = 'padding:8px;text-align:center;font-size:12px;color:var(--acc);cursor:pointer';
      loadMore.textContent = 'Load more (' + (filtered.length - _meetMemberLimit) + ' remaining)';
      loadMore.onclick = function() {
        _meetMemberLimit += 10;
        renderMemberList(filter);
      };
      list.appendChild(loadMore);
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function updateAllBtn() {
    var allBtn = document.getElementById('meet-select-all');
    if (!allBtn) return;
    var selectableCount = meetState.members.filter(function(m) {
      return !currentUser || m.id !== currentUser.id;
    }).length;
    allBtn.classList.toggle('active', meetState.selectedMembers.length >= selectableCount && selectableCount > 0);
  }

  function renderEmailTags() {
    var container = document.getElementById('meet-email-tags');
    if (!container) return;
    container.innerHTML = '';
    meetState.inviteEmails.forEach(function(email, i) {
      var tag = document.createElement('span');
      tag.className = 'meet-email-tag';
      tag.innerHTML = escapeHtml(email) + '<button title="Remove">&times;</button>';
      tag.querySelector('button').onclick = function() {
        meetState.inviteEmails.splice(i, 1);
        renderEmailTags();
      };
      container.appendChild(tag);
    });
  }

  function setupMeetPanel() {
    // Initial view buttons
    var optNew = document.getElementById('meet-opt-new');
    if (optNew) optNew.onclick = function() { showMeetPanelView('new'); };
    var optJoin = document.getElementById('meet-opt-join');
    if (optJoin) optJoin.onclick = function() { showMeetPanelView('join'); };

    // Share button
    var shareBtn = document.getElementById('meet-share-btn');
    if (shareBtn) shareBtn.onclick = function() {
      var url = getMeetJoinUrl(meetState.roomCode);
      if (navigator.share) {
        navigator.share({ title: 'Join XRay Meeting', url: url }).catch(function() {});
      } else {
        navigator.clipboard.writeText(url).then(function() {
          toast('Meeting link copied!', 'success');
        }).catch(function() {
          prompt('Copy the meeting link:', url);
        });
      }
    };

    // Select all button
    var allBtn = document.getElementById('meet-select-all');
    if (allBtn) allBtn.onclick = function() {
      var selectable = meetState.members.filter(function(m) {
        return !currentUser || m.id !== currentUser.id;
      });
      if (meetState.selectedMembers.length >= selectable.length) {
        meetState.selectedMembers = [];
      } else {
        meetState.selectedMembers = selectable.map(function(m) { return m.id; });
      }
      renderMemberList(document.getElementById('meet-member-search') ? document.getElementById('meet-member-search').value : '');
      updateAllBtn();
    };

    // Search
    var searchInput = document.getElementById('meet-member-search');
    if (searchInput) searchInput.oninput = function() { renderMemberList(this.value); };

    // Add email
    var addEmailBtn = document.getElementById('meet-add-email');
    var emailInput = document.getElementById('meet-email-input');
    function addEmail() {
      if (!emailInput) return;
      var email = emailInput.value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        toast('Enter a valid email', 'error'); return;
      }
      if (meetState.inviteEmails.indexOf(email) >= 0) {
        toast('Email already added', 'info'); return;
      }
      meetState.inviteEmails.push(email);
      emailInput.value = '';
      renderEmailTags();
    }
    if (addEmailBtn) addEmailBtn.onclick = addEmail;
    if (emailInput) emailInput.onkeydown = function(e) { if (e.key === 'Enter') addEmail(); };

    // Start meeting
    var startBtn = document.getElementById('meet-btn-start-new');
    if (startBtn) startBtn.onclick = function() {
      startBtn.disabled = true;
      startBtn.textContent = 'Starting...';
      api.post('/api/meet/rooms', { roomId: meetState.roomCode, displayName: 'XRay Meeting' }).then(function(r) {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Meeting';
        if (!r.ok) {
          toast('Failed to create meeting: ' + (r.error ? r.error.message : 'Unknown error'), 'error');
          return;
        }
        // Gather emails to invite
        var emails = meetState.inviteEmails.slice();
        meetState.selectedMembers.forEach(function(id) {
          var m = meetState.members.find(function(mm) { return mm.id === id; });
          if (m && emails.indexOf(m.email) < 0) emails.push(m.email);
        });
        // Send invites if any
        if (emails.length > 0) {
          var joinUrl = getMeetJoinUrl(meetState.roomCode);
          api.post('/api/meet/invite', {
            joinUrl: joinUrl, roomName: meetState.roomCode, emails: emails
          }).then(function(ir) {
            if (ir.ok) {
              var sent = ir.data.results.filter(function(r) { return r.sent; }).length;
              if (sent > 0) toast('Invite sent to ' + sent + ' participant' + (sent > 1 ? 's' : ''), 'success');
            }
          }).catch(function() {});
        }
        closeMeetPanel();
        launchMeetCall(meetState.roomCode);
      }).catch(function() {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Meeting';
        toast('Network error', 'error');
      });
    };

    // Join meeting
    var joinBtn = document.getElementById('meet-btn-join-room');
    if (joinBtn) joinBtn.onclick = function() {
      var codeInput = document.getElementById('meet-join-code');
      var code = codeInput ? codeInput.value.trim() : '';
      if (!code) { toast('Enter a room code', 'error'); return; }
      closeMeetPanel();
      meetState.roomCode = code;
      launchMeetCall(code);
    };
    var joinCodeInput = document.getElementById('meet-join-code');
    if (joinCodeInput) joinCodeInput.onkeydown = function(e) { if (e.key === 'Enter' && joinBtn) joinBtn.click(); };

    // XRay Support button (owners only)
    var supportBtn = document.getElementById('meet-opt-support');
    if (supportBtn) {
      if (!currentUser || (!currentUser.is_owner && !currentUser.is_platform_admin)) {
        supportBtn.style.display = 'none';
      } else {
        supportBtn.onclick = function() {
      supportBtn.disabled = true;
      supportBtn.textContent = 'Connecting...';
      api.post('/api/meet/support-call', {}).then(function(r) {
        supportBtn.disabled = false;
        supportBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>XRay Support';
        if (!r.ok) {
          toast('Failed to connect: ' + (r.error ? r.error.message : 'Unknown error'), 'error');
          return;
        }
        closeMeetPanel();
        launchMeetCall(r.data.roomCode);
        toast('Support call started. Waiting for XRay team...', 'info');
      }).catch(function() {
        supportBtn.disabled = false;
        supportBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>XRay Support';
        toast('Network error', 'error');
      });
    };
      } // end else (owner check)
    } // end if (supportBtn)

    // Close panel when clicking outside
    document.addEventListener('mousedown', function(e) {
      if (!meetState.panelOpen) return;
      var panel = document.getElementById('meet-panel');
      var btn = document.getElementById('btn-meet-header');
      if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
        closeMeetPanel();
      }
    });
  }

  function showMeetFallback(iframeWrap, url) {
    iframeWrap.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--t2);text-align:center;padding:20px">'
      + '<p style="font-size:15px">The MEET server blocked embedding in this page.<br>This usually means the MEET server needs to allow framing from this domain.</p>'
      + '<a href="' + url + '" target="_blank" rel="noopener" class="btn primary" style="font-size:15px;padding:12px 28px;text-decoration:none">Open meeting in new tab</a>'
      + '<p style="font-size:12px;color:var(--t3)">To fix embedding: configure your MEET server to set<br><code>X-Frame-Options: ALLOWALL</code> or remove the header entirely.</p>'
      + '</div>';
  }

  function launchMeetCall(room) {
    meetState.inCall = true;
    meetState.roomCode = room;
    // Persist active call so it survives page refresh
    try { sessionStorage.setItem('xray_meet_active', JSON.stringify({ roomCode: room, ts: Date.now() })); } catch(e) {}
    var params = new URLSearchParams({ room: room });
    if (currentUser && currentUser.name) params.set('name', currentUser.name);
    params.set('autojoin', 'true');
    params.set('hideEndCall', 'true');
    var url = meetState.serverUrl + '/?' + params.toString();

    var viewport = document.getElementById('meet-viewport');
    var iframeWrap = document.getElementById('meet-viewport-iframe');
    if (!viewport || !iframeWrap) return;
    iframeWrap.innerHTML = '<iframe src="' + url + '" allow="camera; microphone; display-capture; autoplay" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>';

    // Detect iframe load failure (X-Frame-Options blocking) and offer fallback
    var meetIframeEl = iframeWrap.querySelector('iframe');
    if (meetIframeEl) {
      meetIframeEl.addEventListener('load', function() {
        try {
          // If we CAN access contentDocument, the iframe is same-origin (about:blank = blocked)
          var doc = meetIframeEl.contentDocument;
          if (doc && (!doc.body || doc.body.children.length === 0 || doc.body.innerHTML.length < 50)) {
            showMeetFallback(iframeWrap, url);
          }
        } catch (e) {
          // Cross-origin SecurityError = MEET page loaded successfully (different origin)
        }
      });
      meetIframeEl.onerror = function() { showMeetFallback(iframeWrap, url); };
    }

    // Listen for end-call events from the iframe
    var meetIframe = iframeWrap.querySelector('iframe');
    if (meetIframe) {
      // Watch for iframe navigation (user clicks leave/end in the meeting UI)
      try {
        var checkInterval = setInterval(function() {
          if (!meetState.inCall) { clearInterval(checkInterval); return; }
          try {
            // If iframe navigated away from meeting or shows a "left" page
            var iframeSrc = meetIframe.contentWindow.location.href;
            if (iframeSrc && iframeSrc.indexOf('room=') === -1 && iframeSrc !== 'about:blank') {
              clearInterval(checkInterval);
              endMeetCall();
            }
          } catch(e) {
            // Cross-origin - can't check, that's ok
          }
        }, 2000);
        // Also listen for postMessage from meeting iframe
        window.addEventListener('message', function meetMsgHandler(e) {
          if (!meetState.inCall) { window.removeEventListener('message', meetMsgHandler); return; }
          var d = e.data;
          if (typeof d === 'string') {
            try { d = JSON.parse(d); } catch(ex) {}
          }
          if (d && (d.type === 'meeting-ended' || d.type === 'call-ended' || d.type === 'hangup' || d.event === 'meetingEnded' || d.event === 'participantLeft' && d.local)) {
            window.removeEventListener('message', meetMsgHandler);
            endMeetCall();
          }
        });
      } catch(e) {}
    }

    setMeetViewMode('fullscreen');
    updateMeetHeaderState();
    updateMobileMeetState();
  }

  function setMeetViewMode(mode) {
    meetState.viewMode = mode;
    var viewport = document.getElementById('meet-viewport');
    var roomIndicator = document.getElementById('meet-room-indicator');
    var minControls = document.getElementById('meet-minimized-controls');

    if (!viewport) return;

    if (mode === 'minimized') {
      viewport.style.display = 'none';
      viewport.className = 'meet-viewport';
      // Show minimized controls in header
      if (minControls) minControls.style.display = '';
      if (roomIndicator) { roomIndicator.style.display = ''; roomIndicator.textContent = meetState.roomCode; }
    } else if (mode === 'fullscreen' || mode === 'pip') {
      viewport.style.display = 'flex';
      viewport.className = 'meet-viewport mode-' + mode;
      // Reset any drag positioning for fullscreen
      if (mode === 'fullscreen') {
        viewport.style.left = ''; viewport.style.top = '';
        viewport.style.right = ''; viewport.style.bottom = '';
      }
      if (minControls) minControls.style.display = 'none';
      if (roomIndicator) { roomIndicator.style.display = ''; roomIndicator.textContent = meetState.roomCode; }
      var titleEl = viewport.querySelector('.meet-viewport-title');
      if (titleEl) titleEl.textContent = 'MEET \u2014 ' + meetState.roomCode;
    } else {
      viewport.style.display = 'none';
      viewport.className = 'meet-viewport';
      if (minControls) minControls.style.display = 'none';
      if (roomIndicator) roomIndicator.style.display = 'none';
    }
  }

  function endMeetCall() {
    meetState.inCall = false;
    meetState.roomCode = '';
    try { sessionStorage.removeItem('xray_meet_active'); } catch(e) {}
    var viewport = document.getElementById('meet-viewport');
    var iframeWrap = document.getElementById('meet-viewport-iframe');
    if (iframeWrap) iframeWrap.innerHTML = '';
    setMeetViewMode(null);
    updateMeetHeaderState();
    updateMobileMeetState();
  }

  // ── Platform admin: WebSocket for support calls ──
  var knownSupportCalls = {};
  var dismissedSupportCalls = (function() {
    try { return JSON.parse(localStorage.getItem('xray_dismissed_calls') || '{}'); } catch(e) { return {}; }
  })();
  function persistDismissedCalls() {
    // Clean entries older than 10 minutes to prevent unbounded growth
    var now = Date.now(), cleaned = {};
    Object.keys(dismissedSupportCalls).forEach(function(k) {
      if (now - dismissedSupportCalls[k] < 600000) cleaned[k] = dismissedSupportCalls[k];
    });
    dismissedSupportCalls = cleaned;
    try { localStorage.setItem('xray_dismissed_calls', JSON.stringify(dismissedSupportCalls)); } catch(e) {}
  }
  function dismissSupportCall(callId) {
    dismissedSupportCalls[callId] = Date.now();
    persistDismissedCalls();
  }
  var supportCallConfig = { ring_duration: 60, sound_enabled: true, vibration_enabled: true };
  var _ws = null;
  var _wsReconnectTimer = null;
  var _wsReconnectDelay = 1000;
  var _wsMaxDelay = 30000;
  var _wsIntentionalClose = false;

  // ── Push notification subscription ──
  function pushSubscribeWithKey() {
    // Actually subscribe to push after permission is granted
    api.get('/api/meet/push/vapid-key').then(function(r) {
      if (!r.ok || !r.data || !r.data.vapidPublicKey) return;
      var vapidKey = r.data.vapidPublicKey;
      navigator.serviceWorker.ready.then(function(reg) {
        reg.pushManager.getSubscription().then(function(sub) {
          if (sub) {
            // Already subscribed, ensure server knows
            api.post('/api/meet/push/subscribe', sub.toJSON()).catch(function() {});
            return;
          }
          // Convert VAPID key to Uint8Array
          var padding = '='.repeat((4 - vapidKey.length % 4) % 4);
          var base64 = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/');
          var raw = atob(base64);
          var arr = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: arr
          }).then(function(newSub) {
            api.post('/api/meet/push/subscribe', newSub.toJSON()).catch(function() {});
          }).catch(function(err) {
            console.warn('Push subscribe failed:', err);
          });
        });
      });
    }).catch(function() {});
  }

  function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      pushSubscribeWithKey();
    } else if (Notification.permission === 'default') {
      // On iOS (and best practice everywhere), permission must be requested
      // from a user gesture. Show an in-app prompt banner instead of auto-requesting.
      showPushPermissionBanner();
    }
  }

  function showPushPermissionBanner() {
    // Don't show if already dismissed this session
    try { if (sessionStorage.getItem('xray_push_dismissed')) return; } catch(e) {}
    // Don't show if one is already visible
    if (document.getElementById('push-perm-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'push-perm-banner';
    banner.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;background:#1a1d24;border:1px solid #3ee8b5;border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);max-width:420px;width:calc(100% - 32px);';
    banner.innerHTML =
      '<div style="flex:1;"><div style="color:#fff;font-weight:500;font-size:14px;margin-bottom:4px;">Enable Notifications</div>' +
      '<div style="color:#94a3b8;font-size:13px;">Get alerts for support calls and messages even when the app is closed.</div></div>' +
      '<div style="display:flex;gap:8px;flex-shrink:0;">' +
      '<button id="push-perm-allow" style="background:#3ee8b5;color:#08090c;border:none;border-radius:8px;padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer;">Enable</button>' +
      '<button id="push-perm-dismiss" style="background:transparent;color:#94a3b8;border:1px solid #333;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer;">Later</button>' +
      '</div>';
    document.body.appendChild(banner);
    document.getElementById('push-perm-allow').onclick = function() {
      // This click IS a user gesture — safe for iOS permission request
      Notification.requestPermission().then(function(perm) {
        if (perm === 'granted') pushSubscribeWithKey();
      });
      banner.remove();
    };
    document.getElementById('push-perm-dismiss').onclick = function() {
      try { sessionStorage.setItem('xray_push_dismissed', '1'); } catch(e) {}
      banner.remove();
    };
  }

  // Handle messages from Service Worker (e.g. join call from push notification)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function(evt) {
      if (evt.data && evt.data.type === 'meet-call-join') {
        var callId = evt.data.callId;
        var roomCode = evt.data.roomCode;
        var joinUrl = evt.data.joinUrl;
        // Answer the support call via API
        if (callId) {
          api.post('/api/meet/support-calls/' + callId + '/answer', {}).catch(function() {});
          dismissSupportCall(callId);
          var el = document.getElementById('sca-' + callId);
          if (el) { stopRinging(); el.remove(); }
        }
        // Join the meeting — wait for meetState to be configured if needed
        if (roomCode && meetState && meetState.configured) {
          closeMeetPanel();
          launchMeetCall(roomCode);
        } else if (roomCode && meetState && !meetState.configured) {
          // meetState not ready yet — poll briefly for it to configure
          var attempts = 0;
          var waitForMeet = setInterval(function() {
            attempts++;
            if (meetState.configured) {
              clearInterval(waitForMeet);
              closeMeetPanel();
              launchMeetCall(roomCode);
            } else if (attempts > 20) {
              clearInterval(waitForMeet);
              // Fallback: open external meet URL
              if (joinUrl) window.location.href = joinUrl;
            }
          }, 250);
        } else if (joinUrl) {
          window.location.href = joinUrl;
        }
      }
    });
  }

  // Handle hash-based meet join (from push notification opening the app)
  function checkMeetJoinHash() {
    var hash = window.location.hash;
    if (hash.indexOf('#meet-join/') !== 0) return;
    var rest = hash.substring('#meet-join/'.length);
    var parts = rest.split('?');
    var roomCode = parts[0];
    var params = new URLSearchParams(parts[1] || '');
    var callId = params.get('callId');
    var joinUrl = params.get('joinUrl');
    // Clear the hash so it doesn't re-trigger
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!roomCode && !joinUrl) return;
    // Answer the call and dismiss in-app alert
    if (callId) {
      api.post('/api/meet/support-calls/' + callId + '/answer', {}).catch(function() {});
      dismissSupportCall(callId);
      var el = document.getElementById('sca-' + callId);
      if (el) { stopRinging(); el.remove(); }
    }
    // Wait for meet to be configured, then join
    var attempts = 0;
    var waitForMeet = setInterval(function() {
      attempts++;
      if (meetState && meetState.configured && roomCode) {
        clearInterval(waitForMeet);
        closeMeetPanel();
        launchMeetCall(roomCode);
      } else if (attempts > 40) {
        clearInterval(waitForMeet);
        if (joinUrl) window.location.href = decodeURIComponent(joinUrl);
      }
    }, 250);
  }

  function startSupportCallWebSocket() {
    // Load support config
    api.get('/api/meet/support-config').then(function(r) {
      if (r.ok && r.data) supportCallConfig = r.data;
    }).catch(function() {});
    // Load any existing pending calls first
    api.get('/api/meet/support-calls').then(function(r) {
      if (!r.ok || !r.data) return;
      r.data.forEach(function(call) {
        if (knownSupportCalls[call.id]) return;
        if (dismissedSupportCalls[call.id]) return; // already dismissed by this user
        knownSupportCalls[call.id] = true;
        showSupportCallAlert(call);
      });
    }).catch(function() {});
    // Subscribe to push notifications for background alerts
    subscribeToPush();
    connectWebSocket();
  }

  function connectWebSocket() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
    if (!accessToken) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + '/ws?token=' + encodeURIComponent(accessToken);
    try { _ws = new WebSocket(wsUrl); } catch(e) { scheduleWsReconnect(); return; }
    window.__xrayWs = _ws;

    _ws.onopen = function() {
      _wsReconnectDelay = 1000;
    };

    _ws.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'support-call:new' && msg.data) {
          var call = msg.data;
          if (knownSupportCalls[call.id] || dismissedSupportCalls[call.id]) return;
          knownSupportCalls[call.id] = true;
          showSupportCallAlert(call);
          // System notification is handled by the service worker via push — no need to duplicate here
        } else if (msg.type === 'support-call:answered' && msg.data) {
          dismissSupportCall(msg.data.id);
          var el = document.getElementById('sca-' + msg.data.id);
          if (el) { stopRinging(); el.remove(); }
        } else if (msg.type === 'inbox:new-message' && msg.data) {
          // Update unread badge immediately
          if (typeof msg.data.unreadCount === 'number') {
            updateInboxBadge(msg.data.unreadCount);
          } else {
            fetchInboxUnread();
          }
          // Show toast notification (in-app only, not a system notification)
          if (window.__xrayToast) {
            window.__xrayToast(msg.data.senderName ? msg.data.senderName + ': ' + (msg.data.preview || 'New message') : 'New message in inbox', 'info');
          }
          // System notification is handled by service worker push — no duplicate here
          // If inbox view is currently open, refresh it
          if (window.__xrayRefreshInboxView) window.__xrayRefreshInboxView();
        } else if (msg.type === 'dashboard:access-granted' || msg.type === 'dashboard:access-revoked') {
          // Dashboard visibility changed - notify handler if registered
          if (window.__xrayDashWsHandler) {
            window.__xrayDashWsHandler(evt);
          }
        } else if (msg.type === 'team:member-joined' && msg.data) {
          if (window.__xrayToast) window.__xrayToast((msg.data.name || msg.data.email || 'Someone') + ' joined the team', 'info');
          if (window.__xrayRefreshTeamView) window.__xrayRefreshTeamView();
        } else if (msg.type === 'billing:updated' && msg.data) {
          // Billing gate changed — reload dashboard view to update access
          if (msg.data.gateChanged) {
            // Admin changed gate products — re-check billing silently
          } else if (msg.data.hasVision) {
            if (window.__xrayToast) window.__xrayToast('Subscription activated! Dashboard access granted.', 'success');
          } else if (msg.data.hasVision === false) {
            if (window.__xrayToast) window.__xrayToast('Subscription ended. Dashboard access has been revoked.', 'error');
          }
          // Refresh dashboard list view to re-check billing from server
          if (window.__xrayRefreshDashboardList) window.__xrayRefreshDashboardList();
          // Trigger a re-check of billing status for any active dashboard view
          if (window.__xrayBillingChanged) window.__xrayBillingChanged(msg.data);
        } else if (msg.type === 'user:permissions-changed' && msg.data) {
          // Permissions were updated by an admin — update currentUser and rebuild sidebar
          if (msg.data.has_admin !== undefined) currentUser.has_admin = msg.data.has_admin;
          if (msg.data.has_billing !== undefined) currentUser.has_billing = msg.data.has_billing;
          if (msg.data.role_name) currentUser.role_name = msg.data.role_name;
          buildSidebar();
          buildMobileNav();
          if (window.__xrayToast) window.__xrayToast('Your permissions have been updated', 'info');
        } else if (msg.type === 'team:member-joined' && msg.data) {
          if (window.__xrayToast) window.__xrayToast((msg.data.name || 'A new member') + ' has joined the team', 'success');
          if (window.__xrayRefreshTeamView) window.__xrayRefreshTeamView();
        } else if (msg.type === 'team:invitation-changed') {
          // Invitation created/revoked — refresh invitations list
          if (window.__xrayRefreshTeamView) window.__xrayRefreshTeamView();
        } else if (msg.type === 'replay:events' && msg.data && msg.data.events) {
          // Shadow view: forward events to the shadow player handler
          if (window.__xrayShadowHandler) window.__xrayShadowHandler(msg.data.events);
        }
      } catch(e) {}
    };

    _ws.onclose = function(evt) {
      _ws = null;
      window.__xrayWs = null;
      if (!_wsIntentionalClose) scheduleWsReconnect();
    };

    _ws.onerror = function() {
      // onclose will fire after this
    };
  }

  function scheduleWsReconnect() {
    if (_wsReconnectTimer) return;
    _wsReconnectTimer = setTimeout(function() {
      _wsReconnectTimer = null;
      connectWebSocket();
    }, _wsReconnectDelay);
    _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, _wsMaxDelay);
  }

  function reconnectWebSocket() {
    // Called after token refresh to reconnect with new token
    if (_ws) { _wsIntentionalClose = true; _ws.close(); _ws = null; _wsIntentionalClose = false; }
    _wsReconnectDelay = 1000;
    connectWebSocket();
  }

  function closeWebSocket() {
    _wsIntentionalClose = true;
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    if (_ws) { _ws.close(); _ws = null; }
    _wsIntentionalClose = false;
  }
  // Sound presets for MEET call alerts
  var RING_SOUNDS = {
    classic: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='sine';g.gain.setValueAtTime(0.15,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(880,0,0.2); beep(1100,0.25,0.2); beep(880,0.5,0.2);
    },
    urgent: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='square';g.gain.setValueAtTime(0.1,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(1200,0,0.15); beep(900,0.2,0.15); beep(1200,0.4,0.15); beep(900,0.6,0.15);
    },
    gentle: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='sine';g.gain.setValueAtTime(0.08,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(523,0,0.4); beep(659,0.5,0.4); beep(784,1.0,0.5);
    },
    chime: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='triangle';g.gain.setValueAtTime(0.12,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(1047,0,0.3); beep(1319,0.15,0.3); beep(1568,0.3,0.4);
    }
  };

  var _ringInterval = null;
  var _ringCtx = null;
  var _vibrationInterval = null;

  function stopRinging() {
    if (_ringInterval) { clearInterval(_ringInterval); _ringInterval = null; }
    if (_ringCtx) { try { _ringCtx.close(); } catch(e) {} _ringCtx = null; }
    if (_vibrationInterval) { clearInterval(_vibrationInterval); _vibrationInterval = null; }
    if (navigator.vibrate) try { navigator.vibrate(0); } catch(e) {}
  }

  function startRinging() {
    stopRinging();
    var soundName = supportCallConfig.sound || 'classic';
    var soundFn = RING_SOUNDS[soundName] || RING_SOUNDS.classic;
    // Play sound if enabled
    if (supportCallConfig.sound_enabled !== false) {
      try {
        _ringCtx = new (window.AudioContext || window.webkitAudioContext)();
        soundFn(_ringCtx, _ringCtx.currentTime);
        // Repeat every 3 seconds
        _ringInterval = setInterval(function() {
          if (_ringCtx) {
            try { soundFn(_ringCtx, _ringCtx.currentTime); } catch(e) { stopRinging(); }
          }
        }, 3000);
      } catch(e) {}
    }
    // Vibrate if enabled - repeat pattern
    if (supportCallConfig.vibration_enabled !== false && navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200, 100, 400]); } catch(e) {}
      _vibrationInterval = setInterval(function() {
        if (navigator.vibrate) try { navigator.vibrate([200, 100, 200, 100, 400]); } catch(e) {}
      }, 3000);
    }
  }

  function showSupportCallAlert(call) {
    var existing = document.getElementById('sca-' + call.id);
    if (existing) existing.remove();
    var alert = document.createElement('div');
    alert.id = 'sca-' + call.id;
    alert.className = 'support-call-alert';
    alert.innerHTML = '<div class="sca-title"><svg viewBox="0 0 24 24" width="18" height="18" stroke="#3b82f6" fill="none" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>Incoming Support Call</div>' +
      '<div class="sca-info"><strong>' + escapeHtml(call.caller_name || call.caller_email || 'User') + '</strong> from <strong>' + escapeHtml(call.tenant_name || 'Unknown') + '</strong></div>' +
      '<div class="sca-actions"><button class="sca-join">Join Call</button><button class="sca-dismiss">Dismiss</button></div>';
    document.body.appendChild(alert);
    alert.querySelector('.sca-join').onclick = function() { stopRinging(); joinSupportCall(call); alert.remove(); };
    alert.querySelector('.sca-dismiss').onclick = function() { stopRinging(); dismissSupportCall(call.id); alert.remove(); };
    // Auto-dismiss after configurable ring duration
    var ringMs = (supportCallConfig.ring_duration || 60) * 1000;
    setTimeout(function() { if (document.getElementById('sca-' + call.id)) { stopRinging(); dismissSupportCall(call.id); alert.remove(); } }, ringMs);
    // Start persistent ringing (sound + vibration)
    startRinging();
  }
  function joinSupportCall(call) {
    // Stop all ringing
    stopRinging();
    api.post('/api/meet/support-calls/' + call.id + '/answer', {}).catch(function() {});
    if (!meetState.configured) {
      window.open(call.join_url, '_blank');
      return;
    }
    closeMeetPanel();
    launchMeetCall(call.room_code);
  }

  function updateMeetHeaderState() {
    var btn = document.getElementById('btn-meet-header');
    if (!btn) return;
    btn.classList.toggle('in-call', meetState.inCall);
  }

  function updateMobileMeetState() {
    var mobMeet = document.getElementById('mob-meet');
    var mobEnd = document.getElementById('mob-meet-end');
    if (mobMeet) {
      mobMeet.classList.toggle('mob-meet-active', meetState.inCall);
    }
    if (mobEnd) {
      mobEnd.style.display = meetState.inCall ? '' : 'none';
    }
  }

  function setupMeetViewport() {
    // Viewport controls
    var vpMin = document.getElementById('meet-vp-minimize');
    var vpPip = document.getElementById('meet-vp-pip');
    var vpFs = document.getElementById('meet-vp-fullscreen');
    var vpClose = document.getElementById('meet-vp-close');
    if (vpMin) vpMin.onclick = function() { setMeetViewMode('minimized'); };
    if (vpPip) vpPip.onclick = function() { setMeetViewMode('pip'); };
    if (vpFs) vpFs.onclick = function() { setMeetViewMode('fullscreen'); };
    if (vpClose) vpClose.onclick = function() { endMeetCall(); };

    // Minimized header controls
    var minMin = document.getElementById('meet-min-minimize');
    var minPip = document.getElementById('meet-min-pip');
    var minFs = document.getElementById('meet-min-fullscreen');
    var minClose = document.getElementById('meet-min-close');
    if (minMin) minMin.onclick = function() { setMeetViewMode('minimized'); };
    if (minPip) minPip.onclick = function() { setMeetViewMode('pip'); };
    if (minFs) minFs.onclick = function() { setMeetViewMode('fullscreen'); };
    if (minClose) minClose.onclick = function() { endMeetCall(); };

    // Room indicator click to copy
    var roomIndicator = document.getElementById('meet-room-indicator');
    if (roomIndicator) roomIndicator.onclick = function() {
      var url = getMeetJoinUrl(meetState.roomCode);
      navigator.clipboard.writeText(url).then(function() {
        toast('Meeting link copied!', 'success');
      }).catch(function() {});
    };

    // Drag for PIP mode
    var viewport = document.getElementById('meet-viewport');
    if (viewport) {
      var bar = viewport.querySelector('.meet-viewport-bar');
      var dragging = false, startX, startY, origLeft, origTop;
      if (bar) {
        bar.addEventListener('mousedown', function(e) {
          if (e.target.closest('.meet-bar-btn')) return;
          if (meetState.viewMode !== 'pip') return;
          dragging = true;
          startX = e.clientX; startY = e.clientY;
          var rect = viewport.getBoundingClientRect();
          origLeft = rect.left; origTop = rect.top;
          e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
          if (!dragging) return;
          viewport.style.left = (origLeft + e.clientX - startX) + 'px';
          viewport.style.top = (origTop + e.clientY - startY) + 'px';
          viewport.style.right = 'auto'; viewport.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', function() { dragging = false; });
      }
    }
  }

  window.__xrayRefreshMeetWidget = function() { initMeetHeader(); };

  // ── Share page handler ──
  // When NGINX serves index.html for /share/:token, detect it and render share UI instead
  function handleSharePage() {
    var pathname = window.location.pathname;
    if (!pathname.match(/^\/share\/.+/)) return false;

    var token = pathname.split('/').pop();
    if (!token) return false;

    // Hide landing page entirely
    var landing = document.getElementById('landing-screen');
    if (landing) landing.style.display = 'none';

    // Build share page UI
    document.body.insertAdjacentHTML('afterbegin',
      '<div id="share-page" style="position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg,#08090c);color:var(--t1,#f0f1f4);overflow:hidden">' +
        '<div style="height:48px;flex-shrink:0;background:var(--bg2,#0f1117);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 20px;gap:12px">' +
          '<a href="/" style="text-decoration:none;display:flex;align-items:center;gap:4px">' +
            '<span style="width:28px;height:28px;display:flex;align-items:center;justify-content:center">' +
              '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:22px;height:22px">' +
                '<path d="M50 8 L62 28 A28 28 0 0 1 78 50 L98 50 A48 48 0 0 0 50 2 Z" fill="#3ee8b5"/>' +
                '<path d="M78 50 A28 28 0 0 1 62 72 L50 92 A48 48 0 0 0 98 50 Z" fill="#3ee8b5"/>' +
                '<path d="M62 72 A28 28 0 0 1 38 72 L50 50 Z" fill="#3ee8b5"/>' +
                '<path d="M38 72 L28 92 A48 48 0 0 1 2 50 L22 50 A28 28 0 0 0 38 72 Z" fill="#3ee8b5"/>' +
                '<path d="M22 50 A28 28 0 0 1 38 28 L50 8 A48 48 0 0 0 2 50 Z" fill="#3ee8b5"/>' +
                '<circle cx="50" cy="50" r="12" fill="#3ee8b5"/>' +
              '</svg>' +
            '</span>' +
            '<span style="font-size:18px;font-weight:700;letter-spacing:-0.02em"><span style="color:#fff">X</span><span style="color:#3ee8b5">Ray</span></span>' +
          '</a>' +
        '</div>' +
        '<div id="share-content" style="width:100%;flex:1;min-height:0;overflow:hidden">' +
          '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--t2,#8e91a0);gap:10px;font-size:14px">' +
            '<div class="spinner"></div> Loading dashboard...' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    // Check sessionStorage cache (30 min TTL)
    var cacheKey = 'xray_share_' + token;
    var cached = null;
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed.ts && (Date.now() - parsed.ts) < 30 * 60 * 1000) {
          cached = parsed.data;
        } else {
          sessionStorage.removeItem(cacheKey);
        }
      }
    } catch(e) {}

    if (cached) {
      renderShareDashboard(cached);
    } else {
      fetchShareDashboard(token, cacheKey);
    }
    return true;
  }

  function fetchShareDashboard(token, cacheKey) {
    fetch('/api/share/' + encodeURIComponent(token))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok) {
          showShareError((d.error && d.error.message) || 'This dashboard is no longer available.');
          return;
        }
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: d.data }));
        } catch(e) {}
        renderShareDashboard(d.data);
      })
      .catch(function() {
        showShareError('Failed to load dashboard. Please try again later.');
      });
  }

  function renderShareDashboard(data) {
    document.title = (data.name || 'Dashboard') + ' \u2014 XRay';
    var content = document.getElementById('share-content');
    if (!content) return;
    var iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts allow-forms allow-popups allow-same-origin';
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:#08090c';
    content.innerHTML = '';
    content.appendChild(iframe);
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#08090c;color:#f0f1f4}' + (data.css || '') + '</style></head><body>' + (data.html || '') + '<scr' + 'ipt>' + (data.js || '') + '</scr' + 'ipt></body></html>');
    doc.close();
  }

  function showShareError(msg) {
    var content = document.getElementById('share-content');
    if (!content) return;
    content.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--t2,#8e91a0);gap:12px;font-size:15px">' +
      '<svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="1" style="opacity:.3"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
      '<p>' + msg + '</p></div>';
  }

  // ── Document Viewer ──
  window.__xrayOpenViewer = function(fileUrl, fileName, mimeType) {
    // Remove existing viewer if any
    var existing = document.getElementById('xray-doc-viewer');
    if (existing) existing.remove();

    var ext = (fileName || '').split('.').pop().toLowerCase();
    mimeType = mimeType || '';

    // Determine content type
    var isImage = /^(jpg|jpeg|png|gif|svg|webp|bmp|ico)$/.test(ext) || mimeType.startsWith('image/');
    var isPdf = ext === 'pdf' || mimeType === 'application/pdf';
    var isCsv = ext === 'csv' || mimeType === 'text/csv';
    var isVideo = /^(mp4|webm|ogg|mov)$/.test(ext) || mimeType.startsWith('video/');
    var isAudio = /^(mp3|wav|ogg|flac|aac|m4a)$/.test(ext) || mimeType.startsWith('audio/');
    var isOffice = /^(doc|docx|ppt|pptx|xls|xlsx)$/.test(ext);
    var isText = /^(txt|log|json|xml|html|css|js|ts|py|rb|go|rs|java|c|cpp|h|sh|md|yaml|yml|toml|ini|cfg|conf|sql|env)$/.test(ext) || mimeType.startsWith('text/');

    // Build overlay
    var overlay = document.createElement('div');
    overlay.id = 'xray-doc-viewer';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;';

    // Top bar
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 20px;background:rgba(15,17,23,0.95);border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;';
    var nameEl = document.createElement('span');
    nameEl.textContent = fileName || fileUrl;
    nameEl.style.cssText = 'flex:1;font-size:14px;font-weight:500;color:#f0f1f4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font);';
    var btnStyle = 'padding:6px 14px;font-size:13px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#f0f1f4;cursor:pointer;font-family:var(--font);white-space:nowrap;';
    var openBtn = document.createElement('button');
    openBtn.textContent = 'Open in new tab';
    openBtn.style.cssText = btnStyle;
    openBtn.onmouseover = function() { openBtn.style.background = 'rgba(255,255,255,0.12)'; };
    openBtn.onmouseout = function() { openBtn.style.background = 'rgba(255,255,255,0.06)'; };
    openBtn.onclick = function() { window.open(tokenUrl, '_blank'); };
    var dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download';
    dlBtn.style.cssText = btnStyle;
    dlBtn.onmouseover = function() { dlBtn.style.background = 'rgba(255,255,255,0.12)'; };
    dlBtn.onmouseout = function() { dlBtn.style.background = 'rgba(255,255,255,0.06)'; };
    dlBtn.onclick = function() {
      var a = document.createElement('a');
      a.href = tokenUrl;
      a.download = fileName || 'file';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'width:32px;height:32px;border-radius:6px;border:none;background:transparent;color:#8e91a0;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;';
    closeBtn.onmouseover = function() { closeBtn.style.background = 'rgba(255,255,255,0.08)'; closeBtn.style.color = '#f0f1f4'; };
    closeBtn.onmouseout = function() { closeBtn.style.background = 'transparent'; closeBtn.style.color = '#8e91a0'; };
    closeBtn.onclick = function() { overlay.remove(); document.removeEventListener('keydown', escHandler); };
    bar.appendChild(nameEl);
    bar.appendChild(openBtn);
    bar.appendChild(dlBtn);
    bar.appendChild(closeBtn);
    overlay.appendChild(bar);

    // Content area
    var content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:20px;';
    content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading...</div>';
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // Escape key handler
    function escHandler(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    }
    document.addEventListener('keydown', escHandler);

    // Get a short-lived token for browser-direct access, then render content
    var fileId = fileUrl.replace(/.*\/uploads\//, '').replace('/download', '');
    var tokenUrl = fileUrl;
    var authHeaders = accessToken ? { 'Authorization': 'Bearer ' + accessToken } : {};
    api.post('/api/uploads/' + fileId + '/token', {}).then(function(r) {
      if (r.ok && r.data && r.data.token) {
        tokenUrl = fileUrl + '?token=' + r.data.token;
      }
    }).catch(function(){}).then(function() {
      // Use tokenUrl for elements that set src (browser fetches without JS headers)
      // Use authHeaders for JS fetch calls (CSV, text)
      content.innerHTML = '';
      if (isImage) {
        var img = document.createElement('img');
        img.src = tokenUrl;
        img.alt = fileName || '';
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;';
        content.appendChild(img);
      } else if (isPdf) {
        var iframe = document.createElement('iframe');
        iframe.src = tokenUrl;
        iframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:4px;background:#fff;';
        content.style.padding = '0';
        content.appendChild(iframe);
      } else if (isCsv) {
        content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading CSV...</div>';
        fetch(fileUrl, { headers: authHeaders, credentials: 'include' }).then(function(r) { return r.text(); }).then(function(text) {
          var lines = text.trim().split('\n');
          var html = '<div style="overflow:auto;width:100%;height:100%;"><table style="border-collapse:collapse;font-size:13px;font-family:var(--mono);width:100%;">';
          for (var i = 0; i < lines.length; i++) {
            var cells = lines[i].split(',');
            var tag = i === 0 ? 'th' : 'td';
            html += '<tr>';
            for (var j = 0; j < cells.length; j++) {
              var cellStyle = i === 0
                ? 'padding:8px 12px;text-align:left;border-bottom:2px solid rgba(62,232,181,0.3);color:#3ee8b5;font-weight:600;white-space:nowrap;background:rgba(15,17,23,0.8);position:sticky;top:0;'
                : 'padding:6px 12px;border-bottom:1px solid rgba(255,255,255,0.06);color:#f0f1f4;white-space:nowrap;';
              html += '<' + tag + ' style="' + cellStyle + '">' + cells[j].replace(/^"|"$/g, '') + '</' + tag + '>';
            }
            html += '</tr>';
          }
          html += '</table></div>';
          content.innerHTML = html;
        }).catch(function() {
          content.innerHTML = '<div style="color:#ef4444;font-size:14px;">Failed to load CSV file.</div>';
        });
      } else if (isVideo) {
        var video = document.createElement('video');
        video.src = tokenUrl;
        video.controls = true;
        video.autoplay = false;
        video.style.cssText = 'max-width:100%;max-height:100%;border-radius:4px;';
        content.appendChild(video);
      } else if (isAudio) {
        var audio = document.createElement('audio');
        audio.src = tokenUrl;
        audio.controls = true;
        audio.style.cssText = 'min-width:300px;';
        content.appendChild(audio);
      } else if (isOffice) {
        // Office Online and Google Docs viewers require a publicly accessible URL.
        // Since our files are behind auth, fetch the file as a blob and display it.
        var officeExts = { doc: true, docx: true, ppt: true, pptx: true, xls: true, xlsx: true };
        content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading document...</div>';
        content.style.padding = '0';
        fetch(fileUrl, { headers: authHeaders, credentials: 'include' }).then(function(r) {
          if (!r.ok) throw new Error('Failed to fetch');
          return r.blob();
        }).then(function(blob) {
          var blobUrl = URL.createObjectURL(blob);
          // Try Google Docs viewer with a public URL first, fall back to download
          var officeIframe = document.createElement('iframe');
          officeIframe.src = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(tokenUrl);
          officeIframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:4px;background:#fff;';
          officeIframe.setAttribute('allowfullscreen', 'true');
          // Detect load failure after timeout and show fallback
          var loadFailed = false;
          var fallbackTimer = setTimeout(function() {
            loadFailed = true;
            content.innerHTML = '';
            var fallbackMsg = document.createElement('div');
            fallbackMsg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:40px;';
            fallbackMsg.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48" stroke="#8e91a0" fill="none" stroke-width="1" style="opacity:.4"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
              '<p style="color:#f0f1f4;font-size:15px;text-align:center">This document type cannot be previewed inline.</p>' +
              '<p style="color:#8e91a0;font-size:13px">Use "Open in new tab" or "Download" to view it.</p>';
            content.appendChild(fallbackMsg);
          }, 8000);
          officeIframe.onload = function() {
            if (!loadFailed) clearTimeout(fallbackTimer);
          };
          content.innerHTML = '';
          content.appendChild(officeIframe);
        }).catch(function() {
          content.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:40px;">' +
            '<p style="color:#f0f1f4;font-size:15px">Could not load document preview.</p>' +
            '<p style="color:#8e91a0;font-size:13px">Use "Open in new tab" or "Download" to view it.</p></div>';
        });
      } else if (isText) {
        content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading...</div>';
        fetch(fileUrl, { headers: authHeaders, credentials: 'include' }).then(function(r) { return r.text(); }).then(function(text) {
          var pre = document.createElement('pre');
          pre.textContent = text;
          pre.style.cssText = 'width:100%;max-height:100%;overflow:auto;padding:20px;background:rgba(15,17,23,0.8);border:1px solid rgba(255,255,255,0.06);border-radius:8px;font-size:13px;font-family:var(--mono);color:#f0f1f4;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0;';
          content.innerHTML = '';
          content.appendChild(pre);
        }).catch(function() {
          content.innerHTML = '<div style="color:#ef4444;font-size:14px;">Failed to load file.</div>';
        });
      } else {
        var dl = document.createElement('a');
        dl.href = tokenUrl;
        dl.download = fileName || '';
        dl.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:rgba(62,232,181,0.1);border:1px solid rgba(62,232,181,0.3);border-radius:10px;color:#3ee8b5;font-size:15px;font-weight:500;text-decoration:none;font-family:var(--font);';
        dl.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download ' + (fileName || 'file');
        content.appendChild(dl);
      }
    });
  };

  // ── Invite page handler ──
  function handleInvitePage() {
    var pathname = window.location.pathname;
    if (!pathname.match(/^\/invite\/.+/)) return false;

    var token = pathname.split('/').pop();
    if (!token) return false;

    // Hide landing page
    var landing = document.getElementById('landing-screen');
    if (landing) landing.style.display = 'none';

    // Create invite accept UI
    var container = document.createElement('div');
    container.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg1,#0a0a0a);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
    container.innerHTML = '<div style="background:var(--bg2,#141414);border:1px solid var(--border,#222);border-radius:12px;padding:40px;max-width:400px;width:100%;text-align:center;">'
      + '<div style="margin-bottom:20px"><svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--acc,#10b981)" fill="none" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>'
      + '<h2 id="invite-title" style="color:var(--t1,#fff);font-size:20px;margin:0 0 8px">Accept Invitation</h2>'
      + '<p id="invite-desc" style="color:var(--t2,#888);font-size:14px;margin:0 0 24px">Loading invitation details...</p>'
      + '<div id="invite-form" style="display:none">'
      + '<div style="text-align:left;margin-bottom:12px"><label style="color:var(--t2,#888);font-size:13px;display:block;margin-bottom:4px">Email</label>'
      + '<input id="invite-email" type="email" readonly style="width:100%;padding:10px 12px;border:1px solid var(--border,#222);border-radius:6px;background:var(--bg3,#1a1a1a);color:var(--t2,#888);font-size:14px;box-sizing:border-box;" /></div>'
      + '<div style="text-align:left;margin-bottom:20px"><label style="color:var(--t2,#888);font-size:13px;display:block;margin-bottom:4px">Your Name</label>'
      + '<input id="invite-name" type="text" placeholder="Enter your name" autofocus style="width:100%;padding:10px 12px;border:1px solid var(--border,#222);border-radius:6px;background:var(--bg3,#1a1a1a);color:var(--t1,#fff);font-size:14px;box-sizing:border-box;" /></div>'
      + '<button id="invite-accept-btn" class="btn primary" style="width:100%;padding:12px;font-size:15px;border-radius:8px;">Join Team</button>'
      + '<p id="invite-err" style="color:#ef4444;font-size:13px;margin:12px 0 0;display:none"></p>'
      + '</div>'
      + '<div id="invite-invalid" style="display:none"><p style="color:#ef4444;font-size:14px">This invitation is no longer valid. It may have expired or already been used.</p>'
      + '<a href="/" style="color:var(--acc,#10b981);font-size:14px;text-decoration:none">Go to XRay</a></div>'
      + '</div>';
    document.body.appendChild(container);

    // Fetch invitation info
    fetch('/api/invitations/info/' + token)
      .then(function(r) { return r.json(); })
      .then(function(r) {
        if (!r.ok || !r.data || !r.data.valid) {
          document.getElementById('invite-desc').style.display = 'none';
          document.getElementById('invite-invalid').style.display = '';
          return;
        }
        var info = r.data;
        document.getElementById('invite-desc').textContent = 'You\'ve been invited to join ' + info.tenant_name;
        document.getElementById('invite-email').value = info.email;
        document.getElementById('invite-form').style.display = '';
        document.getElementById('invite-name').focus();

        // Accept handler
        document.getElementById('invite-accept-btn').onclick = function() {
          var name = document.getElementById('invite-name').value.trim();
          if (!name) {
            document.getElementById('invite-err').textContent = 'Please enter your name';
            document.getElementById('invite-err').style.display = '';
            return;
          }
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Joining...';
          document.getElementById('invite-err').style.display = 'none';

          fetch('/api/invitations/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ token: token, name: name })
          })
          .then(function(r) { return r.json(); })
          .then(function(r) {
            btn.disabled = false;
            btn.textContent = 'Join Team';
            if (!r.ok) {
              document.getElementById('invite-err').textContent = (r.error && r.error.message) || 'Failed to accept invitation';
              document.getElementById('invite-err').style.display = '';
              return;
            }
            // Auto-login: set token and redirect to app
            if (r.data && r.data.accessToken) {
              accessToken = r.data.accessToken;
              // Clean URL and enter app
              window.history.replaceState({}, '', '/');
              container.remove();
              enterApp();
            } else {
              // Fallback: redirect to login
              window.location.href = '/';
            }
          })
          .catch(function() {
            btn.disabled = false;
            btn.textContent = 'Join Team';
            document.getElementById('invite-err').textContent = 'Network error. Please try again.';
            document.getElementById('invite-err').style.display = '';
          });
        };

        // Enter key handler
        document.getElementById('invite-name').onkeydown = function(e) {
          if (e.key === 'Enter') document.getElementById('invite-accept-btn').click();
        };
      })
      .catch(function() {
        document.getElementById('invite-desc').style.display = 'none';
        document.getElementById('invite-invalid').style.display = '';
      });

    return true;
  }

  // Check if we're on a special page before running normal app init
  if (!handleSharePage() && !handleInvitePage()) {
    init();
  }
})();
