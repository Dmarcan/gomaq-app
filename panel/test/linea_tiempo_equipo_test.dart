import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/widgets/desglose_costos_equipo.dart';
import 'package:gomaq_web/widgets/linea_tiempo_equipo.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'utils/tamano.dart';

Map<String, dynamic> _evento(String tipo, int id, String fecha, {int? cliente, String? nombre, Map<String, dynamic> extra = const {}}) => {
      'tipo': tipo,
      'id': id,
      'fecha': fecha,
      'cliente_id': cliente,
      'cliente_nombre': nombre,
      ...extra,
    };

Map<String, dynamic> _datos({bool hayMas = false}) => {
      'maquinaria': {'id': 5, 'codigo': 'GH-1', 'tipo': 'Grúa'},
      'hay_mas': hayMas,
      'tope': 500,
      'total_eventos': 4,
      'tramos': [
        {
          'cliente_id': null,
          'cliente_nombre': null,
          'hasta': '2026-03-01T13:00:00.000Z',
          'desde': '2026-03-01T13:00:00.000Z',
          'eventos': [
            _evento('orden_trabajo', 40, '2026-03-01T13:00:00.000Z', extra: {
              'estado': 'finalizada', 'motivo': 'Taller sin cliente', 'tipo_servicio': 'correctivo',
              'costo_repuestos': 0, 'lineas_sin_precio': 0, 'es_mantencion': false,
            }),
          ],
        },
        {
          'cliente_id': 2,
          'cliente_nombre': 'Prize Chile',
          'hasta': '2026-02-06T13:00:00.000Z',
          'desde': '2026-02-02T12:00:00.000Z',
          'eventos': [
            _evento('lectura_horometro', 9, '2026-02-06T13:00:00.000Z', cliente: 2, nombre: 'Prize Chile', extra: {
              'valor': 160.5, 'origen': 'panel', 'horas_desde_anterior': 60.5, 'es_mantencion': true,
            }),
            _evento('orden_trabajo', 30, '2026-02-05T13:00:00.000Z', cliente: 2, nombre: 'Prize Chile', extra: {
              'estado': 'finalizada', 'motivo': 'Preventiva', 'tipo_servicio': 'preventivo',
              'costo_repuestos': 3000, 'lineas_sin_precio': 1, 'es_mantencion': true,
            }),
            _evento('guia_despacho', 12, '2026-02-02T12:00:00.000Z', cliente: 2, nombre: 'Prize Chile', extra: {
              'fallido': false, 'sin_documento': true, 'inicio_cobro': '2026-02-03',
            }),
          ],
        },
        {
          'cliente_id': 1,
          'cliente_nombre': 'ACSA',
          'hasta': '2026-01-25T12:00:00.000Z',
          'desde': '2026-01-20T13:00:00.000Z',
          'eventos': [
            _evento('factura', 77, '2026-01-25T12:00:00.000Z', cliente: 1, nombre: 'ACSA', extra: {
              'folio': '1512', 'monto': 210000, 'monto_traslado': 140000, 'ingreso': 70000, 'orden_trabajo_id': null,
            }),
            _evento('guia_recepcion', 11, '2026-01-20T13:00:00.000Z', cliente: 1, nombre: 'ACSA', extra: {
              'fallido': false, 'sin_documento': false, 'fin_cobro': '2026-01-20',
            }),
          ],
        },
      ],
    };

Widget _app(Widget hijo) => MaterialApp(home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(24), child: hijo)));

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  testWidgets('muestra un encabezado por tramo con el cliente y los eventos con texto', (t) async {
    fijarTamano(t, const Size(375, 900));
    await t.pumpWidget(_app(LineaTiempoEquipo(maquinariaId: 5, cargar: () async => _datos())));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull, reason: 'sin desbordes a 375 px');

    expect(find.text('En bodega o sin cliente'), findsOneWidget);
    expect(find.text('Prize Chile'), findsOneWidget);
    expect(find.text('ACSA'), findsOneWidget);
    expect(find.text('Orden de trabajo #40'), findsOneWidget);
    expect(find.text('Guía de despacho'), findsOneWidget);
    expect(find.text('Guía de recepción'), findsOneWidget);
    expect(find.text('Factura 1512'), findsOneWidget);
    expect(find.text('Lectura de horómetro'), findsOneWidget);
    expect(find.text('Monto: \$210.000'), findsOneWidget);
    expect(find.text('Traslado: \$140.000'), findsOneWidget);
    expect(find.text('Arriendo: \$70.000'), findsOneWidget);
    expect(find.textContaining('Inicio del arriendo: 03/02/2026'), findsOneWidget);
    expect(find.textContaining('Término del arriendo: 20/01/2026'), findsOneWidget);
    expect(find.text('Sin documento adjunto'), findsOneWidget);
    expect(find.text('1 línea de repuesto sin precio cargado'), findsOneWidget);
    // la mantención va con texto e ícono, no solo con color
    expect(find.text('Mantención'), findsNWidgets(2));
    expect(find.byIcon(Icons.handyman_outlined), findsNWidgets(2));
    expect(find.textContaining('Se muestran los'), findsNothing);
  });

  testWidgets('los encabezados de tramo son títulos para el lector de pantalla', (t) async {
    final handle = t.ensureSemantics();
    await t.pumpWidget(_app(LineaTiempoEquipo(maquinariaId: 5, cargar: () async => _datos())));
    await t.pumpAndSettle();
    final cabeceras = find.byWidgetPredicate((w) => w is Semantics && w.properties.header == true && (w.properties.label ?? '').contains('Prize Chile'));
    expect(cabeceras, findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('^Orden de trabajo #30, .*Abre la orden de trabajo')), findsOneWidget);
    handle.dispose();
  });

  testWidgets('tocar una orden la abre; tocar una guía o una factura lleva a documentos', (t) async {
    fijarTamano(t, const Size(800, 1600));
    final ordenes = <int>[];
    var documentos = 0;
    await t.pumpWidget(_app(LineaTiempoEquipo(
      maquinariaId: 5,
      cargar: () async => _datos(),
      onAbrirOrden: ordenes.add,
      onIrADocumentos: () => documentos++,
    )));
    await t.pumpAndSettle();

    await t.tap(find.text('Orden de trabajo #30'));
    expect(ordenes, [30]);
    expect(documentos, 0);
    await t.tap(find.text('Factura 1512'));
    await t.tap(find.text('Guía de recepción'));
    await t.tap(find.text('Guía de despacho'));
    expect(documentos, 3);
    expect(ordenes, [30]);
  });

  testWidgets('con teclado: Tab enfoca la fila y Enter y Espacio la activan', (t) async {
    final ordenes = <int>[];
    await t.pumpWidget(_app(LineaTiempoEquipo(
      maquinariaId: 5,
      cargar: () async => _datos(),
      onAbrirOrden: ordenes.add,
      onIrADocumentos: () {},
    )));
    await t.pumpAndSettle();

    // la primera fila enfocable es la orden #40 (la más reciente)
    await t.sendKeyEvent(LogicalKeyboardKey.tab);
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(ordenes, [40]);
    await t.sendKeyEvent(LogicalKeyboardKey.space);
    await t.pump();
    expect(ordenes, [40, 40]);
  });

  testWidgets('avisa cuando hay más eventos que el tope', (t) async {
    await t.pumpWidget(_app(LineaTiempoEquipo(maquinariaId: 5, cargar: () async => _datos(hayMas: true))));
    await t.pumpAndSettle();
    expect(find.textContaining('Se muestran los 500 eventos más recientes'), findsOneWidget);
  });

  testWidgets('sin eventos muestra un estado vacío', (t) async {
    await t.pumpWidget(_app(LineaTiempoEquipo(
      maquinariaId: 5,
      cargar: () async => {'maquinaria': {}, 'tramos': [], 'hay_mas': false},
    )));
    await t.pumpAndSettle();
    expect(find.text('Este equipo todavía no tiene movimientos registrados.'), findsOneWidget);
  });

  testWidgets('un error muestra el mensaje y Reintentar vuelve a cargar', (t) async {
    var intentos = 0;
    await t.pumpWidget(_app(LineaTiempoEquipo(
      maquinariaId: 5,
      cargar: () async {
        intentos++;
        if (intentos == 1) throw ApiException(500, 'Error al consultar la línea de tiempo del equipo');
        return _datos();
      },
    )));
    await t.pumpAndSettle();
    expect(find.text('No se pudo cargar la línea de tiempo'), findsOneWidget);
    expect(find.text('Error al consultar la línea de tiempo del equipo'), findsOneWidget);
    await t.tap(find.text('Reintentar'));
    await t.pumpAndSettle();
    expect(intentos, 2);
    expect(find.text('ACSA'), findsOneWidget);
  });

  group('desglose de costos', () {
    final rentabilidad = {
      'gasto': 3000,
      'ingreso': 70000,
      'lineas': [
        {
          'id': 1, 'cantidad': 2, 'precio_unitario': 1500, 'insumo_nombre': 'Filtro de aceite', 'descripcion': null,
          'created_at': '2026-02-05T13:00:00.000Z', 'orden_trabajo_id': 30, 'cliente_id': 2, 'cliente_nombre': 'Prize Chile',
        },
        {
          'id': 2, 'cantidad': 1, 'precio_unitario': null, 'insumo_nombre': 'Correa', 'descripcion': null,
          'created_at': '2026-02-06T13:00:00.000Z', 'orden_trabajo_id': 31, 'cliente_id': null, 'cliente_nombre': null,
        },
      ],
      'facturas': [
        {
          'id': 77, 'folio': '1512', 'monto': 210000, 'monto_traslado': 140000, 'created_at': '2026-01-25T12:00:00.000Z',
          'orden_trabajo_id': null, 'cliente_id': 1, 'cliente_nombre': 'ACSA',
        },
      ],
    };

    testWidgets('cada repuesto con su orden y cada factura con su folio y cliente, con enlace', (t) async {
      fijarTamano(t, const Size(375, 1600));
      final ordenes = <int>[];
      var documentos = 0;
      await t.pumpWidget(_app(DesgloseCostosEquipo(
        maquinariaId: 5,
        rentabilidad: rentabilidad,
        onAbrirOrden: ordenes.add,
        onIrADocumentos: () => documentos++,
      )));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);

      expect(find.text('Filtro de aceite'), findsOneWidget);
      expect(find.text('Orden de trabajo #30'), findsOneWidget);
      expect(find.text('Cliente: Prize Chile'), findsOneWidget);
      expect(find.text('2 x \$1.500 = \$3.000'), findsOneWidget);
      expect(find.text('Sin precio cargado: no suma al gasto'), findsOneWidget);
      expect(find.text('Cliente: Sin cliente'), findsOneWidget);
      expect(find.text('Factura 1512'), findsOneWidget);
      expect(find.text('Cliente: ACSA'), findsOneWidget);
      expect(find.textContaining('Traslado: \$140.000'), findsOneWidget);

      await t.tap(find.text('Filtro de aceite'));
      expect(ordenes, [30]);
      await t.tap(find.text('Factura 1512'));
      expect(documentos, 1);
    });

    testWidgets('sin repuestos ni facturas lo dice', (t) async {
      await t.pumpWidget(_app(const DesgloseCostosEquipo(maquinariaId: 5, rentabilidad: {'lineas': [], 'facturas': []})));
      await t.pumpAndSettle();
      expect(find.text('No hay repuestos usados en el período.'), findsOneWidget);
      expect(find.text('No hay facturas en el período.'), findsOneWidget);
    });
  });
}
