const CACHE_NAME = "ltf-v8";
const ASSETS = [
  "/",
  "/index.html",
  "/data.json",
  "/manifest.json",
  "/icon-192.svg",
  "/icon-512.svg",
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js",
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-database-compat.js"
];
// Install: cache all assets
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});
// Activate: clean old caches
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});
// Fetch: network first, fallback to cache
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = e.request.url;
  if (url.includes("firebasedatabase.app") || url.includes("firebaseio.com")) return;
  e.respondWith(
    fetch(e.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(e.request).then(cached => cached || new Response("Hors-ligne", { status: 503 }));
    })
  );
});
// ═══════ PUSH NOTIFICATIONS ═══════
// Recevoir une notification push du serveur
self.addEventListener("push", e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); }
  catch { data = { title: "La Table Familiale", body: e.data.text() }; }
  const options = {
    body: data.body || "",
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    tag: data.tag || "ltf-notification",
    renotify: true,
    data: { url: data.url || "/" },
    vibrate: [100, 50, 200]
  };
  e.waitUntil(
    self.registration.showNotification(data.title || "🌿 La Table Familiale", options)
  );
});
// Clic sur la notification → ouvrir l'app
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(wc => {
      for (const c of wc) {
        if (c.url.includes("la-table-familiale") && "focus" in c) return c.focus();
      }
      return clients.openWindow(e.notification.data?.url || "/");
    })
  );
});
