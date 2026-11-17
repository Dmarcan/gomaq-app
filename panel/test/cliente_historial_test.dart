import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:gomaq_web/screens/panel/cliente_historial_screen.dart';
import 'package:gomaq_web/services/api_client.dart';

Map<String, dynamic> _datos({int? plazo = 30, bool vacio = false}) => {
      'cliente': {
        'id': 7,
        'nombre': 'Constructora Prueba',
        'rut': '76.809.295-8',
        'giro': 'Construcción',
        'email': 'contacto@prueba.cl',
        'telefono': null,
        'direccion': 'Calle 1',
        'plazo_pago_dias': plazo,
      },
      'resumen': {'equipos_arrendados_hoy': vacio ? 0 : 1, 'arriendos': vacio ? 0 : 2, 'facturas': vacio ? 0 : 1, 'total_facturado': vacio ? 0 : 119000},
      'arriendos': vacio
          ? []
          : [
              {'id': 5, 'maquinaria_id': 3, 'maquinaria_codigo': 'GR-3', 'inicio_cobro': '2026-03-10', 'fin': null, 'en_curso': true, 'falta_recepcion': false},
              {'id': 4, 'maquinaria_id': 2, 'maquinaria_codigo': 'PL-2', 'inicio_cobro': '2026-01-10', 'fin': '2026-02-01', 'en_curso': false, 'falta_recepcion': false},
            ],
      'facturas': vacio
          ? []
          : [
              {'id': 1, 'folio': '1512', 'monto': 119000, 'fecha_emision': '2026-04-01', 'periodo_desde': null, 'periodo_hasta': null, 'maquinaria_id': 3, 'maquinaria_codigo': 'GR-3', 'orden_trabajo_id': null},
            ],
      'ordenes': vacio
          ? []
          : [
              {'id': 11, 'estado': 'finalizada', 'maquinaria_id': 3, 'maquinaria_codigo': 'GR-3', 'fecha_creacion': '2026-03-01', 'fecha_cierre': '2026-03-02'},
            ],
      'hay_mas': {'arriendos': false, 'facturas': false, 'ordenes': false},
    };

Widget _app(Widget hijo) {
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (_, _) => Scaffold(body: hijo)),
    GoRoute(path: '/clientes', builder: (_, _) => const Scaffold(body: Text('lista de clientes'))),
    GoRoute(path: '/flota/:id', builder: (_, e) => Scaffold(body: Text('equipo ${e.pathParameters['id']}'))),
    GoRoute(path: '/ordenes/:id', builder: (_, e) => Scaffold(body: Text('orden ${e.pathParameters['id']}'))),
  ]);
  return MaterialApp.router(routerConfig: router);
}

void _tamano(WidgetTester t, Size s) {
  t.view.physicalSize = s;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));
  testWidgets('a 375 px apila las tres secciones con los datos, sin desbordar', (t) async {
    _tamano(t, const Size(375, 2400));
    await t.pumpWidget(_app(HistorialDeClienteScreen(id: 7, cargar: (_) async => _datos())));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('Constructora Prueba'), findsOneWidget);
    expect(find.text('Giro: Construcción'), findsOneWidget);
    expect(find.text('Plazo de pago: 30 días'), findsOneWidget);
    expect(find.textContaining('Arriendos ('), findsOneWidget);
    expect(find.textContaining('Facturas ('), findsOneWidget);
    expect(find.textContaining('Órdenes de trabajo ('), findsOneWidget);
    expect(find.text('Factura 1512'), findsOneWidget);
    expect(find.text('GR-3'), findsOneWidget);
    expect(find.text('Estado: En curso'), findsOneWidget, reason: 'el estado va como texto');
    expect(find.text('Estado: Terminado'), findsOneWidget);
  });

  testWidgets('desde 600 px van en pestañas y se cambia de sección', (t) async {
    _tamano(t, const Size(1000, 800));
    await t.pumpWidget(_app(HistorialDeClienteScreen(id: 7, cargar: (_) async => _datos())));
    await t.pumpAndSettle();
    expect(find.text('Factura 1512'), findsNothing, reason: 'solo se ve la pestaña activa');
    await t.tap(find.bySemanticsLabel(RegExp('^Facturas')));
    await t.pumpAndSettle();
    expect(find.text('Factura 1512'), findsOneWidget);
  });

  testWidgets('cada fila abre su equipo o su orden', (t) async {
    _tamano(t, const Size(375, 1400));
    await t.pumpWidget(_app(HistorialDeClienteScreen(id: 7, cargar: (_) async => _datos())));
    await t.pumpAndSettle();
    await t.tap(find.text('Orden 11, GR-3'));
    await t.pumpAndSettle();
    expect(find.text('orden 11'), findsOneWidget);
  });

  testWidgets('sin plazo se marca con icono y texto', (t) async {
    _tamano(t, const Size(375, 812));
    await t.pumpWidget(_app(HistorialDeClienteScreen(id: 7, cargar: (_) async => _datos(plazo: null))));
    await t.pumpAndSettle();
    expect(find.text('Sin plazo de pago'), findsOneWidget);
    expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget);
  });

  testWidgets('cliente sin movimientos: mensajes de vacío', (t) async {
    _tamano(t, const Size(375, 812));
    await t.pumpWidget(_app(HistorialDeClienteScreen(id: 7, cargar: (_) async => _datos(vacio: true))));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('Este cliente aún no tiene arriendos registrados.'), findsOneWidget);
    expect(find.text('Este cliente aún no tiene facturas.'), findsOneWidget);
    expect(find.text('Este cliente aún no tiene órdenes de trabajo.'), findsOneWidget);
  });

  testWidgets('error del servidor: aviso con reintento', (t) async {
    _tamano(t, const Size(375, 812));
    var intentos = 0;
    await t.pumpWidget(_app(HistorialDeClienteScreen(
      id: 7,
      cargar: (_) async {
        intentos++;
        if (intentos == 1) throw ApiException(500, 'Error al consultar');
        return _datos();
      },
    )));
    await t.pumpAndSettle();
    expect(find.text('No se pudo cargar el historial'), findsOneWidget);
    await t.tap(find.text('Reintentar'));
    await t.pumpAndSettle();
    expect(find.text('Constructora Prueba'), findsOneWidget);
  });

  testWidgets('id inválido: no encontramos ese cliente', (t) async {
    await t.pumpWidget(_app(const HistorialDeClienteScreen(id: null)));
    await t.pumpAndSettle();
    expect(find.text('No encontramos ese cliente'), findsOneWidget);
  });
}
