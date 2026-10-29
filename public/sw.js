// Uygulama dosyalarını önbelleğe alır ki internet yokken de açılsın.
// İnternet varsa her zaman en güncel sürüm gelir.

const CACHE = "kervan-v42";
const SHELL = [
  "/", "/index.html", "/style.css", "/app.js", "/firm.js", "/party.js", "/forms.js", "/views.js", "/nav.js",
  "/data.js", "/ledger.js", "/money.js", "/rates.js", "/ui.js", "/session.js", "/firebase.js", "/firebase-config.js",
  "/install.js", "/i18n.js", "/photos.js", "/scanner.js", "/contacts.js", "/receipt.js", "/invoice.js", "/importer.js", "/ai.js", "/report.js", "/report-pages.js", "/shop.js",
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

// Online mağazadan yeni sipariş (Worker'dan içeriksiz bildirim): telefonun üst perdesinde sesli, yazılı
// bildirim. Uygulama açıksa siparişi kendisi ayrıntısıyla (ad, ürün sayısı, tutar) zaten gösterdiyse
// ikinci kez çıkmaz.
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const shown = await self.registration.getNotifications({ tag: "kervan-order" });
    if (shown.some((n) => Date.now() - (n.timestamp || 0) < 60000)) return;
    await self.registration.showNotification("Yeni sipariş 🛍️", {
      body: "Online mağazandan sipariş geldi. Görmek için dokun.",
      tag: "kervan-order", renotify: true, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      vibrate: [200, 100, 200], data: { url: "/#orders" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === location.origin && !new URL(w.url).pathname.startsWith("/m/"));
    if (win) {
      win.postMessage({ type: "open-orders" });
      return win.focus();
    }
    return self.clients.openWindow("/#orders");
  })());
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
