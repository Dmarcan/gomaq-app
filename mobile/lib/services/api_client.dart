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

  // URL base configurable: la IP LAN del GX520 por defecto.
  // Para pruebas fuera de la red local, cambiar por la URL de Cloudflare Tunnel.
  static const String baseUrl = String.fromEnvironment(
    'GOMAQ_API_URL',
    defaultValue: 'http://192.168.1.29:3000',
  );

  final _storage = const FlutterSecureStorage();

  Future<String?> get _token => _storage.read(key: 'jwt_token');

  Future<void> guardarToken(String token) => _storage.write(key: 'jwt_token', value: token);
  Future<void> borrarToken() => _storage.delete(key: 'jwt_token');
  Future<String?> leerToken() => _storage.read(key: 'jwt_token');

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
    throw ApiException(resp.statusCode, mensaje);
  }

  static const _timeout = Duration(seconds: 12);

  Future<dynamic> get(String path) async {
    final resp = await http
        .get(Uri.parse('$baseUrl$path'), headers: await _headers())
        .timeout(_timeout);
    return _procesar(resp);
  }

  Future<dynamic> post(String path, Map<String, dynamic> body) async {
    final resp = await http
        .post(
          Uri.parse('$baseUrl$path'),
          headers: await _headers(),
          body: jsonEncode(body),
        )
        .timeout(_timeout);
    return _procesar(resp);
  }

  Future<dynamic> patch(String path, Map<String, dynamic> body) async {
    final resp = await http
        .patch(
          Uri.parse('$baseUrl$path'),
          headers: await _headers(),
          body: jsonEncode(body),
        )
        .timeout(_timeout);
    return _procesar(resp);
  }

  /// Subida multipart de un archivo. La evidencia de las OT usa URL firmada de Supabase, pero
  /// los documentos del vehiculo van por multipart al backend, que es quien decide el bucket.
  Future<dynamic> postMultipart(
    String path, {
    required List<int> bytes,
    required String filename,
    Map<String, String> fields = const {},
  }) async {
    final solicitud = http.MultipartRequest('POST', Uri.parse('$baseUrl$path'))
      ..headers.addAll(await _headers(json: false))
      ..fields.addAll(fields)
      ..files.add(http.MultipartFile.fromBytes('archivo', bytes, filename: filename));
    final streamed = await solicitud.send().timeout(_timeout);
    return _procesar(await http.Response.fromStream(streamed));
  }

  Future<dynamic> put(String path, Map<String, dynamic> body) async {
    final resp = await http
        .put(
          Uri.parse('$baseUrl$path'),
          headers: await _headers(),
          body: jsonEncode(body),
        )
        .timeout(_timeout);
    return _procesar(resp);
  }
}
