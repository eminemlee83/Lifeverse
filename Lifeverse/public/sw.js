// public/sw.js — 설치 조건만 만족시키는 최소 버전 (오프라인 캐싱은 다음 단계)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
