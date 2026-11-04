import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;
import 'package:mime/mime.dart' show lookupMimeType;

/// Error HTTP del backend (cualquier respuesta fuera de 2xx). Los errores de red
/// (`SocketException`, `TimeoutException`, `ClientException`) NO se envuelven en esta clase:
/// la cola de sincronizacion de la app del mecanico los distingue por su tipo para decidir si
/// reintenta o descarta la tarea.
class ApiException implements Exception {
  final int statusCode;
  final String message;
  ApiException(this.statusCode, this.message);
  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// Cliente HTTP del backend de GOMAQ, compartido por el panel y la app del mecanico.
///
/// No sabe donde se guarda el token ni como se cierra la sesion: cada app se lo entrega
/// ([tokenProvider], [alNoAutorizado]). Asi este paquete no depende de plugins de Flutter.
class ClienteApi {
  ClienteApi({
    required this.baseUrl,
    required this.tokenProvider,
    required this.timeout,
    required this.timeoutSubida,
    this.alNoAutorizado,
    http.Client? cliente,
  }) : _cliente = cliente;

  final String baseUrl;
  final Future<String?> Function() tokenProvider;

  /// Espera maxima de get/post/patch/put.
  final Duration timeout;

  /// Espera maxima de las subidas multipart.
  final Duration timeoutSubida;

  /// Se invoca ante cualquier 401, antes de lanzar la [ApiException].
  final void Function()? alNoAutorizado;

  /// Si es null se usan las funciones de nivel superior de `package:http`, que abren y cierran
  /// una conexion por llamada (el comportamiento que tenian las dos apps antes de compartir
  /// este codigo). Solo las pruebas inyectan un cliente.
  final http.Client? _cliente;

  Future<Map<String, String>> _headers({bool json = true}) async {
    final token = await tokenProvider();
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
      alNoAutorizado?.call();
    }
    throw ApiException(resp.statusCode, mensaje);
  }

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Future<dynamic> get(String path) async {
    final headers = await _headers();
    final uri = _uri(path);
    final c = _cliente;
    final envio = c == null ? http.get(uri, headers: headers) : c.get(uri, headers: headers);
    return _procesar(await envio.timeout(timeout));
  }

  /// [cabeceras] suma cabeceras propias de la llamada (por ejemplo `Idempotency-Key`); no pisan
  /// el token ni el tipo de contenido.
  Future<dynamic> post(String path, Map<String, dynamic> body, {Map<String, String>? cabeceras}) =>
      _conCuerpo('POST', path, body, cabeceras);

  Future<dynamic> patch(String path, Map<String, dynamic> body, {Map<String, String>? cabeceras}) =>
      _conCuerpo('PATCH', path, body, cabeceras);

  Future<dynamic> put(String path, Map<String, dynamic> body, {Map<String, String>? cabeceras}) =>
      _conCuerpo('PUT', path, body, cabeceras);

  Future<dynamic> _conCuerpo(String metodo, String path, Map<String, dynamic> body, Map<String, String>? cabeceras) async {
    final headers = {...?cabeceras, ...await _headers()};
    final cuerpo = jsonEncode(body);
    final uri = _uri(path);
    final c = _cliente;
    final Future<http.Response> envio;
    switch (metodo) {
      case 'POST':
        envio = c == null
            ? http.post(uri, headers: headers, body: cuerpo)
            : c.post(uri, headers: headers, body: cuerpo);
      case 'PATCH':
        envio = c == null
            ? http.patch(uri, headers: headers, body: cuerpo)
            : c.patch(uri, headers: headers, body: cuerpo);
      default:
        envio = c == null
            ? http.put(uri, headers: headers, body: cuerpo)
            : c.put(uri, headers: headers, body: cuerpo);
    }
    return _procesar(await envio.timeout(timeout));
  }

  /// Subida de archivo por multipart, con los campos de texto en [fields]. El archivo es
  /// opcional (ej. crear un equipo sin foto todavia).
  Future<dynamic> postMultipart(
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) =>
      _enviarMultipart('POST', path, bytes: bytes, filename: filename, fields: fields);

  Future<dynamic> patchMultipart(
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) =>
      _enviarMultipart('PATCH', path, bytes: bytes, filename: filename, fields: fields);

  /// `MultipartFile.fromBytes` declara `application/octet-stream` si no se le dice otra cosa, y el
  /// backend filtra por el tipo que declara cada archivo (PDF o imagen): sin esto rechaza todas las
  /// subidas con «El archivo debe ser un PDF / una imagen». Se deduce de la extension y de los
  /// primeros bytes.
  static MediaType _tipoDeArchivo(String filename, List<int> bytes) {
    final tipo = lookupMimeType(filename, headerBytes: bytes.take(12).toList());
    return MediaType.parse(tipo ?? 'application/octet-stream');
  }

  Future<dynamic> _enviarMultipart(
    String metodo,
    String path, {
    List<int>? bytes,
    String? filename,
    Map<String, String> fields = const {},
  }) async {
    final request = http.MultipartRequest(metodo, _uri(path));
    request.headers.addAll(await _headers(json: false));
    request.fields.addAll(fields);
    if (bytes != null && filename != null) {
      request.files.add(http.MultipartFile.fromBytes(
        'archivo',
        bytes,
        filename: filename,
        contentType: _tipoDeArchivo(filename, bytes),
      ));
    }
    final streamed = await (_cliente?.send(request) ?? request.send()).timeout(timeoutSubida);
    return _procesar(await http.Response.fromStream(streamed));
  }
}
