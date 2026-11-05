import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/unidades.dart';
import 'package:gomaq_web/widgets/pestanas.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  group('medidaConUnidad', () {
    test('"unidad" va en singular con 1 o -1 y en plural con el resto', () {
      expect(medidaConUnidad(1, 'unidad'), '1 unidad');
      expect(medidaConUnidad(-1, 'unidad'), '-1 unidad');
      expect(medidaConUnidad(-3, 'unidad'), '-3 unidades');
      expect(medidaConUnidad(0, 'unidad'), '0 unidades');
      expect(medidaConUnidad('4.00', 'unidad'), '4 unidades');
      expect(medidaConUnidad(1.5, 'unidad'), '1,5 unidades');
    });

    test('las otras unidades se dejan tal cual', () {
      expect(medidaConUnidad(3, 'kg'), '3 kg');
      expect(medidaConUnidad(2, 'lt'), '2 lt');
      expect(medidaConUnidad(1, 'm'), '1 m');
    });

    test('sin dato devuelve lo indicado', () {
      expect(medidaConUnidad(null, 'unidad', siVacio: '-'), '-');
    });
  });

  testWidgets('la pestaña elegida queda visible aunque la fila se desplace', (tester) async {
    tester.view.physicalSize = const Size(375, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var elegida = 'a';
    late StateSetter redibujar;
    await tester.pumpWidget(MaterialApp(
      home: StatefulBuilder(
        builder: (context, setState) {
          redibujar = setState;
          return Scaffold(
            body: Pestanas(
              items: [
                for (final id in ['a', 'b', 'c', 'd', 'e', 'todas'])
                  (id: id, etiqueta: id == 'todas' ? 'Todas las órdenes' : 'Pestaña larga $id', cantidad: 10),
              ],
              seleccionada: elegida,
              onSeleccionar: (v) => setState(() => elegida = v),
            ),
          );
        },
      ),
    ));
    // la pestaña activa cambia desde fuera (p. ej. por la URL) y está fuera de la vista
    redibujar(() => elegida = 'todas');
    await tester.pumpAndSettle();
    final caja = tester.getRect(find.textContaining('Todas las'));
    expect(caja.left, greaterThanOrEqualTo(0));
    expect(caja.right, lessThanOrEqualTo(375));
  });
}
