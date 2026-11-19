import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

/// Version del SDK de JavaScript que espera firebase_core_web, leida de su codigo fuente en el cache de pub.
String _versionDelPlugin() {
  final config = ['.dart_tool/package_config.json', '../.dart_tool/package_config.json']
      .map(File.new)
      .firstWhere((f) => f.existsSync());
  final paquetes = (jsonDecode(config.readAsStringSync())['packages'] as List).cast<Map<String, dynamic>>();
  final plugin = paquetes.firstWhere((p) => p['name'] == 'firebase_core_web');
  final ruta = plugin['rootUri'] as String;
  final raiz = config.uri.resolve(ruta.endsWith('/') ? ruta : '$ruta/');
  final fuente = File.fromUri(raiz.resolve('lib/src/firebase_sdk_version.dart')).readAsStringSync();
  return RegExp(r"supportedFirebaseJsSdkVersion\s*=\s*'([^']+)'").firstMatch(fuente)!.group(1)!;
}

void main() {
  // El CSP del servidor bloquea el script en linea con que firebase_core_web carga el SDK, asi que el panel
  // lo carga desde web/firebase-sdk.js. Si el plugin sube de version y este archivo no, el SDK y el plugin
  // quedan desparejados y los avisos fallan en silencio.
  test('web/firebase-sdk.js usa la misma version del SDK que firebase_core_web', () {
    final js = File('web/firebase-sdk.js').readAsStringSync();
    expect(js, contains("const VERSION = '${_versionDelPlugin()}';"));
  });

  test('index.html carga firebase-sdk.js como modulo propio, antes del arranque de Flutter', () {
    final html = File('web/index.html').readAsStringSync();
    final sdk = html.indexOf('<script type="module" src="firebase-sdk.js"></script>');
    final arranque = html.indexOf('flutter_bootstrap.js" async');
    expect(sdk, greaterThan(-1));
    expect(arranque, greaterThan(sdk));
  });
}
