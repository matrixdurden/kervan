// Online mağaza (vitrin) uygulaması: telefona yüklendiğinde açılsın diye sayfa ve dosyaları önbelleğe
// alır. Her zaman önce internetten gelir (fiyatlar güncel kalsın); internet yoksa önbellekteki açılır.
// /m/{adres}/sw.js adresinden yüklenir; sadece o mağazanın sayfalarına bakar.

const CACHE = "magaza-v6";
const SHELL = ["/magaza.css", "/magaza.js", "/money.js", "/receipt.js", "/firebase-config.js", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("magaza-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin && !(url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) return;
  event.respondWith(fetch(request)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return res;
    })
    .catch(() => caches.match(request, { ignoreSearch: true })));
});
