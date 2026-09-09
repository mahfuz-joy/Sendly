const CACHE_NAME = 'sendly-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/favicon.svg'
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evt) => {
  // Only handle GET
  if (evt.request.method !== 'GET') return;
  evt.respondWith(
    caches.match(evt.request).then(cached => cached || fetch(evt.request).then(res => {
      // Optionally cache new requests for same-origin assets
      try{
        const cloned = res.clone();
        if (evt.request.url.startsWith(self.location.origin)){
          caches.open(CACHE_NAME).then(cache=>cache.put(evt.request, cloned));
        }
      }catch(e){}
      return res;
    }).catch(()=> caches.match('/index.html')))
  );
});
