import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/widgets/lista_vacia_ordenes.dart';
import 'package:gomaq_mecanico/widgets/sync_banner.dart';

Widget _envolver(Widget hijo) => MaterialApp(home: Scaffold(body: hijo));

void main() {
  group('SyncBanner', () {
    testWidgets('sincronizando sin nada que enviar dice Actualizando', (tester) async {
      await tester.pumpWidget(_envolver(const SyncBanner(online: true, sincronizando: true, pendientes: 0, enError: 0)));
      expect(find.text('Actualizando…'), findsOneWidget);
      expect(find.text('Enviando cambios…'), findsNothing);
    });

    testWidgets('sincronizando con cambios por enviar dice Enviando cambios', (tester) async {
      await tester.pumpWidget(_envolver(const SyncBanner(online: true, sincronizando: true, pendientes: 2, enError: 0)));
      expect(find.text('Enviando cambios…'), findsOneWidget);
    });

    testWidgets('solo cambios en error (nada que salga) tambien dice Actualizando', (tester) async {
      await tester.pumpWidget(_envolver(const SyncBanner(online: true, sincronizando: true, pendientes: 1, enError: 1)));
      expect(find.text('Actualizando…'), findsOneWidget);
    });

    testWidgets('1 error con 3 detras', (tester) async {
      await tester.pumpWidget(_envolver(
          const SyncBanner(online: true, sincronizando: false, pendientes: 4, enError: 1, enEspera: 3)));
      expect(find.textContaining('1 cambio no se pudo enviar y 3 esperan detrás'), findsOneWidget);
    });

    test('singular y plural', () {
      expect(SyncBanner.textoErrores(1, 1), '1 cambio no se pudo enviar y 1 espera detrás');
      expect(SyncBanner.textoErrores(2, 5), '2 cambios no se pudieron enviar y 5 esperan detrás');
      expect(SyncBanner.textoErrores(1, 0), '1 cambio no se pudo enviar');
    });

    testWidgets('Todo enviado con senal: tocar la franja actualiza', (tester) async {
      var actualizaciones = 0;
      await tester.pumpWidget(_envolver(SyncBanner(
        online: true,
        sincronizando: false,
        pendientes: 0,
        enError: 0,
        onActualizar: () => actualizaciones++,
      )));
      expect(find.byIcon(Icons.refresh), findsOneWidget);
      await tester.tap(find.text('Todo enviado'));
      expect(actualizaciones, 1);
    });

    testWidgets('sin senal la franja no ofrece actualizar', (tester) async {
      var actualizaciones = 0;
      await tester.pumpWidget(_envolver(SyncBanner(
        online: false,
        sincronizando: false,
        pendientes: 0,
        enError: 0,
        onActualizar: () => actualizaciones++,
      )));
      await tester.tap(find.textContaining('Sin conexión'));
      expect(actualizaciones, 0);
      expect(find.byIcon(Icons.refresh), findsNothing);
    });

    testWidgets('con errores, tocar la franja abre los errores y no actualiza', (tester) async {
      var actualizaciones = 0;
      var errores = 0;
      await tester.pumpWidget(_envolver(SyncBanner(
        online: true,
        sincronizando: false,
        pendientes: 1,
        enError: 1,
        onTapErrores: () => errores++,
        onActualizar: () => actualizaciones++,
      )));
      await tester.tap(find.textContaining('no se pudo enviar'));
      expect(errores, 1);
      expect(actualizaciones, 0);
    });
  });

  group('ListaVaciaOrdenes', () {
    testWidgets('deslizar hacia abajo pide sincronizar', (tester) async {
      var llamadas = 0;
      await tester.pumpWidget(_envolver(ListaVaciaOrdenes(onActualizar: () async => llamadas++)));
      await tester.fling(find.textContaining('No tienes órdenes asignadas'), const Offset(0, 400), 1000);
      await tester.pumpAndSettle();
      expect(llamadas, 1);
    });

    testWidgets('el boton Actualizar pide sincronizar', (tester) async {
      var llamadas = 0;
      await tester.pumpWidget(_envolver(ListaVaciaOrdenes(onActualizar: () async => llamadas++)));
      await tester.tap(find.text('Actualizar'));
      await tester.pump();
      expect(llamadas, 1);
    });
  });
}
