/* Carga el SDK de Firebase para los avisos push desde un archivo propio.
 *
 * Por que existe: firebase_core_web carga el SDK con un <script> escrito en linea, y el CSP del servidor
 * (backend/server.js: script-src sin 'unsafe-inline') lo bloquea. Sin esto el boton de avisos fallaba con
 * "a[b] is not a function". Aqui el SDK se importa desde gstatic (ya permitido en script-src) y se deja en
 * window.firebase_core y window.firebase_messaging, que es lo que busca el plugin; si ya estan, no inyecta
 * nada. Un script del mismo origen no necesita abrir el CSP.
 *
 * La version DEBE ser la que usa firebase_core_web (supportedFirebaseJsSdkVersion). Si se actualiza el
 * plugin, panel/test/firebase_sdk_version_test.dart avisa. Los dos modulos se publican juntos y despues del
 * de nucleo, para que el plugin no vea el nucleo sin la mensajeria.
 */
const VERSION = '13.3.0';
const BASE = 'https://www.gstatic.com/firebasejs/' + VERSION + '/';

(async () => {
  try {
    const nucleo = await import(BASE + 'firebase-app.js');
    const mensajeria = await import(BASE + 'firebase-messaging.js');
    window.firebase_core = nucleo;
    window.firebase_messaging = mensajeria;
  } catch (e) {
    // sin red o bloqueado: los avisos con el navegador cerrado quedan no disponibles (el panel muestra el motivo)
    window.firebase_sdk_error = String(e && e.message ? e.message : e);
  }
})();
