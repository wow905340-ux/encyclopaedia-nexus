// ENCYCLOPAEDIA NEXUS — Service Worker
self.addEventListener('push', e => {
  const data = e.data?.json() || { title: 'NEXUS', body: 'Новая статья!' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url));
});
