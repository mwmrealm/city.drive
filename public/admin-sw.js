// Minimal service worker so the admin can be installed as an app.
// It caches only the app shell; bookings and settings always come live from the server.
const SHELL = 'city-drive-admin-v1';
const FILES = ['/admin', '/admin-app/icon-192.png'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(key => key !== SHELL).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    if (url.pathname === '/admin') {
        // Network first so updates show immediately; cached copy only when offline.
        event.respondWith(fetch(event.request).then(response => {
            const copy = response.clone();
            caches.open(SHELL).then(cache => cache.put('/admin', copy));
            return response;
        }).catch(() => caches.match('/admin')));
    }
});
