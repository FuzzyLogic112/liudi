import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "liudi-offline",
      generateBundle(_, bundle) {
        const assets = [
          "index.html",
          "icon.svg",
          "manifest.webmanifest",
          ...Object.keys(bundle),
        ];
        const version = createHash("sha256")
          .update(JSON.stringify(assets))
          .update("static-cache-v2")
          .digest("hex")
          .slice(0, 12);
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: `
const CACHE = 'liudi-${version}';
const ROOT = new URL('./', self.location.href);
const ASSETS = ${JSON.stringify(assets)}.map(p => new URL(p, ROOT).href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('liudi-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(ROOT.href)) return;
  // These are our precached static files. CORS-mode module/style requests may
  // send Origin while cache.addAll did not; a server's Vary: Origin must not
  // turn identical static assets into a cache miss when offline.
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request, { ignoreVary: true }).then(cached => cached || fetch(event.request).catch(error => {
    if (event.request.mode === 'navigate') return cache.match(new URL('index.html', ROOT).href);
    throw error;
  }))));
});
`,
        });
      },
    },
  ],
});
