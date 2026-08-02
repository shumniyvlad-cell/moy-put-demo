const CACHE='mp-way-onboarding-v3';
const APP_SHELL=[
  './','./index.html','./way-a.css','./way-b.css','./unified.css','./manifest.json',
  './img/brand-mark.svg','./img/icon-192.png','./img/icon-512.png','./img/splash-hero.jpg','./img/dodecahedron-journey-v1.webp','./img/way-a-splash-runner.webp',
  './img/hero-1.jpg','./img/hero-2.jpg','./img/hero-3.jpg','./img/hero-4.jpg','./img/hero-5.jpg','./img/hero-6.jpg',
  './img/mentor-1.jpg','./img/mentor-2.jpg','./img/mentor-3.jpg','./img/mentor-4.jpg'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  event.respondWith(
    fetch(request).then(response=>{
      if(response.ok){
        const copy=response.clone();
        return caches.open(CACHE)
          .then(cache=>cache.put(request,copy))
          .catch(()=>{})
          .then(()=>response);
      }
      return response;
    }).catch(async()=>{
      const cached=await caches.match(request);
      if(cached)return cached;
      if(request.mode==='navigate')return caches.match('./index.html');
      throw new Error('offline');
    })
  );
});
