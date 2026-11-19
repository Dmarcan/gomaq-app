import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:gomaq_web/screens/panel/orden_detalle.dart';
import 'package:gomaq_web/services/auth_service.dart';
import 'package:gomaq_web/widgets/fotos_orden.dart';

// HU-04: quien valoriza una reparación ve las fotos del antes y el después en el detalle de la orden.

Map<String, dynamic> _orden() => {
      'id': 41,
      'estado': 'finalizada',
      'facturable': true,
      'valorizacion': null,
      'diagnostico': 'Manguera rota',
      'motivo': 'No levanta la pluma',
      'maquinaria_codigo': 'EXC-04',
      'cliente_nombre': 'Cliente Ficticio',
    };

// el detalle pide otras cosas al servidor que en las pruebas nunca responden (queda un indicador girando):
// pumpAndSettle no terminaria, asi que se avanza por intervalos
Future<void> _asentar(WidgetTester t) async {
  for (var i = 0; i < 6; i++) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _montar(WidgetTester t, Future<List<dynamic>> Function() fotos, {double ancho = 900}) async {
  t.view.physicalSize = Size(ancho, 1600);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(ChangeNotifierProvider<AuthService>(
    create: (_) => AuthService(),
    child: MaterialApp(
      home: Scaffold(
        body: DetalleOrden(orden: _orden(), onCambio: () {}, enPagina: true, cargadorFotos: fotos),
      ),
    ),
  ));
  await _asentar(t);
}

void main() {
  testWidgets('el detalle de la orden muestra las fotos del antes y el después', (t) async {
    await _montar(t, () async => [
          {'id': 1, 'tipo': 'antes', 'url': null},
          {'id': 2, 'tipo': 'despues', 'url': null},
          {'id': 3, 'tipo': 'despues', 'url': null},
        ]);
    expect(find.byType(FotosOrden), findsOneWidget);
    expect(find.text('Fotos de la orden'), findsOneWidget);
    expect(find.text('Antes'), findsOneWidget);
    expect(find.text('Después'), findsOneWidget);
    // sigue mostrando el diagnóstico junto a las fotos
    expect(find.text('Manguera rota'), findsOneWidget);
  });

  testWidgets('no repite la nota del correo ni ofrece casillas: aquí solo se miran', (t) async {
    await _montar(t, () async => [
          {'id': 1, 'tipo': 'antes', 'url': null},
        ]);
    expect(find.text('Las fotos no se adjuntan al correo.'), findsNothing);
    expect(find.byType(Checkbox), findsNothing);
  });

  testWidgets('una orden sin fotos lo dice y una carga que falla se puede recargar', (t) async {
    var llamadas = 0;
    await _montar(t, () async {
      llamadas++;
      if (llamadas == 1) throw Exception('sin red');
      return [];
    });
    expect(find.textContaining('No se pudieron cargar las fotos'), findsOneWidget);
    await t.tap(find.text('Recargar'));
    await _asentar(t);
    expect(find.text('Esta orden no tiene fotos.'), findsOneWidget);
  });

  testWidgets('a 375 px no desborda', (t) async {
    await _montar(t, () async => [
          for (var i = 1; i <= 6; i++) {'id': i, 'tipo': i <= 3 ? 'antes' : 'despues', 'url': null},
        ], ancho: 375);
    expect(find.byType(FotosOrden), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
