import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:gomaq_web/screens/cliente/cliente_historial_screen.dart';
import 'package:gomaq_web/screens/cliente/cliente_orden_detalle_screen.dart';
import 'package:gomaq_web/widgets/estado_vacio.dart';
import 'utils/tamano.dart';

Map<String, dynamic> _detalle() => {
      'id': 11,
      'estado': 'finalizada',
      'maquinaria_codigo': 'GR-3',
      'maquinaria_tipo': 'Grúa horquilla',
      'motivo': 'No levanta la pluma',
      'diagnostico': 'Manguera hidráulica rota',
      'observacion_final': 'Se cambió la manguera y quedó operativa',
      'fecha_creacion': '2026-03-01T09:00:00.000Z',
      'fecha_cierre': '2026-03-02T15:30:00.000Z',
      'mecanico_nombre': 'Pedro Soto',
      'cobro': 'con_cobro',
      'linea_tiempo': [
        {'paso': 'recibida', 'texto': 'Solicitud recibida', 'ocurrio_en': '2026-03-01T09:00:00.000Z'},
        {'paso': 'tecnico_asignado', 'texto': 'Técnico asignado', 'ocurrio_en': '2026-03-01T10:00:00.000Z'},
        {'paso': 'finalizada', 'texto': 'Finalizada', 'ocurrio_en': '2026-03-02T15:30:00.000Z'},
      ],
      'fotos': [
        {'id': 1, 'tipo': 'antes', 'url': 'http://localhost:1/a.jpg', 'tomada_en': '2026-03-01T11:00:00.000Z'},
        {'id': 2, 'tipo': 'despues', 'url': 'http://localhost:1/b.jpg', 'tomada_en': '2026-03-02T15:00:00.000Z'},
      ],
    };

Widget _app(Widget hijo) => MaterialApp(home: hijo);

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  testWidgets('a 375 px muestra equipo, motivo, diagnóstico, observación, línea de tiempo y fotos sin desbordar', (t) async {
    fijarTamano(t, const Size(375, 1400));
    await t.pumpWidget(_app(ClienteOrdenDetalleScreen(ordenId: 11, cargador: () async => _detalle())));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('Reparación de GR-3 (N.º 11)'), findsOneWidget);
    expect(find.text('Grúa horquilla'), findsOneWidget);
    expect(find.text('No levanta la pluma'), findsOneWidget);
    expect(find.text('Manguera hidráulica rota'), findsOneWidget);
    expect(find.text('Se cambió la manguera y quedó operativa'), findsOneWidget);
    expect(find.text('Técnico: Pedro Soto'), findsOneWidget);
    for (final titulo in ['Motivo', 'Diagnóstico', 'Observación final', 'Línea de tiempo', 'Fotos del trabajo']) {
      expect(find.text(titulo), findsOneWidget, reason: titulo);
    }
    expect(find.text('Solicitud recibida'), findsOneWidget);
    expect(find.text('Finalizada'), findsOneWidget);
    expect(find.text('Antes'), findsOneWidget);
    expect(find.text('Después'), findsOneWidget);
    expect(find.text('Las fotos no se adjuntan al correo.'), findsNothing, reason: 'es un texto del administrativo');
    expect(find.bySemanticsLabel('Ampliar foto antes'), findsOneWidget);
  });

  testWidgets('sin diagnóstico ni observación no muestra esas secciones; sin fotos lo dice', (t) async {
    fijarTamano(t, const Size(375, 1400));
    final d = _detalle()
      ..['diagnostico'] = null
      ..['observacion_final'] = ''
      ..['fotos'] = [];
    await t.pumpWidget(_app(ClienteOrdenDetalleScreen(ordenId: 11, cargador: () async => d)));
    await t.pumpAndSettle();
    expect(find.text('Diagnóstico'), findsNothing);
    expect(find.text('Observación final'), findsNothing);
    expect(find.text('Esta orden no tiene fotos.'), findsOneWidget);
  });

  testWidgets('si falla la carga muestra el error y Reintentar la repite', (t) async {
    fijarTamano(t, const Size(375, 1400));
    var llamadas = 0;
    await t.pumpWidget(_app(ClienteOrdenDetalleScreen(
      ordenId: 11,
      cargador: () async {
        llamadas++;
        if (llamadas == 1) throw Exception('sin red');
        return _detalle();
      },
    )));
    await t.pumpAndSettle();
    expect(find.byType(EstadoError), findsOneWidget);
    await t.tap(find.text('Reintentar'));
    await t.pumpAndSettle();
    expect(find.text('Reparación de GR-3 (N.º 11)'), findsOneWidget);
    expect(llamadas, 2);
  });

  testWidgets('tocar una orden del historial abre su detalle', (t) async {
    fijarTamano(t, const Size(375, 1400));
    int? pedida;
    await t.pumpWidget(_app(Scaffold(
      body: ClienteHistorialScreen(
        cargador: () async => [
          {'id': 11, 'estado': 'finalizada', 'maquinaria_codigo': 'GR-3', 'motivo': 'No levanta la pluma', 'fecha_cierre': '2026-03-02T15:30:00.000Z', 'cobro': 'con_cobro'},
          {'id': 12, 'estado': 'en_terreno', 'maquinaria_codigo': 'PL-2', 'fecha_creacion': '2026-03-03T09:00:00.000Z'},
        ],
        cargadorDetalle: (id) async {
          pedida = id;
          return _detalle();
        },
      ),
    )));
    await t.pumpAndSettle();
    expect(find.text('Reparación de GR-3 (N.º 11)'), findsOneWidget);
    expect(find.text('Reparación de PL-2 (N.º 12)'), findsNothing, reason: 'el historial solo trae las finalizadas');
    await t.tap(find.text('Reparación de GR-3 (N.º 11)'));
    await t.pumpAndSettle();
    expect(pedida, 11);
    expect(find.text('Detalle de la orden'), findsOneWidget);
    expect(find.text('Observación final'), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
