// Mastorss has moved to https://curator.8bitcloud.com/. This replaces the old
// service worker so installed copies stop serving the cached app: it clears
// its caches, unregisters itself, and reloads open pages (which then redirect).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('mastorss')) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
