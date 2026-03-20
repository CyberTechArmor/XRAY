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
  var api = {
    _fetch: function(method, url, body) {
      var opts = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      };
      if (accessToken) opts.headers['Authorization'] = 'Bearer ' + accessToken;
      if (body) opts.body = JSON.stringify(body);
      return fetch(url, opts).then(function(r) {
        if (r.status === 401 && accessToken) {
          return api.refresh().then(function(ok) {
            if (!ok) { logout(); return { ok: false, error: { message: 'Session expired' } }; }
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
      return fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok && d.data && d.data.accessToken) {
            accessToken = d.data.accessToken;
            return true;
          }
          return false;
        })
        .catch(function() { return false; });
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
      accessToken = d.data.accessToken;
      enterApp();
    }).catch(function() { btn.disabled = false; showAuthErr('verify-err', 'Network error.'); });
  };

  document.getElementById('verify-code').onkeydown = function(e) {
    if (e.key === 'Enter') document.getElementById('btn-verify').click();
  };

  // ── Check magic link token in URL ──
  function checkUrlToken() {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token');
    if (!token) return false;
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    document.getElementById('landing-screen').style.display = 'none';
    api.post('/api/auth/verify-token', { token: token }).then(function(d) {
      if (d.ok && d.data && d.data.accessToken) {
        accessToken = d.data.accessToken;
        enterApp();
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
    if (accessToken) api.post('/api/auth/logout').catch(function() {});
    accessToken = null;
    currentUser = null;
    currentView = null;
    document.getElementById('landing-screen').style.display = '';
    document.getElementById('app-shell').style.display = 'none';
    closeModal();
  }
  document.getElementById('btn-logout').onclick = logout;
  document.getElementById('header-logo').onclick = function() { if (accessToken) navigateTo('dashboard_list'); };
  window.logout = logout;
  window.getAccessToken = function() { return accessToken; };

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
        el.innerHTML = iconSvg(item.icon || 'grid') + '<span>' + item.label + '</span>';
        el.onclick = function() { navigateTo(item.view); };
        sidebar.appendChild(el);
      });
    });

    // Show MEET header button if configured
    initMeetHeader();
  }

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
        el.innerHTML = iconSvg(item.icon || 'grid') + '<span>' + item.label + '</span>';
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

    // Clear full-viewport dashboard viewer state
    var hdrTitle = document.getElementById('header-center-title');
    if (hdrTitle) { hdrTitle.style.display = 'none'; hdrTitle.textContent = ''; }
    var sidebar = document.getElementById('sidebar');
    if (sidebar) { sidebar.style.display = ''; if (sidebar.dataset.dashCollapsed) { sidebar.classList.remove('collapsed'); delete sidebar.dataset.dashCollapsed; } }

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
      inbox: 'if(typeof initInbox==="function")initInbox(container,api,user);'
    };
    return fnMap[viewName] || '';
  }

  // ── Hash routing ──
  window.onhashchange = function() {
    if (!accessToken) return;
    var hash = window.location.hash.replace('#', '').split('?')[0];
    if (hash && hash !== currentView) navigateTo(hash);
  };

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
    var code = 'xr-';
    for (var i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
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
    var btn = document.getElementById('btn-meet-header');
    if (!panel || !btn) return;
    // Position below the meet button
    var rect = btn.getBoundingClientRect();
    panel.style.top = (rect.bottom + 8) + 'px';
    panel.style.right = '20px';
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
      var codeEl = document.getElementById('meet-room-code');
      if (codeEl) codeEl.textContent = meetState.roomCode;
      renderMemberList();
      renderEmailTags();
      var allBtn = document.getElementById('meet-select-all');
      if (allBtn) allBtn.classList.remove('active');
    }
  }

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
    filtered.forEach(function(m) {
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

  function launchMeetCall(room) {
    meetState.inCall = true;
    meetState.roomCode = room;
    var params = new URLSearchParams({ room: room });
    if (currentUser && currentUser.name) params.set('name', currentUser.name);
    params.set('autojoin', 'true');
    var url = meetState.serverUrl + '/?' + params.toString();

    var viewport = document.getElementById('meet-viewport');
    var iframeWrap = document.getElementById('meet-viewport-iframe');
    if (!viewport || !iframeWrap) return;
    iframeWrap.innerHTML = '<iframe src="' + url + '" allow="camera; microphone; display-capture; autoplay" allowfullscreen></iframe>';

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
    var viewport = document.getElementById('meet-viewport');
    var iframeWrap = document.getElementById('meet-viewport-iframe');
    if (iframeWrap) iframeWrap.innerHTML = '';
    setMeetViewMode(null);
    updateMeetHeaderState();
    updateMobileMeetState();
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
      '<div id="share-page" style="min-height:100vh;background:var(--bg,#08090c);color:var(--t1,#f0f1f4)">' +
        '<div style="height:48px;background:var(--bg2,#0f1117);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 20px;gap:12px">' +
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
        '<div id="share-content" style="width:100%;height:calc(100vh - 48px)">' +
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

  // Check if we're on a share page before running normal app init
  if (!handleSharePage()) {
    init();
  }
})();
