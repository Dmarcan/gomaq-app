import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiException implements Exception {
  final int statusCode;
  final String message;
  ApiException(this.statusCode, this.message);
  @override
  String toString() => 'ApiException($statusCode): $message';
}

class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  /// Interceptor central de sesion expirada: AuthService lo registra al crearse.
  /// Ante cualquier 401 del backend se invoca (ademas de lanzar la excepcion),
  /// para cerrar la sesion y volver al login en vez de dejar la app "muerta".
  static void Function()? onSesionExpirada;

  // URL base vacia por defecto: el backend sirve este mismo build de Flutter Web
  // (server.js) desde el mismo origen que la API, asi que las rutas relativas
  // ('/api/...') apuntan solas al servidor correcto sin importar si se accede por
  // la IP LAN, el tunel de Cloudflare, o un dominio propio mas adelante.
  // Solo hace falta pasar --dart-define=GOMAQ_API_URL=http://192.168.1.132:3000
  // para `flutter run` en desarrollo, donde la app NO corre en el mismo origen que el backend.
  static const String baseUrl = String.fromEnvironment('GOMAQ_API_URL', defaultValue: '');

  static const _timeout = Duration(seconds: 15);

  final _storage = const FlutterSecureStorage();

  Future<String?> get _token => _storage.read(key: 'jwt_token');

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

  Future<Map<String, String>> _headers({bool json = true}) async {
    final token = await _token;
    return {
      if (json) 'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };
  }

  dynamic _procesar(http.Response resp) {
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      if (resp.body.isEmpty) return null;
      return jsonDecode(resp.body);
    }
    String mensaje = resp.body;
    try {
      mensaje = jsonDecode(resp.body)['error'] ?? resp.body;
    } catch (_) {}
    if (resp.statusCode == 401) {
      onSesionExpirada?.call();
    }
    throw ApiException(resp.statusCode, mensaje);
  }

  Future<dynamic> get(String path) async {
    final resp = await http.get(Uri.parse('$baseUrl$path'), headers: await _headers()).timeout(_timeout);
    return _procesar(resp);
  }

  Future<dynamic> post(String path, Map<String, dynamic> body) async {
    final resp = await http
        .post(Uri.parse('$baseUrl$path'), headers: await _headers(), body: jsonEncode(body))
        .timeout(_timeout);
    return _procesar(resp);
  }

  Future<dynamic> patch(String path, Map<String, dynamic> body) async {
    final resp = await http
        .patch(Uri.parse('$baseUrl$path'), headers: await _headers(), body: jsonEncode(body))
        .timeout(_timeout);
    return _procesar(resp);
  }

  /// Subida de archivo (PDF de guia/factura, foto de equipo) via multipart, usando los
  /// campos de texto en [fields]. El archivo es opcional (ej. crear un equipo sin foto todavia).
  Future<dynamic> postMultipart(
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) async {
    return _enviarMultipart('POST', path, bytes: bytes, filename: filename, fields: fields);
  }

  Future<dynamic> patchMultipart(
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) async {
    return _enviarMultipart('PATCH', path, bytes: bytes, filename: filename, fields: fields);
  }

  Future<dynamic> _enviarMultipart(
    String metodo,
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final request = http.MultipartRequest(metodo, uri);
    final headers = await _headers(json: false);
    request.headers.addAll(headers);
    request.fields.addAll(fields);
    if (bytes != null && filename != null) {
      request.files.add(http.MultipartFile.fromBytes('archivo', bytes, filename: filename));
    }

    final streamed = await request.send().timeout(const Duration(seconds: 30));
    final resp = await http.Response.fromStream(streamed);
    return _procesar(resp);
  }
}
