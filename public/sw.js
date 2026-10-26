// Uygulama dosyalarını önbelleğe alır ki internet yokken de açılsın.
// İnternet varsa her zaman en güncel sürüm gelir.

const CACHE = "kervan-v29";
const SHELL = [
  "/", "/index.html", "/style.css", "/app.js", "/firm.js", "/party.js", "/forms.js", "/views.js", "/nav.js",
  "/data.js", "/ledger.js", "/money.js", "/rates.js", "/ui.js", "/session.js", "/firebase.js", "/firebase-config.js",
  "/install.js", "/i18n.js", "/photos.js", "/scanner.js", "/contacts.js", "/receipt.js", "/invoice.js", "/importer.js", "/ai.js", "/report.js", "/report-pages.js",
  "/manifest.webmanifest", "/manifest-dark.webmanifest", "/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Firebase SDK ve barkod kütüphanesi sürüm numaralı, değişmez: önce önbellek.
  if ((url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))
    || (url.hostname === "cdn.jsdelivr.net" && /@\d/.test(url.pathname))) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return res;
      })),
    );
    return;
  }

  // Kendi dosyalarımız: önce ağ, internet yoksa önbellek.
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request, { ignoreSearch: true })
          .then((hit) => hit || caches.match("/index.html"))),
    );
  }
});
