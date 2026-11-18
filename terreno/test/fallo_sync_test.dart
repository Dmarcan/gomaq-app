import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/services/api_client.dart' show ApiException;
import 'package:gomaq_mecanico/utils/fallo_sync.dart';
import 'package:http/http.dart' as http;

void main() {
  group('clasificarFalloSync: API', () {
    for (final codigo in [500, 502, 503, 429, 408]) {
      test('$codigo es transitorio: no gasta intento y deja un mensaje sin jerga', () {
        final d = clasificarFalloSync(ApiException(codigo, '<html>Bad Gateway</html>'));
        expect(d.accion, AccionFallo.transitorio);
        expect(d.mensaje, contains('Se reintentará solo'));
        // el cuerpo del proxy (HTML) no se muestra tal cual
        expect(d.mensaje, isNot(contains('<html>')));
        expect(d.mensajeAlAgotar, isNotNull);
      });
    }

    test('400 y 409 son rechazos de negocio: gastan un intento con el mensaje del servidor', () {
      for (final codigo in [400, 409]) {
        final d = clasificarFalloSync(ApiException(codigo, 'La orden ya está cerrada'));
        expect(d.accion, AccionFallo.gastarIntento, reason: '$codigo');
        expect(d.mensaje, 'La orden ya está cerrada');
      }
    });

    test('401 pausa la cola completa', () {
      expect(clasificarFalloSync(ApiException(401, 'Token invalido')).accion, AccionFallo.pausarSesion);
    });

    test('403 pasa la tarea a error de inmediato con su motivo', () {
      final d = clasificarFalloSync(ApiException(403, 'Esta orden está asignada a otro técnico'));
      expect(d.accion, AccionFallo.aError);
      expect(d.mensaje, contains('Esta orden está asignada a otro técnico'));
      expect(d.mensaje, contains('avisa al administrativo'));
    });
  });

  group('clasificarFalloSync: sin red', () {
    test('SocketException, TimeoutException y ClientException esperan la red sin gastar intentos', () {
      for (final error in <Object>[
        const SocketException('Failed host lookup'),
        TimeoutException('12 s'),
        http.ClientException('Connection closed'),
      ]) {
        final d = clasificarFalloSync(error);
        expect(d.accion, AccionFallo.esperarRed, reason: error.runtimeType.toString());
        expect(d.mensaje, isNotEmpty);
      }
    });
  });

  group('clasificarFalloSync: TLS y respuestas cortadas', () {
    test('HandshakeException, TlsException y CertificateException esperan la red', () {
      for (final error in <Object>[
        const HandshakeException('Connection terminated during handshake'),
        const TlsException('fallo TLS'),
        const CertificateException('certificado no verificable'),
      ]) {
        final d = clasificarFalloSync(error);
        expect(d.accion, AccionFallo.esperarRed, reason: error.runtimeType.toString());
        expect(d.mensaje, contains('conexión segura'));
      }
    });

    test('un JSON cortado o un cuerpo vacio dentro de una llamada al servidor (RespuestaIncompleta) espera la red', () {
      for (final cuerpo in ['{"id": 4, "estado": "fin', '', '<html>']) {
        late final FormatException error;
        try {
          jsonDecode(cuerpo);
          fail('deberia haber lanzado');
        } on FormatException catch (e) {
          error = e;
        }
        final d = clasificarFalloSync(RespuestaIncompleta(error));
        expect(d.accion, AccionFallo.esperarRed, reason: cuerpo);
        expect(d.mensaje, contains('incompleta'));
      }
    });

    test('un FormatException suelto (int.parse, DateTime.parse sobre datos propios) NO es de red: gasta intento', () {
      final errores = <FormatException>[];
      for (final falla in <void Function()>[() => int.parse('abc'), () => DateTime.parse('ayer'), () => double.parse('x')]) {
        try {
          falla();
        } on FormatException catch (e) {
          errores.add(e);
        }
      }
      expect(errores, hasLength(3));
      for (final e in errores) {
        expect(clasificarFalloSync(e).accion, AccionFallo.gastarIntento, reason: e.message);
      }
    });
  });

  group('clasificarFalloSync: subida de fotos', () {
    test('5xx, 429 y 408 del almacenamiento son transitorios con mensaje del servidor de fotos', () {
      for (final codigo in [500, 503, 429, 408]) {
        final d = clasificarFalloSync(ErrorSubidaArchivo(codigo));
        expect(d.accion, AccionFallo.transitorio, reason: '$codigo');
        expect(d.mensaje, 'El servidor de fotos no respondió. Se reintentará solo.');
      }
    });

    test('un 4xx del almacenamiento (URL vencida) gasta un intento, no pasa a error de inmediato', () {
      for (final codigo in [400, 403]) {
        final d = clasificarFalloSync(ErrorSubidaArchivo(codigo));
        expect(d.accion, AccionFallo.gastarIntento, reason: '$codigo');
        expect(d.mensaje, contains('servidor de fotos'));
      }
    });
  });

  test('ErrorPermanenteSync pasa a error con su mensaje', () {
    final d = clasificarFalloSync(ErrorPermanenteSync('La foto ya no está en el teléfono'));
    expect(d.accion, AccionFallo.aError);
    expect(d.mensaje, 'La foto ya no está en el teléfono');
  });

  test('un fallo desconocido gasta un intento, como antes', () {
    expect(clasificarFalloSync(StateError('x')).accion, AccionFallo.gastarIntento);
  });

  group('tope de fallos transitorios', () {
    final t0 = DateTime.utc(2026, 11, 10, 12);

    /// Cuenta [n] fallos repartidos parejo entre t0 y t0 + [lapso] (el primero en t0).
    ({Map<String, dynamic> payload, bool aError}) contarVarios(int n, Duration lapso,
        [Map<String, dynamic>? inicial]) {
      var payload = inicial ?? <String, dynamic>{'uuid': 'abc', 'path_subido': 'ot-1/x.jpg'};
      late ({Map<String, dynamic> payload, bool aError}) r;
      for (var i = 0; i < n; i++) {
        final ahora = n == 1 ? t0 : t0.add(lapso * (i / (n - 1)));
        r = contarFalloTransitorio(payload, ahora: ahora);
        if (i < n - 1) expect(r.aError, isFalse, reason: 'fallo ${i + 1}');
        payload = r.payload;
      }
      return r;
    }

    test('valores: 30 fallos y 6 horas', () {
      expect(topeFallosTransitorios, 30);
      expect(plazoFallosTransitorios, const Duration(hours: 6));
    });

    test('cuenta en el payload y anota la hora del primero sin tocar el uuid ni lo demas', () {
      final original = {'uuid': 'abc', 'path_subido': 'ot-1/x.jpg'};
      final r = contarFalloTransitorio(original, ahora: t0);
      expect(r.aError, isFalse);
      expect(r.payload['uuid'], 'abc');
      expect(r.payload['path_subido'], 'ot-1/x.jpg');
      expect(fallosTransitorios(r.payload), 1);
      expect(r.payload[llavePrimerFalloTransitorio], '2026-11-10T12:00:00.000Z');
      // no modifica el mapa original
      expect(original.containsKey(llaveFallosTransitorios), isFalse);
      expect(original.containsKey(llavePrimerFalloTransitorio), isFalse);
    });

    test('la hora del primer fallo no cambia con los fallos siguientes', () {
      final r = contarVarios(5, const Duration(hours: 2));
      expect(r.payload[llavePrimerFalloTransitorio], '2026-11-10T12:00:00.000Z');
      expect(fallosTransitorios(r.payload), 5);
    });

    test('30 fallos en 5 minutos NO pasan a error (Reintentar todo insistente)', () {
      final r = contarVarios(30, const Duration(minutes: 5));
      expect(r.aError, isFalse);
      expect(fallosTransitorios(r.payload), 30);
    });

    test('30 fallos y 6 horas SI pasan a error', () {
      final r = contarVarios(30, const Duration(hours: 6));
      expect(r.aError, isTrue);
      expect(r.payload['uuid'], 'abc');
      expect(r.payload['path_subido'], 'ot-1/x.jpg');
    });

    test('con mas de 30 fallos pasa a error en cuanto se cumplen las 6 horas', () {
      final r = contarVarios(100, const Duration(hours: 5, minutes: 59));
      expect(r.aError, isFalse);
      final siguiente = contarFalloTransitorio(r.payload, ahora: t0.add(const Duration(hours: 6)));
      expect(siguiente.aError, isTrue);
    });

    test('5 fallos y 10 horas NO pasan a error', () {
      final r = contarVarios(5, const Duration(hours: 10));
      expect(r.aError, isFalse);
    });

    test('payload antiguo con contador y sin hora: el plazo corre desde ahora', () {
      final antiguo = <String, dynamic>{'uuid': 'abc', llaveFallosTransitorios: 40};
      final r = contarFalloTransitorio(antiguo, ahora: t0);
      // ya pasa el tope de fallos, pero no puede pasar a error de inmediato
      expect(r.aError, isFalse);
      expect(fallosTransitorios(r.payload), 41);
      expect(r.payload[llavePrimerFalloTransitorio], t0.toIso8601String());
      // seis horas despues si
      final despues = contarFalloTransitorio(r.payload, ahora: t0.add(const Duration(hours: 6)));
      expect(despues.aError, isTrue);
    });

    test('hora del primer fallo en el futuro (reloj atrasado): se toma ahora, ni error inmediato ni nunca', () {
      final futuro = <String, dynamic>{
        'uuid': 'abc',
        llaveFallosTransitorios: 50,
        llavePrimerFalloTransitorio: '2027-01-01T00:00:00.000Z',
      };
      final r = contarFalloTransitorio(futuro, ahora: t0);
      expect(r.aError, isFalse);
      expect(r.payload[llavePrimerFalloTransitorio], t0.toIso8601String());
      final despues = contarFalloTransitorio(r.payload, ahora: t0.add(const Duration(hours: 6)));
      expect(despues.aError, isTrue);
    });

    test('hora ilegible o de otro tipo: se toma ahora', () {
      for (final malo in <Object>['no es una fecha', 12345, true]) {
        final r = contarFalloTransitorio(
          {'uuid': 'abc', llaveFallosTransitorios: 50, llavePrimerFalloTransitorio: malo},
          ahora: t0,
        );
        expect(r.aError, isFalse, reason: '$malo');
        expect(r.payload[llavePrimerFalloTransitorio], t0.toIso8601String(), reason: '$malo');
      }
    });

    test('una hora local sin zona se interpreta y se guarda en UTC', () {
      final local = DateTime(2026, 11, 10, 9);
      final r = contarFalloTransitorio({'uuid': 'abc'}, ahora: local);
      expect(r.payload[llavePrimerFalloTransitorio], local.toUtc().toIso8601String());
      expect((r.payload[llavePrimerFalloTransitorio] as String).endsWith('Z'), isTrue);
    });

    test('Reintentar a mano limpia el contador y la hora, y conserva el uuid y path_subido', () {
      final payload = {
        'uuid': 'abc',
        'path_subido': 'ot-1/x.jpg',
        llaveFallosTransitorios: 30,
        llavePrimerFalloTransitorio: '2026-11-10T06:00:00.000Z',
      };
      expect(tieneMarcasFallosTransitorios(payload), isTrue);
      final limpio = sinFallosTransitorios(payload);
      expect(fallosTransitorios(limpio), 0);
      expect(limpio.containsKey(llaveFallosTransitorios), isFalse);
      expect(limpio.containsKey(llavePrimerFalloTransitorio), isFalse);
      expect(tieneMarcasFallosTransitorios(limpio), isFalse);
      expect(limpio['uuid'], 'abc');
      expect(limpio['path_subido'], 'ot-1/x.jpg');
      // el siguiente fallo vuelve a contar el plazo desde ese momento
      final otra = contarFalloTransitorio(limpio, ahora: t0);
      expect(fallosTransitorios(otra.payload), 1);
      expect(otra.payload[llavePrimerFalloTransitorio], t0.toIso8601String());
    });

    test('una tarea con solo la hora (sin contador) tambien se limpia al reintentar', () {
      expect(tieneMarcasFallosTransitorios({'uuid': 'abc', llavePrimerFalloTransitorio: 'x'}), isTrue);
      expect(tieneMarcasFallosTransitorios({'uuid': 'abc'}), isFalse);
    });
  });
}
