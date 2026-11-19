/// Configuracion de Firebase de la app, leida de --dart-define. La clave de la API y el id de la app
/// de Firebase son datos publicos (se protegen restringiendo la clave por paquete en Google Cloud),
/// pero hasta que exista el proyecto de Firebase no se commitea nada: llegan al compilar. Si falta
/// cualquiera de los cuatro, el push queda apagado y la app funciona igual.
///
///   --dart-define=FIREBASE_API_KEY=...  --dart-define=FIREBASE_APP_ID=...
///   --dart-define=FIREBASE_MESSAGING_SENDER_ID=...  --dart-define=FIREBASE_PROJECT_ID=...
class ConfigPush {
  final String apiKey;
  final String appId;
  final String senderId;
  final String projectId;

  const ConfigPush({
    this.apiKey = '',
    this.appId = '',
    this.senderId = '',
    this.projectId = '',
  });

  static const ConfigPush desdeEntorno = ConfigPush(
    apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
    appId: String.fromEnvironment('FIREBASE_APP_ID'),
    senderId: String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID'),
    projectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
  );

  bool get completa =>
      apiKey.trim().isNotEmpty &&
      appId.trim().isNotEmpty &&
      senderId.trim().isNotEmpty &&
      projectId.trim().isNotEmpty;
}
