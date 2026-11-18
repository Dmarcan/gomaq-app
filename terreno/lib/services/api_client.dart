import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:gomaq_comun/gomaq_comun.dart';

export 'package:gomaq_comun/gomaq_comun.dart' show ApiException;

/// Lo que la cola de sincronizacion necesita del cliente HTTP. Existe para poder probar la cola con un
/// cliente falso, sin red ni almacenamiento seguro.
abstract interface class ApiCola {
  Future<dynamic> get(String path);
  Future<dynamic> post(String path, Map<String, dynamic> body);
  Future<dynamic> patch(String path, Map<String, dynamic> body);
  Future<dynamic> put(String path, Map<String, dynamic> body);
}

/// Acceso al backend de la app del mecanico: el cliente HTTP vive en `comun/` (ClienteApi) y
/// aqui solo queda lo propio de la app, que es donde se guarda el token.
///
/// Los errores de red (`SocketException`, `TimeoutException`, `ClientException`) salen sin
/// envolver: `SyncService` los clasifica por tipo para decidir si reintenta la tarea.
class ApiClient implements ApiCola {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  // Servidor de produccion en Railway, con HTTPS: funciona con datos moviles en terreno, no
  // solo dentro de la red de la oficina como el servidor local anterior (192.168.1.132).
  // Para desarrollo contra un backend local: --dart-define=GOMAQ_API_URL=http://10.0.2.2:3000
  static const String baseUrl = String.fromEnvironment(
    'GOMAQ_API_URL',
    defaultValue: 'https://gomaq-app-production.up.railway.app',
  );

  final _storage = const FlutterSecureStorage();

  // Los 12 s se mantienen explicitos (tambien en las subidas, como antes): en terreno con mala
  // senal conviene fallar rapido y dejar la tarea en la cola. No hay aviso de sesion vencida.
  late final ClienteApi _api = ClienteApi(
    baseUrl: baseUrl,
    tokenProvider: leerToken,
    timeout: const Duration(seconds: 12),
    timeoutSubida: const Duration(seconds: 12),
  );

  Future<void> guardarToken(String token) => _storage.write(key: 'jwt_token', value: token);
  Future<void> borrarToken() => _storage.delete(key: 'jwt_token');
  Future<String?> leerToken() => _storage.read(key: 'jwt_token');

  @override
  Future<dynamic> get(String path) => _api.get(path);
  @override
  Future<dynamic> post(String path, Map<String, dynamic> body) => _api.post(path, body);
  @override
  Future<dynamic> patch(String path, Map<String, dynamic> body) => _api.patch(path, body);
  @override
  Future<dynamic> put(String path, Map<String, dynamic> body) => _api.put(path, body);

  /// Subida multipart de un archivo. La evidencia de las OT usa URL firmada de Supabase, pero
  /// los documentos del vehiculo van por multipart al backend, que es quien decide el bucket.
  Future<dynamic> postMultipart(
    String path, {
    required List<int> bytes,
    required String filename,
    Map<String, String> fields = const {},
  }) =>
      _api.postMultipart(path, bytes: bytes, filename: filename, fields: fields);
}
