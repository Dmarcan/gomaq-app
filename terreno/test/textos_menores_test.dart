import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/utils/cambios.dart';
import 'package:gomaq_mecanico/widgets/orden_card.dart';
import 'package:gomaq_mecanico/widgets/sync_banner.dart';

void main() {
  test('plural de cambios', () {
    expect(textoCambios(1), '1 cambio');
    expect(textoCambios(0), '0 cambios');
    expect(textoCambios(5), '5 cambios');
  });

  test('etiqueta del botón según estado', () {
    expect(OrdenCard.textoBoton('asignada'), 'Ver orden');
    expect(OrdenCard.textoBoton('pendiente'), 'Ver orden');
    for (final e in ['aceptada', 'en_camino', 'en_terreno', 'en_reparacion']) {
      expect(OrdenCard.textoBoton(e), 'Continuar');
    }
  });

  test('texto sin conexión con y sin pendientes', () {
    expect(SyncBanner.textoSinConexion(0), 'Sin conexión. Tus cambios se guardan en el teléfono.');
    expect(SyncBanner.textoSinConexion(1), 'Sin conexión. 1 cambio guardado en el teléfono.');
    expect(SyncBanner.textoSinConexion(3), 'Sin conexión. 3 cambios guardados en el teléfono.');
  });

  testWidgets('la franja sin conexión muestra los pendientes', (tester) async {
    await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: SyncBanner(online: false, sincronizando: false, pendientes: 2, enError: 0))));
    expect(find.text('Sin conexión. 2 cambios guardados en el teléfono.'), findsOneWidget);
  });
}
