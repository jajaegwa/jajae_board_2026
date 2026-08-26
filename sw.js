/* 자재과 작업판 서비스워커
   목적 두 가지
   1) 홈 화면 바로가기를 진짜 앱(PWA)으로 만들어 아이폰에서도 알림을 띄울 수 있게 함.
      아이폰(iOS 16.4+)은 new Notification()을 지원하지 않고, 홈 화면에 추가된 앱에서
      서비스워커의 showNotification()만 동작함.
   2) 나중에 서버 푸시(Web Push)를 붙일 때를 대비해 push 핸들러를 미리 둠.

   주의: 화면 데이터를 캐시하지 않음. 이 앱은 항상 최신 발주·이동 내용을 보여줘야 하는데
   캐시가 끼면 예전 화면이 남아 "고쳤는데 안 바뀐다"는 문제가 생김. 오프라인 지원보다
   최신성이 훨씬 중요하므로 fetch 가로채기는 하지 않음. */

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 서버 푸시 수신 (푸시 서버를 붙인 뒤에 동작 — 지금은 호출되지 않음)
self.addEventListener('push', e => {
  let d = { title: '자재과 작업판', body: '새 작업이 등록되었습니다.' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (_) {
    try { d.body = e.data.text(); } catch (_) {}
  }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || 'jajae-push',
    renotify: true,
    data: { url: d.url || './index.html' }
  }));
});

// 알림을 누르면 이미 열려 있는 창을 앞으로, 없으면 새로 엶
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { try { await c.focus(); } catch (_) {} return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
