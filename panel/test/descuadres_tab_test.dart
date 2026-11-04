import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'package:gomaq_web/screens/panel/descuadres_tab.dart';

Widget _envolver(Widget hijo) => MaterialApp(home: Scaffold(body: hijo));

const _caso = {
  'ubicacion_id': 3,
  'insumo_id': 7,
  'cantidad': -3,
  'insumo_nombre': 'Filtro de aceite',
  'unidad_medida': 'unidad',
  'ubicacion_nombre': 'Furgón de prueba',
  'ubicacion_tipo': 'furgon',
  'patente': 'AB1234',
  'mecanico_nombre': 'Mecánico Demo',
  'negativo_desde': '2026-03-05T13:00:00.000Z',
  'ultimo_movimiento_at': '2026-03-05T13:00:00.000Z',
  'sin_origen': false,
  'dias': 2,
};

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  testWidgets('sin descuadres muestra el estado vacío', (tester) async {
    await tester.pumpWidget(_envolver(DescuadresTab(
      descuadres: const [], catalogo: const [], motivos: const [], puedeEscribir: true, onRecargar: () async {},
    )));
    expect(find.text('Sin descuadres'), findsOneWidget);
  });

  testWidgets('el administrativo ve las tres acciones', (tester) async {
    await tester.pumpWidget(_envolver(DescuadresTab(
      descuadres: const [_caso], catalogo: const [], motivos: const [], puedeEscribir: true, onRecargar: () async {},
    )));
    expect(find.text('Filtro de aceite'), findsOneWidget);
    expect(find.textContaining('Negativo desde'), findsOneWidget);
    expect(find.text('Traspasar'), findsOneWidget);
    expect(find.text('Registrar conteo'), findsOneWidget);
    expect(find.text('Ver movimientos'), findsOneWidget);
  });

  testWidgets('el gerente solo puede ver los movimientos', (tester) async {
    await tester.pumpWidget(_envolver(DescuadresTab(
      descuadres: const [_caso], catalogo: const [], motivos: const [], puedeEscribir: false, onRecargar: () async {},
    )));
    expect(find.text('Traspasar'), findsNothing);
    expect(find.text('Registrar conteo'), findsNothing);
    expect(find.text('Ver movimientos'), findsOneWidget);
  });

  testWidgets('un negativo sin origen lo dice en vez de una fecha', (tester) async {
    await tester.pumpWidget(_envolver(DescuadresTab(
      descuadres: [
        {..._caso, 'sin_origen': true, 'negativo_desde': null, 'dias': null, 'ultimo_movimiento_at': null},
      ],
      catalogo: const [],
      motivos: const [],
      puedeEscribir: true,
      onRecargar: () async {},
    )));
    expect(find.textContaining('Ningún movimiento explica'), findsOneWidget);
  });

  testWidgets('si falla la carga muestra el error con Reintentar y llama a recargar', (tester) async {
    var recargas = 0;
    await tester.pumpWidget(_envolver(DescuadresTab(
      descuadres: const [],
      catalogo: const [],
      motivos: const [],
      puedeEscribir: true,
      error: 'Sin conexión',
      onRecargar: () async => recargas++,
    )));
    expect(find.text('No se pudieron cargar los descuadres'), findsOneWidget);
    await tester.tap(find.text('Reintentar'));
    expect(recargas, 1);
  });

  test('formatoCampo no deja decimales de más', () {
    expect(formatoCampo(3), '3');
    expect(formatoCampo(1.5), '1,5');
    expect(formatoCampo(0.1 + 0.2), '0,3');
  });
}
