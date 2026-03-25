var CACHE_NAME = 'xray-v5';
var SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/landing.css',
  '/landing.js',
  '/bundles/general.json',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/badge-96.svg'
];

// Install: cache app shell
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activate: clean old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch: network-first for API, cache-first for static
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // Network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) {
        // Update cache in background
        fetch(e.request).then(function(resp) {
          if (resp && resp.status === 200) {
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(e.request, resp);
            });
          }
        }).catch(function() {});
        return cached;
      }
      return fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return resp;
      });
    })
  );
});

// Push notifications
self.addEventListener('push', function(e) {
  var data = {};
  if (e.data) {
    try { data = e.data.json(); } catch (err) { data = { title: 'XRay', body: e.data.text() }; }
  }
  var title = data.title || 'XRay BI';
  var isMeetCall = data.data && data.data.type === 'meet-call';

  var options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.svg',
    tag: data.tag || 'xray-notification',
    data: data.data || data,
    renotify: true
  };

  // MEET call: persistent notification with actions, vibration, require interaction
  if (isMeetCall) {
    options.requireInteraction = true;
    options.actions = [
      { action: 'join', title: 'Join Call' },
      { action: 'dismiss', title: 'Dismiss' }
    ];
    // Vibration pattern: urgent ringing (long repeating pattern)
    if (data.vibrate) {
      options.vibrate = data.vibrate;
    } else {
      options.vibrate = [200, 100, 200, 100, 400, 200, 200, 100, 200, 100, 400];
    }
    // Silent: false to allow system sound
    options.silent = false;
  }

  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var data = e.notification.data || {};
  var tag = e.notification.tag || '';
  var action = e.action; // 'join' or 'dismiss' for action buttons

  // Handle MEET call notifications
  var isMeetCall = tag.indexOf('meet-call') === 0 || (data.type === 'meet-call');

  if (isMeetCall && action === 'dismiss') {
    // Just close the notification
    return;
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      // Find an existing app window
      var appClient = null;
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url.indexOf(self.location.origin) !== -1 && 'focus' in clients[i]) {
          appClient = clients[i];
          break;
        }
      }

      if (isMeetCall) {
        if (appClient) {
          // App is open — send message and focus
          appClient.postMessage({
            type: 'meet-call-join',
            callId: data.callId,
            roomCode: data.roomCode,
            joinUrl: data.joinUrl
          });
          return appClient.focus();
        }
        // App is NOT open — open the app with a hash route so it can auto-join on load
        var appUrl = '/#meet-join/' + (data.roomCode || '') + '?callId=' + (data.callId || '');
        if (data.joinUrl) {
          appUrl += '&joinUrl=' + encodeURIComponent(data.joinUrl);
        }
        return self.clients.openWindow(appUrl);
      }

      // Non-meet notification
      if (appClient) return appClient.focus();
      return self.clients.openWindow('/');
    })
  );
});
