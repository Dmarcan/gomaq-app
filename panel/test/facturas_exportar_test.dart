import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/facturas_emitidas_tab.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'utils/tamano.dart';

// Datos ficticios: ningún cliente ni RUT reales.
Future<Map<String, dynamic>> _vacia({required String estado, String? q, required int offset}) async =>
    {'items': <dynamic>[], 'total': 0, 'hay_mas': false};

class _Falso {
  final cuerpos = <Map<String, dynamic>>[];
  final abiertas = <String>[];
  Map<String, dynamic> respuesta = {'url': 'https://ejemplo.test/archivo.xlsx', 'filas': 12, 'sin_neto': 0, 'generado_en': '2026-11-17'};
  Object? error;

  Future<Map<String, dynamic>> exportar(Map<String, dynamic> cuerpo) async {
    cuerpos.add(cuerpo);
    if (error != null) throw error!;
    return respuesta;
  }

  Future<void> abrir(String url) async => abiertas.add(url);
}

Widget _app(_Falso f, {bool admin = true, int? clienteId}) => MaterialApp(
      home: Scaffold(
        body: FacturasEmitidasTab(
          puedeEscribir: admin,
          cargar: _vacia,
          cambiar: (id, ruta, cuerpo) async {},
          exportar: f.exportar,
          abrirUrl: f.abrir,
          clienteId: clienteId,
        ),
      ),
    );

Future<void> _abrirCuadro(WidgetTester t) async {
  await t.tap(find.byKey(const ValueKey('exportar-excel')));
  await t.pumpAndSettle();
}

Future<void> _exportar(WidgetTester t) async {
  await t.tap(find.widgetWithText(FilledButton, 'Exportar'));
  await t.pumpAndSettle();
}

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  testWidgets('flujo feliz: exporta, abre la url y anuncia las filas', (t) async {
    fijarTamano(t, const Size(900, 1200));
    final f = _Falso();
    await t.pumpWidget(_app(f));
    await t.pumpAndSettle();
    await _abrirCuadro(t);
    await _exportar(t);
    expect(f.cuerpos, [<String, dynamic>{}]);
    expect(f.abiertas, ['https://ejemplo.test/archivo.xlsx']);
    expect(find.text('Se exportaron 12 facturas a Excel.'), findsOneWidget);
    expect(find.textContaining('estimación'), findsNothing);
  });

  testWidgets('envía el cliente cuando la lista está acotada', (t) async {
    fijarTamano(t, const Size(900, 1200));
    final f = _Falso();
    await t.pumpWidget(_app(f, clienteId: 7));
    await t.pumpAndSettle();
    await _abrirCuadro(t);
    await _exportar(t);
    expect(f.cuerpos.single, {'cliente_id': 7});
  });

  testWidgets('avisa cuando hay facturas sin neto', (t) async {
    fijarTamano(t, const Size(900, 1200));
    final f = _Falso()..respuesta = {'url': 'https://ejemplo.test/a.xlsx', 'filas': 5, 'sin_neto': 3, 'generado_en': '2026-11-17'};
    await t.pumpWidget(_app(f));
    await t.pumpAndSettle();
    await _abrirCuadro(t);
    await _exportar(t);
    expect(
      find.textContaining('3 facturas no tienen monto neto guardado: su neto es una estimación (monto / 1,19); las exentas de IVA pueden salir mal.'),
      findsOneWidget,
    );
  });

  testWidgets('un 400 se muestra con el texto del servidor y no abre nada', (t) async {
    fijarTamano(t, const Size(900, 1200));
    final f = _Falso()..error = ApiException(400, 'La exportación supera las 5000 facturas: acota el rango de fechas');
    await t.pumpWidget(_app(f));
    await t.pumpAndSettle();
    await _abrirCuadro(t);
    await _exportar(t);
    expect(find.text('La exportación supera las 5000 facturas: acota el rango de fechas'), findsOneWidget);
    expect(f.abiertas, isEmpty);
    // el cuadro sigue abierto para acotar el rango
    expect(find.widgetWithText(FilledButton, 'Exportar'), findsOneWidget);
  });

  testWidgets('el gerente también ve el botón', (t) async {
    fijarTamano(t, const Size(900, 1200));
    await t.pumpWidget(_app(_Falso(), admin: false));
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('exportar-excel')), findsOneWidget);
  });

  testWidgets('teclado: con Tab se llega al botón y Enter abre el cuadro', (t) async {
    fijarTamano(t, const Size(900, 1200));
    await t.pumpWidget(_app(_Falso()));
    await t.pumpAndSettle();
    var llego = false;
    for (var i = 0; i < 15 && !llego; i++) {
      await t.sendKeyEvent(LogicalKeyboardKey.tab);
      await t.pump();
      final ctx = FocusManager.instance.primaryFocus?.context;
      final boton = ctx?.findAncestorWidgetOfExactType<OutlinedButton>();
      llego = boton?.key == const ValueKey('exportar-excel');
    }
    expect(llego, isTrue);
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pumpAndSettle();
    expect(find.widgetWithText(FilledButton, 'Exportar'), findsOneWidget);
  });

  testWidgets('375 px: el cuadro y el aviso no desbordan', (t) async {
    fijarTamano(t, const Size(375, 760));
    final f = _Falso()..respuesta = {'url': 'https://ejemplo.test/a.xlsx', 'filas': 1, 'sin_neto': 1, 'generado_en': '2026-11-17'};
    await t.pumpWidget(_app(f, clienteId: 7));
    await t.pumpAndSettle();
    await _abrirCuadro(t);
    expect(t.takeException(), isNull);
    await _exportar(t);
    expect(find.textContaining('Se exportó 1 factura'), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
