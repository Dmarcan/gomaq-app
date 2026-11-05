import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:gomaq_comun/gomaq_comun.dart';

export 'package:gomaq_comun/gomaq_comun.dart' show ApiException;

/// Acceso al backend del panel: el cliente HTTP vive en `comun/` (ClienteApi) y aqui solo
/// queda lo propio del panel, que es donde se guarda la sesion y como se cierra al vencer.
class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  /// Interceptor central de sesion expirada: AuthService lo registra al crearse.
  /// Ante cualquier 401 del backend se invoca (ademas de lanzar la excepcion),
  /// para cerrar la sesion y volver al login en vez de dejar la app "muerta".
  static void Function()? onSesionExpirada;

  /// Se invoca tras cada escritura exitosa (POST, PATCH, PUT y subidas): lo que alguien hace cambia los
  /// pendientes del dashboard y los contadores del menú, y así se actualizan sin que cada pantalla tenga
  /// que acordarse de avisar. PendientesService lo registra al crearse.
  static void Function()? alEscribir;

  Future<T> _tras<T>(Future<T> escritura) async {
    final r = await escritura;
    alEscribir?.call();
    return r;
  }

  // URL base vacia por defecto: el backend sirve este mismo build de Flutter Web
  // (server.js) desde el mismo origen que la API, asi que las rutas relativas
  // ('/api/...') apuntan solas al servidor correcto sin importar si se accede por
  // la IP LAN, el tunel de Cloudflare, o un dominio propio mas adelante.
  // Solo hace falta pasar --dart-define=GOMAQ_API_URL=http://192.168.1.132:3000
  // para `flutter run` en desarrollo, donde la app NO corre en el mismo origen que el backend.
  //
  // En el APK del panel no hay "mismo origen": una ruta relativa no tiene host y la llamada
  // falla, asi que fuera de la web la URL por defecto es la de produccion.
  static const String baseUrl = String.fromEnvironment(
    'GOMAQ_API_URL',
    defaultValue: kIsWeb ? '' : 'https://gomaq-app-production.up.railway.app',
  );

  final _storage = const FlutterSecureStorage();

  late final ClienteApi _api = ClienteApi(
    baseUrl: baseUrl,
    tokenProvider: leerToken,
    timeout: const Duration(seconds: 15),
    timeoutSubida: const Duration(seconds: 30),
    // Se lee en cada 401 porque AuthService registra el callback despues de crearse.
    alNoAutorizado: () => onSesionExpirada?.call(),
  );

  Future<void> guardarToken(String token) => _storage.write(key: 'jwt_token', value: token);
  Future<void> borrarToken() async {
    await _storage.delete(key: 'jwt_token');
    await _storage.delete(key: 'usuario_json');
  }
  Future<String?> leerToken() => _storage.read(key: 'jwt_token');

  // Se guarda el usuario (rol, nombre, cliente_id) junto al token para poder
  // restaurar la sesion completa (no solo "esta logueado") tras recargar la pagina.
  Future<void> guardarUsuario(String usuarioJson) => _storage.write(key: 'usuario_json', value: usuarioJson);
  Future<String?> leerUsuario() => _storage.read(key: 'usuario_json');

  Future<dynamic> get(String path) => _api.get(path);
  Future<dynamic> post(String path, Map<String, dynamic> body, {Map<String, String>? cabeceras}) =>
      _tras(_api.post(path, body, cabeceras: cabeceras));
  Future<dynamic> patch(String path, Map<String, dynamic> body, {Map<String, String>? cabeceras}) =>
      _tras(_api.patch(path, body, cabeceras: cabeceras));
  Future<dynamic> put(String path, Map<String, dynamic> body, {Map<String, String>? cabeceras}) =>
      _tras(_api.put(path, body, cabeceras: cabeceras));

  /// Subida de archivo (PDF de guia/factura, foto de equipo) via multipart, usando los
  /// campos de texto en [fields]. El archivo es opcional (ej. crear un equipo sin foto todavia).
  Future<dynamic> postMultipart(
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) =>
      _tras(_api.postMultipart(path, bytes: bytes, filename: filename, fields: fields));

  Future<dynamic> patchMultipart(
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) =>
      _tras(_api.patchMultipart(path, bytes: bytes, filename: filename, fields: fields));
}
