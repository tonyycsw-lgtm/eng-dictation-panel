// service-worker.js
// 英語默書系統 - Service Worker

const CACHE_NAME = 'english-dictation-v1';
const AUDIO_CACHE = 'audio-cache-v1';
const SITE_VERSION = 'v1.0.0';

// 需要預先快取的檔案（英語系統的路徑）
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/login.html',
  '/app.js',
  '/firebase-config.js',
  '/admin.html',
  '/data/units-index.json'
];

self.addEventListener('install', event => {
  console.log('Service Worker 安裝中...');
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('預快取檔案:', PRECACHE_URLS);
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.error('預快取失敗:', err);
      });
    })
  );
});

self.addEventListener('activate', event => {
  console.log('Service Worker 啟動中...');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME && key !== AUDIO_CACHE)
          .map(key => {
            console.log('刪除舊快取:', key);
            return caches.delete(key);
          })
      );
    })
  );
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // 忽略非 HTTP/HTTPS 請求
  if (!event.request.url.startsWith('http')) {
    return;
  }
  
  // 登入/登出頁面：永遠網路優先（確保最新版本）
  if (url.pathname.includes('/login.html') || 
      url.pathname.includes('/admin.html')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }
  
  // Firebase 相關請求：永遠網路優先（確保登入正常）
  if (url.hostname.includes('firebase') || 
      url.hostname.includes('googleapis') ||
      url.pathname.includes('firebase-config.js')) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  // 音頻檔案：快取優先（英語系統可能沒有音頻，使用 TTS）
  if (url.pathname.includes('/audio/') || url.pathname.endsWith('.mp3')) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(cache => {
        return cache.match(event.request).then(cached => {
          if (cached) {
            return cached;
          }
          return fetch(event.request).then(networkRes => {
            if (networkRes && networkRes.status === 200 && event.request.method === 'GET') {
              cache.put(event.request, networkRes.clone());
            }
            return networkRes;
          }).catch(() => {
            return new Response('音頻載入失敗', { status: 404 });
          });
        });
      })
    );
    return;
  }
  
  // JSON 數據檔案：網路優先，更新快取
  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return fetch(event.request).then(networkRes => {
          if (networkRes && networkRes.status === 200 && event.request.method === 'GET') {
            cache.put(event.request, networkRes.clone());
          }
          return networkRes;
        }).catch(() => {
          return cache.match(event.request);
        });
      })
    );
    return;
  }
  
  // 其他請求（HTML, CSS, JS）：網路優先，快取備份
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return fetch(event.request).then(networkRes => {
        if (event.request.method === 'GET' && networkRes && networkRes.status === 200) {
          cache.put(event.request, networkRes.clone());
        }
        return networkRes;
      }).catch(() => {
        console.log('網路請求失敗，使用快取:', url.pathname);
        return cache.match(event.request);
      });
    })
  );
});

// 接收來自頁面的訊息
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'PREFETCH_AUDIO') {
    const { url } = event.data;
    if (url) {
      caches.open(AUDIO_CACHE).then(cache => {
        fetch(url).then(res => {
          if (res.ok) cache.put(url, res);
        }).catch(() => {});
      });
    }
  }
});