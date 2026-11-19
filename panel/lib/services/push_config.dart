import 'package:flutter/foundation.dart' show kIsWeb;

/// Configuracion de Firebase del panel, leida de --dart-define. La clave de la API y el id de la app de
/// Firebase son datos publicos (se protegen restringiendo la clave por paquete y por referer en Google
/// Cloud), pero hasta que exista el proyecto de Firebase no se commitea nada: llegan al compilar. Si
/// falta cualquiera de los obligatorios, el push queda apagado y el panel funciona igual.
///
///   --dart-define=FIREBASE_API_KEY=...  --dart-define=FIREBASE_APP_ID=...
///   --dart-define=FIREBASE_MESSAGING_SENDER_ID=...  --dart-define=FIREBASE_PROJECT_ID=...
///   solo para la web: --dart-define=FIREBASE_VAPID_KEY=...
///
/// La web y el APK del panel son apps distintas en Firebase (cada una con su `appId`): se compila cada
/// una con su propio juego de valores.
class ConfigPush {
  final String apiKey;
  final String appId;
  final String senderId;
  final String projectId;
  final String vapidKey;

  const ConfigPush({
    this.apiKey = '',
    this.appId = '',
    this.senderId = '',
    this.projectId = '',
    this.vapidKey = '',
  });

  static const ConfigPush desdeEntorno = ConfigPush(
    apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
    appId: String.fromEnvironment('FIREBASE_APP_ID'),
    senderId: String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID'),
    projectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
    vapidKey: String.fromEnvironment('FIREBASE_VAPID_KEY'),
  );

  /// En la web tambien hace falta la clave VAPID; en Android no.
  bool completaPara({required bool web}) =>
      apiKey.trim().isNotEmpty &&
      appId.trim().isNotEmpty &&
      senderId.trim().isNotEmpty &&
      projectId.trim().isNotEmpty &&
      (!web || vapidKey.trim().isNotEmpty);

  bool get completa => completaPara(web: kIsWeb);
}
