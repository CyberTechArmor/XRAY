(function() {
  'use strict';

  // ── State ──
  var accessToken = null;
  var currentUser = null;
  var bundle = null;
  var currentView = null;
  var pendingEmail = null;
  var pendingFlow = null; // 'login' | 'signup'

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
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>'
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
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  // Expose showForm globally so landing.js can call it
  window.showForm = function showForm(name) {
    document.getElementById('auth-login').style.display = name === 'login' ? '' : 'none';
    document.getElementById('auth-signup').style.display = name === 'signup' ? '' : 'none';
    document.getElementById('auth-setup').style.display = name === 'setup' ? '' : 'none';
    document.getElementById('auth-verify').style.display = name === 'verify' ? '' : 'none';
  };
  var showForm = window.showForm;

  document.getElementById('show-signup').onclick = function(e) { e.preventDefault(); showForm('signup'); };
  document.getElementById('show-login').onclick = function(e) { e.preventDefault(); showForm('login'); };
  document.getElementById('verify-back').onclick = function(e) { e.preventDefault(); showForm(pendingFlow || 'login'); };

  // Login
  document.getElementById('btn-login').onclick = function() {
    var email = document.getElementById('login-email').value.trim();
    if (!email) { showAuthErr('login-err', 'Email is required.'); return; }
    showAuthErr('login-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/magic-link', { email: email }).then(function(d) {
      btn.disabled = false;
      if (!d.ok) { showAuthErr('login-err', (d.error && d.error.message) || 'Failed to send code.'); return; }
      pendingEmail = email;
      pendingFlow = 'login';
      document.getElementById('verify-sub').textContent = 'We sent a 6-digit code to ' + email;
      showForm('verify');
    }).catch(function() { btn.disabled = false; showAuthErr('login-err', 'Network error.'); });
  };

  document.getElementById('login-email').onkeydown = function(e) {
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
      document.getElementById('verify-sub').textContent = 'We sent a 6-digit code to ' + email;
      showForm('verify');
    }).catch(function() { btn.disabled = false; showAuthErr('signup-err', 'Network error.'); });
  };

  // First-boot setup
  document.getElementById('btn-setup').onclick = function() {
    var name = document.getElementById('setup-name').value.trim();
    var email = document.getElementById('setup-email').value.trim();
    var org = document.getElementById('setup-org').value.trim();
    if (!name || !email || !org) { showAuthErr('setup-err', 'All fields are required.'); return; }
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
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'block';

    api.get('/api/users/me').then(function(d) {
      if (!d.ok) { logout(); return; }
      currentUser = d.data;
      document.getElementById('user-name').textContent = currentUser.name || currentUser.email;
      buildSidebar();
      loadBundle();
    });
  }

  // ── Logout ──
  function logout() {
    if (accessToken) api.post('/api/auth/logout').catch(function() {});
    accessToken = null;
    currentUser = null;
    currentView = null;
    document.getElementById('landing-screen').style.display = '';
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'none';
    showForm('login');
  }
  document.getElementById('btn-logout').onclick = logout;
  window.logout = logout;

  // ── Build sidebar ──
  function buildSidebar() {
    if (!bundle || !bundle.nav) return;
    var sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = '';
    var sections = {};
    var userPerms = [];
    if (currentUser && currentUser.permissions) userPerms = currentUser.permissions;
    var isAdmin = currentUser && currentUser.is_platform_admin;

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
  }

  // ── Load bundle ──
  function loadBundle() {
    if (bundle) { onBundleReady(); return; }
    fetch('/bundles/general.json?v=' + Date.now()).then(function(r) { return r.json(); })
      .then(function(d) { bundle = d; buildSidebar(); onBundleReady(); })
      .catch(function() { toast('Failed to load UI bundle', 'error'); });
  }

  function onBundleReady() {
    var hash = window.location.hash.replace('#', '');
    navigateTo(hash || 'dashboard_list');
  }

  // ── Navigate to view ──
  function navigateTo(viewName) {
    if (!bundle) return;
    currentView = viewName;
    window.location.hash = viewName;

    var items = document.querySelectorAll('#sidebar .nav-item');
    items.forEach(function(el) {
      el.classList.toggle('active', el.getAttribute('data-view') === viewName);
    });

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
      admin_audit: 'if(typeof initAdminAudit==="function")initAdminAudit(container,api,user);'
    };
    return fnMap[viewName] || '';
  }

  // ── Hash routing ──
  window.onhashchange = function() {
    if (!accessToken) return;
    var hash = window.location.hash.replace('#', '');
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
          document.getElementById('landing-screen').style.display = 'none';
          document.getElementById('auth-screen').style.display = '';
          showForm('setup');
        }
      }).catch(function() {});
    });
  }

  // ── Meet widget loader ──
  function loadMeetWidget() {
    if (!bundle || !bundle.views.meet_widget) return;
    var view = bundle.views.meet_widget;
    if (view.css && !document.getElementById('meet-widget-style')) {
      var s = document.createElement('style');
      s.id = 'meet-widget-style';
      s.textContent = view.css;
      document.head.appendChild(s);
    }
    if (view.js) {
      try {
        var existingFab = document.getElementById('xray-meet-fab');
        if (existingFab) existingFab.remove();
        var existingPopup = document.getElementById('xray-meet-popup');
        if (existingPopup) existingPopup.remove();
        var fn = new Function('api', 'user', view.js.replace(
          "if (document.getElementById('xray-meet-fab')) return;", ''
        ) + '\nif(typeof initMeetWidget==="function")initMeetWidget(api,user);');
        fn(api, currentUser);
      } catch (e) { console.error('Meet widget error:', e); }
    }
  }
  window.__xrayRefreshMeetWidget = function() { loadMeetWidget(); };

  var _origOnBundleReady = onBundleReady;
  onBundleReady = function() {
    _origOnBundleReady();
    loadMeetWidget();
  };

  init();
})();
