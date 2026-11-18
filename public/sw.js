// One service worker for the customer app and the admin app (both live at the site root).
// Pages and scripts are fetched fresh when online; the last copy is used when offline.
// Bookings, prices and settings (/api/) are never cached.
const CACHE = 'city-drive-v2';
const SHELL = ['/', '/admin', '/admin-app/icon-192.png'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    event.respondWith(
        fetch(request).then(response => {
            if (response.ok && response.type === 'basic') {
                const copy = response.clone();
                caches.open(CACHE).then(cache => cache.put(request, copy));
            }
            return response;
        }).catch(() => caches.match(request).then(hit => hit || (request.mode === 'navigate' ? caches.match('/') : Response.error())))
    );
});
