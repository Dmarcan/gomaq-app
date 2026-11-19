/* Service worker de los avisos push del panel (se registra desde firebase_messaging al activar los avisos).
 *
 * Eleccion de diseno: NO carga el SDK de Firebase. La configuracion de Firebase (clave de API, ids) llega
 * solo al compilar con --dart-define y no esta en el repositorio; un service worker es un archivo estatico
 * que el navegador pide por su cuenta, asi que no puede leer esos valores. En vez de pasarlos por query
 * string o postMessage, este archivo no los necesita: FCM entrega el mensaje por Web Push y aqui solo se
 * muestra la notificacion y se abre la ruta al tocarla. El token y la suscripcion los crea la pagina con
 * getToken(vapidKey).
 *
 * Formato esperado del mensaje (FCM HTTP v1 hacia web): { notification: { title, body, tag }, data: {
 * tipo, orden_trabajo_id } }. Sin verificar contra FCM real todavia (ver README).
 */
'use strict';

function destinoDeAviso(data) {
  var id = parseInt((data && data.orden_trabajo_id) || '', 10);
  // misma regla que rutaDeAviso en push_service.dart (el cliente es redirigido al portal por el router)
  return id > 0 ? '/ordenes/' + id : '/';
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }
  var n = payload.notification || {};
  var data = payload.data || {};
  var titulo = n.title || data.title;
  if (!titulo) return; // mensaje sin texto: nada que mostrar
  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: n.body || data.body || '',
      tag: n.tag || undefined,
      icon: '/icons/Icon-192.png',
      data: data,
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var destino = destinoDeAviso(event.notification.data);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (ventanas) {
      for (var i = 0; i < ventanas.length; i++) {
        var v = ventanas[i];
        if (new URL(v.url).origin === self.location.origin && 'navigate' in v) {
          return v.navigate(destino).then(function (c) {
            return c && c.focus();
          });
        }
      }
      return self.clients.openWindow(destino);
    })
  );
});
