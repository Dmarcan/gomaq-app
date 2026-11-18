import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/utils/pasadas_en_serie.dart';

void main() {
  testWidgets('una peticion durante una pasada no se pierde: corre una sola pasada extra al terminar', (tester) async {
    final pasadas = <bool>[];
    var liberar = Completer<void>();
    late PasadasEnSerie serie;
    serie = PasadasEnSerie(
      pasada: (completa) async {
        pasadas.add(completa);
        await liberar.future;
      },
      alCambiar: () {},
    );

    final primera = serie.pedir();
    expect(serie.enCurso, isTrue);
    // tres peticiones durante la primera pasada se juntan en una sola pasada extra
    var extrasTerminadas = 0;
    final extras = [serie.pedir(), serie.pedir(completa: true), serie.pedir()]
        .map((f) => f.then((_) => extrasTerminadas++))
        .toList();

    final primeraLiberada = liberar;
    liberar = Completer<void>();
    primeraLiberada.complete();
    await primera;
    expect(extrasTerminadas, 0, reason: 'las peticiones extra esperan su propia pasada');

    // la pasada extra ya empezo y pide la completa si alguna peticion la pidio
    await tester.pump();
    expect(pasadas, [false, true]);
    liberar.complete();
    await Future.wait(extras);
    expect(extrasTerminadas, 3);
    expect(serie.enCurso, isFalse);

    // sin bucles: no hubo una tercera pasada
    await tester.pump(const Duration(milliseconds: 10));
    expect(pasadas.length, 2);
  });

  testWidgets('sin peticiones durante la pasada no hay pasada extra', (tester) async {
    var n = 0;
    final serie = PasadasEnSerie(pasada: (_) async => n++, alCambiar: () {});
    await serie.pedir();
    await tester.pump(const Duration(milliseconds: 10));
    expect(n, 1);
  });

  test('el error de la pasada propia se propaga; el de la pasada extra no rompe a quien la pidio', () async {
    final liberar = Completer<void>();
    var llamadas = 0;
    final serie = PasadasEnSerie(
      pasada: (_) async {
        llamadas++;
        await liberar.future;
        throw StateError('sin servidor');
      },
      alCambiar: () {},
    );
    final primera = serie.pedir();
    final extra = serie.pedir();
    liberar.complete();
    await expectLater(primera, throwsStateError);
    await expectLater(extra, completes);
    expect(llamadas, 2);
  });

  test('avisa a la interfaz al empezar y al terminar', () async {
    final estados = <bool>[];
    late PasadasEnSerie serie;
    serie = PasadasEnSerie(pasada: (_) async {}, alCambiar: () => estados.add(serie.enCurso));
    await serie.pedir();
    expect(estados, [true, false]);
  });
}
