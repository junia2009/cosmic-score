/**
 * sw.js — Service Worker for BGM Maker (COSMIC SCORE)
 * Strategy: Network-first, fall back to cache for offline use.
 * AI API requests (generativelanguage.googleapis.com) are NOT cached.
 */

const CACHE = 'cosmic-score-v1.4.0';

const ASSETS = [
  './',
  './index.html',
  './storage.js',
  './engine.js',
  './editor.js',
  './ai.js',
  './keyboard.js',
  './manifest.json',
  './icons/icon.svg',
];

/* ── Install: pre-cache all app assets ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

/* ── Activate: delete old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch: network-first, fallback to cache ── */
self.addEventListener('fetch', event => {
  // Don't intercept Gemini API calls — must be online
  if (event.request.url.includes('generativelanguage.googleapis.com')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful GET responses
        if (event.request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
