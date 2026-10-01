import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:gomaq_comun/gomaq_comun.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

ClienteApi _api(
  MockClientHandler handler, {
  String? token = 'tok',
  Duration timeout = const Duration(seconds: 5),
  Duration timeoutSubida = const Duration(seconds: 5),
  void Function()? alNoAutorizado,
}) =>
    ClienteApi(
      baseUrl: 'http://api.test',
      tokenProvider: () async => token,
      timeout: timeout,
      timeoutSubida: timeoutSubida,
      alNoAutorizado: alNoAutorizado,
      cliente: MockClient(handler),
    );

http.Response _json(Object cuerpo, [int status = 200]) =>
    http.Response(jsonEncode(cuerpo), status, headers: {'content-type': 'application/json'});

Future<http.Response> _lento(http.Request r) async {
  await Future<void>.delayed(const Duration(milliseconds: 300));
  return _json({});
}

void main() {
  group('peticiones', () {
    test('get arma la URL y manda el token', () async {
      late http.Request visto;
      final api = _api((r) async {
        visto = r;
        return _json({'ok': true});
      });
      expect(await api.get('/api/equipos'), {'ok': true});
      expect(visto.url.toString(), 'http://api.test/api/equipos');
      expect(visto.headers['Authorization'], 'Bearer tok');
    });

    test('sin token no manda Authorization', () async {
      late http.Request visto;
      final api = _api((r) async {
        visto = r;
        return _json([]);
      }, token: null);
      await api.get('/x');
      expect(visto.headers.containsKey('Authorization'), isFalse);
    });

    test('post, patch y put mandan el cuerpo en JSON con su metodo', () async {
      final vistos = <http.Request>[];
      final api = _api((r) async {
        vistos.add(r);
        return _json({});
      });
      await api.post('/a', {'n': 1});
      await api.patch('/b', {'n': 2});
      await api.put('/c', {'n': 3});
      expect(vistos.map((r) => r.method), ['POST', 'PATCH', 'PUT']);
      expect(vistos.map((r) => jsonDecode(r.body)['n']), [1, 2, 3]);
      expect(vistos.every((r) => r.headers['Content-Type']!.contains('application/json')), isTrue);
    });

    test('el uuid_cliente de la cola llega intacto al servidor', () async {
      late http.Request visto;
      final api = _api((r) async {
        visto = r;
        return _json({});
      });
      await api.post('/api/ordenes', {'uuid_cliente': 'abc-123', 'x': 1});
      expect(jsonDecode(visto.body)['uuid_cliente'], 'abc-123');
    });

    test('respuesta 2xx vacia devuelve null', () async {
      final api = _api((r) async => http.Response('', 204));
      expect(await api.get('/x'), isNull);
    });
  });

  group('errores del backend', () {
    test('lanza ApiException con el mensaje del campo error', () async {
      final api = _api((r) async => _json({'error': 'Equipo no existe'}, 404));
      await expectLater(
        api.get('/x'),
        throwsA(isA<ApiException>()
            .having((e) => e.statusCode, 'statusCode', 404)
            .having((e) => e.message, 'message', 'Equipo no existe')),
      );
    });

    test('cuerpo que no es JSON se usa tal cual como mensaje', () async {
      final api = _api((r) async => http.Response('Bad Gateway', 502));
      await expectLater(
        api.get('/x'),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Bad Gateway')),
      );
    });

    test('un 401 avisa a alNoAutorizado una vez y lanza ApiException', () async {
      var avisos = 0;
      final api = _api((r) async => _json({'error': 'Token vencido'}, 401), alNoAutorizado: () => avisos++);
      await expectLater(
        api.get('/x'),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'statusCode', 401)),
      );
      expect(avisos, 1);
    });

    test('otros errores no avisan a alNoAutorizado', () async {
      var avisos = 0;
      final api = _api((r) async => _json({'error': 'x'}, 403), alNoAutorizado: () => avisos++);
      await expectLater(api.get('/x'), throwsA(isA<ApiException>()));
      expect(avisos, 0);
    });
  });

  // La cola offline de la app del mecanico clasifica por estos tipos: si se envolvieran, un
  // corte de red se contaria como error de aplicacion y la tarea se descartaria.
  group('errores de red salen sin envolver', () {
    test('SocketException', () async {
      final api = _api((r) async => throw const SocketException('sin red'));
      await expectLater(api.get('/x'), throwsA(isA<SocketException>()));
      await expectLater(api.post('/x', {}), throwsA(isA<SocketException>()));
    });

    test('ClientException', () async {
      final api = _api((r) async => throw http.ClientException('cortado'));
      await expectLater(api.get('/x'), throwsA(isA<http.ClientException>()));
    });

    test('TimeoutException en get y post usa timeout', () async {
      final api = _api(_lento, timeout: const Duration(milliseconds: 50));
      await expectLater(api.get('/x'), throwsA(isA<TimeoutException>()));
      await expectLater(api.post('/x', {}), throwsA(isA<TimeoutException>()));
    });
  });

  group('multipart', () {
    test('manda archivo y campos sin Content-Type JSON', () async {
      late http.Request visto;
      final api = _api((r) async {
        visto = r;
        return _json({'id': 7});
      });
      final resp = await api.postMultipart('/api/guias',
          bytes: [1, 2, 3], filename: 'g.pdf', fields: {'numero': '55'});
      expect(resp, {'id': 7});
      expect(visto.method, 'POST');
      expect(visto.headers['content-type'], startsWith('multipart/form-data'));
      expect(visto.body, contains('name="numero"'));
      expect(visto.body, contains('filename="g.pdf"'));
    });

    test('el archivo es opcional y patchMultipart usa PATCH', () async {
      late http.Request visto;
      final api = _api((r) async {
        visto = r;
        return _json({});
      });
      await api.patchMultipart('/api/equipos/1', fields: {'nombre': 'x'});
      expect(visto.method, 'PATCH');
      expect(visto.body, isNot(contains('filename=')));
    });

    test('usa timeoutSubida y no timeout', () async {
      final api = _api(_lento, timeout: const Duration(milliseconds: 50));
      expect(await api.postMultipart('/x', bytes: [1], filename: 'a.jpg'), {});
    });

    test('TimeoutException de subida sale sin envolver', () async {
      final api = _api(_lento, timeoutSubida: const Duration(milliseconds: 50));
      await expectLater(
        api.postMultipart('/x', bytes: [1], filename: 'a.jpg'),
        throwsA(isA<TimeoutException>()),
      );
    });
  });
}
