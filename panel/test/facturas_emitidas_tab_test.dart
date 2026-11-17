import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/facturas_emitidas_tab.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/theme/gomaq_theme.dart';
import 'package:gomaq_web/utils/cobranza.dart';
import 'package:intl/date_symbol_data_local.dart';

// Datos ficticios: ningún cliente ni RUT reales.
Map<String, dynamic> _fila(
  int id,
  String estado, {
  String folio = '',
  String cliente = 'Constructora Ficticia Ltda',
  int? mora,
  int? paraVencer,
  String? vencimiento = '2026-08-28',
  String? pago,
  String? nc,
  num monto = 249900,
  num? neto = 210000,
  num traslado = 70000,
  String tipo = 'arriendo',
}) =>
    {
      'id': id,
      'folio': folio.isEmpty ? '${1000 + id}' : folio,
      'tipo': tipo,
      'orden_trabajo_id': tipo == 'reparacion' ? 55 : null,
      'cliente_id': 3,
      'cliente_nombre': cliente,
      'maquinaria_codigo': 'GR-12',
      'periodo_desde': '2026-07-01',
      'periodo_hasta': '2026-07-31',
      'monto': monto,
      'monto_neto': neto,
      'monto_traslado': traslado,
      'traslado_entrega': null,
      'traslado_retiro': null,
      'fecha_emision': '2026-07-29',
      'fecha_vencimiento': vencimiento,
      'fecha_pago': pago,
      'anulada_nc': nc,
      'estado_cobranza': estado,
      'dias_mora': mora ?? 0,
      'dias_para_vencer': paraVencer,
    };

Map<String, dynamic> _pagina(List<Map<String, dynamic>> items, {int? total, bool hayMas = false}) =>
    {'estado': 'todas', 'hoy': '2026-09-01', 'items': items, 'total': total ?? items.length, 'hay_mas': hayMas};

class _Llamada {
  final String estado;
  final String? q;
  final int offset;
  _Llamada(this.estado, this.q, this.offset);
}

/// Un servidor falso: cada consulta queda anotada y la respuesta sale de [respuesta].
class _Falso {
  final llamadas = <_Llamada>[];
  final cambios = <({int id, String ruta, Map<String, dynamic> cuerpo})>[];
  Map<String, dynamic> Function(String estado, String? q, int offset) respuesta;
  Object? errorAlCambiar;
  _Falso(this.respuesta);

  Future<Map<String, dynamic>> cargar({required String estado, String? q, required int offset}) async {
    llamadas.add(_Llamada(estado, q, offset));
    return respuesta(estado, q, offset);
  }

  Future<void> cambiar(int id, String ruta, Map<String, dynamic> cuerpo) async {
    cambios.add((id: id, ruta: ruta, cuerpo: cuerpo));
    if (errorAlCambiar != null) throw errorAlCambiar!;
  }
}

Widget _app(_Falso f, {bool admin = true, String? filtro}) => MaterialApp(
      home: Scaffold(
        body: FacturasEmitidasTab(key: UniqueKey(), filtroInicial: filtro, puedeEscribir: admin, cargar: f.cargar, cambiar: f.cambiar),
      ),
    );

/// Pantalla de escritorio alta: la lista es perezosa y así quedan construidas todas las filas.
void _prueba(String descripcion, Future<void> Function(WidgetTester) cuerpo) {
  testWidgets(descripcion, (t) async {
    _tamano(t, const Size(900, 3200));
    await cuerpo(t);
  });
}

void _tamano(WidgetTester t, Size s) {
  t.view.physicalSize = s;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  final todas = [
    _fila(1, 'vencida', mora: 12, vencimiento: '2026-08-20'),
    _fila(2, 'proxima', paraVencer: 3),
    _fila(3, 'pagada', pago: '2026-09-03'),
    _fila(4, 'anulada', nc: '88'),
    _fila(5, 'sin_vencimiento', vencimiento: null),
  ];

  group('estados', () {
    _prueba('cada estado lleva icono y texto, no solo color', (t) async {
      final f = _Falso((_, _, _) => _pagina(todas));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();

      expect(find.text('Vencida hace 12 días'), findsOneWidget);
      expect(find.text('Vence en 3 días'), findsOneWidget);
      expect(find.text('Pagada el 03-09-2026'), findsOneWidget);
      expect(find.text('Anulada NC/88'), findsOneWidget);
      expect(find.text('Sin vencimiento'), findsOneWidget);
      // un icono por estado
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
      expect(find.byIcon(Icons.schedule), findsOneWidget);
      expect(find.byIcon(Icons.check_circle_outline), findsOneWidget);
      expect(find.byIcon(Icons.block), findsWidgets);
      expect(find.byIcon(Icons.event_busy), findsOneWidget);
    });

    _prueba('la vencida va en estadoNegativo y la próxima en advertenciaFuerte', (t) async {
      final f = _Falso((_, _, _) => _pagina(todas));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(t.widget<Text>(find.text('Vencida hace 12 días')).style!.color, GomaqColors.estadoNegativo);
      expect(t.widget<Text>(find.text('Vence en 3 días')).style!.color, GomaqColors.advertenciaFuerte);
    });

    _prueba('muestra folio, cliente, monto, neto, traslado, equipo y fechas', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 2)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(find.text('Factura 1001'), findsOneWidget);
      expect(find.text('Constructora Ficticia Ltda'), findsOneWidget);
      expect(find.text(r'$249.900'), findsOneWidget);
      expect(find.textContaining(r'Neto $210.000'), findsOneWidget);
      expect(find.textContaining(r'Traslado $70.000'), findsOneWidget);
      expect(find.textContaining('GR-12'), findsOneWidget);
      expect(find.textContaining('Vencimiento: 28-08-2026'), findsOneWidget);
    });

    _prueba('una reparación se rotula con su orden de trabajo', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'al_dia', tipo: 'reparacion')]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(find.textContaining('Reparación OT #55'), findsOneWidget);
    });
  });

  group('filtros y búsqueda', () {
    _prueba('abre con el filtro de la URL (vencidas / proximas) y con todas si no se conoce', (t) async {
      final f = _Falso((_, _, _) => _pagina([]));
      await t.pumpWidget(_app(f, filtro: 'vencidas'));
      await t.pumpAndSettle();
      expect(f.llamadas.single.estado, 'vencidas');

      final g = _Falso((_, _, _) => _pagina([]));
      await t.pumpWidget(_app(g, filtro: 'proximas'));
      await t.pumpAndSettle();
      expect(g.llamadas.single.estado, 'proximas');

      final h = _Falso((_, _, _) => _pagina([]));
      await t.pumpWidget(_app(h, filtro: 'aviso'));
      await t.pumpAndSettle();
      expect(h.llamadas.single.estado, 'todas');
    });

    _prueba('los seis filtros están y cada uno pide su estado', (t) async {
      final f = _Falso((_, _, _) => _pagina(todas));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      final esperado = {
        'Todas': 'todas',
        'Por cobrar': 'por_cobrar',
        'Vencidas': 'vencidas',
        'Próximas a vencer': 'proximas',
        'Pagadas': 'pagadas',
        'Anuladas': 'anuladas',
      };
      for (final e in esperado.entries) {
        expect(find.widgetWithText(ChoiceChip, e.key), findsOneWidget, reason: e.key);
      }
      for (final e in esperado.entries.where((e) => e.value != 'todas')) {
        await t.tap(find.widgetWithText(ChoiceChip, e.key));
        await t.pumpAndSettle();
        expect(f.llamadas.last.estado, e.value);
      }
      // el elegido queda marcado
      expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Anuladas')).selected, isTrue);
      expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Todas')).selected, isFalse);
    });

    _prueba('la búsqueda manda el texto con Enter y con el botón', (t) async {
      final f = _Falso((_, _, _) => _pagina(todas));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField), '  1512 ');
      await t.testTextInput.receiveAction(TextInputAction.search);
      await t.pumpAndSettle();
      expect(f.llamadas.last.q, '1512');

      await t.enterText(find.byType(TextField), 'ficticia');
      await t.tap(find.byTooltip('Buscar'));
      await t.pumpAndSettle();
      expect(f.llamadas.last.q, 'ficticia');
    });

    _prueba('sin resultados muestra el estado vacío', (t) async {
      final f = _Falso((_, _, _) => _pagina([]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(find.text('No hay facturas con este filtro'), findsOneWidget);
      expect(find.text('0 facturas'), findsOneWidget);
    });

    _prueba('si falla la carga muestra el error con Reintentar y reintenta', (t) async {
      var intentos = 0;
      final f = _Falso((_, _, _) {
        intentos++;
        if (intentos == 1) throw ApiException(500, 'No se pudo consultar');
        return _pagina(todas);
      });
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(find.text('No se pudieron cargar las facturas'), findsOneWidget);
      expect(find.text('No se pudo consultar'), findsOneWidget);
      await t.tap(find.text('Reintentar'));
      await t.pumpAndSettle();
      expect(find.text('Factura 1001'), findsOneWidget);
    });

    _prueba('Cargar más pide la página siguiente y la suma', (t) async {
      final f = _Falso((_, _, offset) => offset == 0
          ? _pagina([_fila(1, 'vencida', mora: 2), _fila(2, 'vencida', mora: 5)], total: 3, hayMas: true)
          : _pagina([_fila(3, 'vencida', mora: 9)], total: 3));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(find.text('Factura 1002'), findsOneWidget);
      expect(find.text('Factura 1003'), findsNothing);
      await t.tap(find.textContaining('Cargar más (1 restantes)'));
      await t.pumpAndSettle();
      expect(f.llamadas.last.offset, 2);
      expect(find.text('Factura 1003'), findsOneWidget);
      expect(find.textContaining('Cargar más'), findsNothing);
    });
  });

  group('acciones según el rol', () {
    _prueba('el administrativo ve las acciones de cada estado', (t) async {
      final f = _Falso((_, _, _) => _pagina(todas));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      // vencida, próxima y sin vencimiento se pueden pagar o anular; la pagada y la anulada se deshacen
      expect(find.text('Marcar pagada'), findsNWidgets(3));
      expect(find.text('Anulada con nota de crédito'), findsNWidgets(3));
      expect(find.text('Deshacer pago'), findsOneWidget);
      expect(find.text('Deshacer anulación'), findsOneWidget);
      expect(find.text('Corregir'), findsNWidgets(5));
    });

    _prueba('el gerente ve la lista sin ninguna acción y con el aviso de solo lectura', (t) async {
      final f = _Falso((_, _, _) => _pagina(todas));
      await t.pumpWidget(_app(f, admin: false));
      await t.pumpAndSettle();
      expect(find.text('Vencida hace 12 días'), findsOneWidget);
      expect(find.text('Marcar pagada'), findsNothing);
      expect(find.text('Anulada con nota de crédito'), findsNothing);
      expect(find.text('Deshacer pago'), findsNothing);
      expect(find.text('Deshacer anulación'), findsNothing);
      expect(find.text('Corregir'), findsNothing);
      expect(find.textContaining('Solo lectura'), findsOneWidget);
    });

    _prueba('Marcar pagada pide la fecha (hoy por defecto) y llama al endpoint de pago', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.tap(find.text('Marcar pagada'));
      await t.pumpAndSettle();
      expect(find.text('Fecha de pago'), findsOneWidget);
      expect(find.text(fechaGuiones(diaIso(DateTime.now()))), findsOneWidget);
      await t.tap(find.widgetWithText(FilledButton, 'Marcar pagada'));
      await t.pumpAndSettle();
      expect(f.cambios, hasLength(1));
      expect(f.cambios.single.id, 1);
      expect(f.cambios.single.ruta, '/pago');
      expect(f.cambios.single.cuerpo, {'fecha_pago': diaIso(DateTime.now())});
      // recarga la lista y lo dice (región viva)
      expect(f.llamadas.length, 2);
      expect(find.textContaining('marcada como pagada'), findsOneWidget);
    });

    _prueba('Anulada con nota de crédito exige el folio y lo envía', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.tap(find.text('Anulada con nota de crédito'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Guardar'));
      await t.pumpAndSettle();
      expect(find.text('Escribe el folio de la nota de crédito.'), findsOneWidget);
      expect(f.cambios, isEmpty);
      await t.enterText(find.widgetWithText(TextFormField, 'Folio de la nota de crédito *'), ' 77 ');
      await t.tap(find.widgetWithText(FilledButton, 'Guardar'));
      await t.pumpAndSettle();
      expect(f.cambios.single.ruta, '/pago');
      expect(f.cambios.single.cuerpo, {'anulada_nc': '77'});
    });

    _prueba('Deshacer pago pide confirmar y manda fecha_pago null', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'pagada', pago: '2026-09-03')]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.tap(find.text('Deshacer pago'));
      await t.pumpAndSettle();
      expect(f.cambios, isEmpty, reason: 'todavía no confirmó');
      await t.tap(find.widgetWithText(FilledButton, 'Deshacer'));
      await t.pumpAndSettle();
      expect(f.cambios.single.cuerpo, {'fecha_pago': null});
    });

    _prueba('Deshacer anulación manda anulada_nc null', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'anulada', nc: '88')]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.tap(find.text('Deshacer anulación'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Deshacer'));
      await t.pumpAndSettle();
      expect(f.cambios.single.cuerpo, {'anulada_nc': null});
    });

    _prueba('un error del servidor al marcar pagada queda dentro del cuadro y no cierra', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]))
        ..errorAlCambiar = ApiException(400, 'La fecha de pago no puede ser anterior a la emisión');
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.tap(find.text('Marcar pagada'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Marcar pagada'));
      await t.pumpAndSettle();
      expect(find.text('La fecha de pago no puede ser anterior a la emisión'), findsOneWidget);
      expect(find.text('Fecha de pago'), findsOneWidget, reason: 'el cuadro sigue abierto');
    });

    _prueba('Corregir envía solo lo que cambió: el neto y el vencimiento', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.tap(find.text('Corregir'));
      await t.pumpAndSettle();
      // sin cambios no manda nada
      await t.tap(find.widgetWithText(FilledButton, 'Guardar'));
      await t.pumpAndSettle();
      expect(f.cambios, isEmpty);

      await t.tap(find.text('Corregir'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextFormField, 'Monto neto'), '200.000');
      await t.tap(find.byTooltip('Quitar Fecha de vencimiento'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Guardar'));
      await t.pumpAndSettle();
      expect(f.cambios.single.id, 1);
      expect(f.cambios.single.ruta, '');
      expect(f.cambios.single.cuerpo, {'monto_neto': 200000, 'fecha_vencimiento': null});
    });

    _prueba('Corregir rechaza un neto que no es un monto', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.tap(find.text('Corregir'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextFormField, 'Monto neto'), 'abc');
      await t.tap(find.widgetWithText(FilledButton, 'Guardar'));
      await t.pumpAndSettle();
      expect(find.textContaining('Escribe un monto válido'), findsOneWidget);
      expect(f.cambios, isEmpty);
    });
  });

  group('móvil, teclado y lector de pantalla', () {
    _prueba('a 375 px las filas se apilan sin desbordar, con nombres largos y todas las acciones', (t) async {
      _tamano(t, const Size(375, 1400));
      final f = _Falso((_, _, _) => _pagina([
            _fila(1, 'vencida', mora: 120, cliente: 'Sociedad Constructora e Inmobiliaria Ficticia del Sur Austral Limitada', monto: 123456789, neto: 100000000, traslado: 12345678),
            _fila(2, 'pagada', pago: '2026-09-03'),
          ]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.text('Vencida hace 120 días'), findsOneWidget);
      expect(find.text('Anulada con nota de crédito'), findsOneWidget);
    });

    _prueba('a 375 px los cuadros de pago y corrección caben', (t) async {
      _tamano(t, const Size(375, 800));
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      await t.ensureVisible(find.text('Corregir'));
      await t.pumpAndSettle();
      await t.tap(find.text('Corregir'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.text('Corregir factura'), findsOneWidget);
    });

    _prueba('con Tab se llega a los filtros y Enter elige uno', (t) async {
      final f = _Falso((_, _, _) => _pagina(todas));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      // el primer Tab cae en el chip "Todas"; el segundo, en "Por cobrar"
      await t.sendKeyEvent(LogicalKeyboardKey.tab);
      await t.sendKeyEvent(LogicalKeyboardKey.tab);
      await t.pumpAndSettle();
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(f.llamadas.last.estado, 'por_cobrar');
    });

    _prueba('con Tab se llega a Marcar pagada y Espacio la activa', (t) async {
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      var intentos = 0;
      // el foco cae dentro de un OutlinedButton (el de Marcar pagada es el primero de la fila)
      bool enBoton() {
        final contexto = FocusManager.instance.primaryFocus?.context;
        if (contexto == null) return false;
        var dentro = false;
        contexto.visitAncestorElements((e) {
          // el botón "Exportar a Excel" de la cabecera también es un OutlinedButton: no cuenta
          if (e.widget is OutlinedButton && e.widget.key != const ValueKey('exportar-excel')) {
            dentro = true;
            return false;
          }
          return true;
        });
        return dentro;
      }

      while (!enBoton() && intentos++ < 40) {
        await t.sendKeyEvent(LogicalKeyboardKey.tab);
        await t.pump();
      }
      expect(enBoton(), isTrue, reason: 'el botón es alcanzable con Tab');
      await t.sendKeyEvent(LogicalKeyboardKey.space);
      await t.pumpAndSettle();
      expect(find.text('Fecha de pago'), findsOneWidget);
    });

    _prueba('el número de facturas y el aviso de una acción son región viva, y el estado se lee en texto', (t) async {
      final handle = t.ensureSemantics();
      final f = _Falso((_, _, _) => _pagina([_fila(1, 'vencida', mora: 4)]));
      await t.pumpWidget(_app(f));
      await t.pumpAndSettle();
      expect(t.getSemantics(find.text('1 factura')), matchesSemantics(label: '1 factura', isLiveRegion: true));
      // el estado está en el texto de la fila, que el lector lee entero
      expect(find.bySemanticsLabel(RegExp('Vencida hace 4 días')), findsOneWidget);
      // los botones son botones con nombre
      expect(
        t.getSemantics(find.widgetWithText(OutlinedButton, 'Marcar pagada')),
        matchesSemantics(label: 'Marcar pagada', isButton: true, isEnabled: true, isFocusable: true, hasEnabledState: true, hasTapAction: true, hasFocusAction: true),
      );
      handle.dispose();
    });
  });
}
