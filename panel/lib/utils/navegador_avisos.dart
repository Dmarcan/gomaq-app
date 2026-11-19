// Qué debe hacer la persona para recibir avisos con el navegador cerrado, según su navegador.
// Lógica pura: se prueba sin navegador (panel/test/navegador_avisos_test.dart).

enum Navegador { brave, chrome, edge, firefox, safariIos, otro }

/// Detecta el navegador. [esBrave] viene de `navigator.brave`: Brave se hace pasar por Chrome en el
/// user agent, así que sin ese dato no se distingue.
Navegador detectarNavegador(String userAgent, {bool esBrave = false}) {
  final ua = userAgent.toLowerCase();
  if (RegExp(r'iphone|ipad|ipod').hasMatch(ua)) return Navegador.safariIos;
  if (esBrave) return Navegador.brave;
  if (ua.contains('edg/') || ua.contains('edga/') || ua.contains('edgios/')) return Navegador.edge;
  if (ua.contains('firefox/') || ua.contains('fxios/')) return Navegador.firefox;
  if (ua.contains('chrome/') || ua.contains('crios/')) return Navegador.chrome;
  return Navegador.otro;
}

/// Instrucción corta para la capa 2 (avisos con el navegador cerrado).
String instruccionesAvisos(Navegador n) => switch (n) {
      Navegador.brave =>
        'En Brave abre brave://settings/privacy, activa la opción "Usar servicios de Google para mensajería '
            'push" (en inglés, "Use Google Services for Push Messaging") y reinicia Brave.',
      Navegador.safariIos =>
        'En iPhone y iPad solo funciona si instalas el panel en la pantalla de inicio (iOS 16.4 o superior).',
      Navegador.chrome || Navegador.edge || Navegador.firefox =>
        'Acepta el permiso de notificaciones cuando el navegador lo pida y vuelve a abrir el panel.',
      Navegador.otro =>
        'Revisa que tu navegador permita notificaciones de este sitio y vuelve a abrir el panel. En iPhone y iPad '
            'solo funciona si instalas el panel en la pantalla de inicio (iOS 16.4 o superior).',
    };
