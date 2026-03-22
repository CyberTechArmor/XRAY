var CACHE_NAME = 'xray-v2';
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
  '/icon-512.png'
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
  var options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'xray-notification',
    data: data
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var tag = e.notification.tag;
  var urlToOpen = '/';

  // Handle meet call notifications
  if (tag === 'meet-call' && e.notification.data && e.notification.data.url) {
    urlToOpen = e.notification.data.url;
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      // Focus existing window if available
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client.url.indexOf(self.location.origin) !== -1 && 'focus' in client) {
          if (urlToOpen !== '/') {
            client.navigate(urlToOpen);
          }
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow(urlToOpen);
    })
  );
});
