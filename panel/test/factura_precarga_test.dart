import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/facturacion_screen.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/theme/gomaq_theme.dart';
import 'package:intl/date_symbol_data_local.dart';

// Datos ficticios: sin clientes ni RUT reales.

const _arriendo = {'tipo': 'arriendo', 'id': 9, 'titulo': 'GR-12 · Arriendo', 'cliente_nombre': 'Constructora Ficticia Ltda'};
const _reparacion = {'tipo': 'reparacion', 'id': 55, 'titulo': 'OT #55 · GR-12 · Reparación', 'cliente_nombre': 'Constructora Ficticia Ltda'};

/// La lectura del PDF de muestra: neto 210.000, emisión 29-07-2026, vencimiento 28-08-2026 y un traslado
/// "entrega y retiro" de 140.000 que se divide en 70.000 y 70.000.
Map<String, dynamic> _muestra() => {
      'monto_detectado': 249900,
      'folio_detectado': '1512',
      'cliente_detectado': null,
      'texto_legible': true,
      'monto_neto_detectado': 210000,
      'fecha_emision_detectada': '2026-07-29',
      'vencimiento_detectado': '2026-08-28',
      'varias_cuotas': false,
      'plazo_cliente_dias': null,
      'traslado_detectado': {'total': 140000, 'entrega': 70000, 'retiro': 70000, 'concepto': 'entrega_y_retiro', 'lineas': 1},
      'vencimiento': {
        'propuesta': '2026-08-28',
        'origen': 'pdf',
        'alternativa': null,
        'coincide': null,
        'dias_pdf': 30,
        'plazo_cliente_dias': null,
      },
      'avisos': [
        {'codigo': 'traslado_dividido', 'mensaje': 'La factura dice entrega y retiro: el traslado se dividió en partes iguales. Corrígelo si no es así.'},
      ],
    };

class _Subidas {
  final llamadas = <({String ruta, Map<String, String> campos})>[];
  final correcciones = <({int id, Map<String, dynamic> cuerpo})>[];
  Object? respuesta;

  /// Por defecto la subida falla con un error del servidor: así el formulario queda a la vista y se
  /// inspeccionan los campos que se enviaron.
  Future<dynamic> subir(String ruta, PlatformFile archivo, Map<String, String> campos) async {
    llamadas.add((ruta: ruta, campos: campos));
    if (respuesta != null) return respuesta;
    throw ApiException(400, 'rechazada por la prueba');
  }

  Future<dynamic> corregir(int id, Map<String, dynamic> cuerpo) async {
    correcciones.add((id: id, cuerpo: cuerpo));
    return {'id': id, ...cuerpo};
  }
}

Widget _app(Map<String, dynamic> item, Map<String, dynamic>? deteccion, _Subidas s) => MaterialApp(
      home: Scaffold(
        body: FacturaPendienteDialog(
          item: item,
          elegirArchivo: () async => PlatformFile(name: 'factura.pdf', size: 3, bytes: Uint8List.fromList([1, 2, 3])),
          detectar: (_) async => deteccion ?? (throw ApiException(500, 'no se pudo leer')),
          subir: s.subir,
          corregir: s.corregir,
        ),
      ),
    );

void _tamano(WidgetTester t, Size s) {
  t.view.physicalSize = s;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}

Finder _campo(String etiqueta) => find.widgetWithText(TextFormField, etiqueta);
String _texto(WidgetTester t, String etiqueta) => t.widget<TextFormField>(_campo(etiqueta)).controller!.text;

Future<void> _leerPdf(WidgetTester t) async {
  await t.tap(find.text('Elegir PDF'));
  await t.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => initializeDateFormatting('es_CL'));

  setUp(() {
    // la sesión (flutter_secure_storage) no existe en las pruebas; sin ella ningún pedido sale a la red
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (_) async => null);
  });

  void prueba(String d, Future<void> Function(WidgetTester t) cuerpo) {
    testWidgets(d, (t) async {
      _tamano(t, const Size(900, 3000));
      await cuerpo(t);
    });
  }

  group('precarga desde el PDF', () {
    prueba('con la factura de muestra propone neto 210.000, traslado 70.000 y 70.000 y vencimiento 28-08-2026', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, _muestra(), s));
      await _leerPdf(t);

      expect(_texto(t, 'Folio SII *'), '1512');
      expect(_texto(t, 'Monto'), '249900');
      expect(_texto(t, 'Monto neto (opcional)'), '210000');
      expect(_texto(t, 'Traslado de entrega'), '70000');
      expect(_texto(t, 'Traslado de retiro'), '70000');
      expect(_texto(t, 'Traslado total (opcional)'), '140000', reason: 'el total a la vista es la suma');
      expect(find.text('29-07-2026'), findsOneWidget, reason: 'emisión');
      expect(find.text('28-08-2026'), findsOneWidget, reason: 'vencimiento');
      // la frase de dónde salió el traslado
      expect(find.textContaining('La factura dice entrega y retiro: el traslado se dividió en partes iguales'), findsOneWidget);
    });

    prueba('lo precargado se envía tal cual al confirmar, con las partes y sin el total', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, _muestra(), s));
      await _leerPdf(t);
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();

      final c = s.llamadas.single;
      expect(c.ruta, '/api/facturacion/arriendo');
      expect(c.campos, {
        'guia_recepcion_id': '9',
        'folio': '1512',
        'monto': '249900',
        'monto_neto': '210000',
        'traslado_entrega': '70000',
        'traslado_retiro': '70000',
        'fecha_emision': '2026-07-29',
        'fecha_vencimiento': '2026-08-28',
      });
    });

    prueba('solo entrega: la parte de retiro queda vacía y se envía 0', (t) async {
      final d = _muestra()
        ..['traslado_detectado'] = {'total': 100000, 'entrega': 100000, 'retiro': 0, 'concepto': 'entrega', 'lineas': 1}
        ..['avisos'] = [];
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, d, s));
      await _leerPdf(t);
      expect(_texto(t, 'Traslado de entrega'), '100000');
      expect(_texto(t, 'Traslado de retiro'), '');
      expect(_texto(t, 'Traslado total (opcional)'), '100000');
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      expect(s.llamadas.single.campos['traslado_entrega'], '100000');
      expect(s.llamadas.single.campos['traslado_retiro'], '0');
      expect(s.llamadas.single.campos.containsKey('monto_traslado'), isFalse);
    });

    prueba('sin detalle: se llena solo el total, sin partes, y se envía como un solo monto', (t) async {
      final d = _muestra()
        ..['traslado_detectado'] = {'total': 60000, 'entrega': null, 'retiro': null, 'concepto': 'sin_detalle', 'lineas': 1}
        ..['avisos'] = [
          {'codigo': 'traslado_sin_detalle', 'mensaje': 'La factura no dice si el traslado es de entrega o de retiro: se tomó como un solo monto.'},
        ];
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, d, s));
      await _leerPdf(t);
      expect(_texto(t, 'Traslado de entrega'), '');
      expect(_texto(t, 'Traslado de retiro'), '');
      expect(_texto(t, 'Traslado total (opcional)'), '60000');
      expect(find.textContaining('se tomó como un solo monto'), findsOneWidget);
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      final campos = s.llamadas.single.campos;
      expect(campos['monto_traslado'], '60000');
      expect(campos.containsKey('traslado_entrega'), isFalse);
      expect(campos.containsKey('traslado_retiro'), isFalse);
    });

    prueba('corregir una parte recalcula el total a la vista', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, _muestra(), s));
      await _leerPdf(t);
      await t.enterText(_campo('Traslado de entrega'), '50.000');
      await t.enterText(_campo('Traslado de retiro'), '20.000');
      await t.pump();
      expect(_texto(t, 'Traslado total (opcional)'), '70000');
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      expect(s.llamadas.single.campos['traslado_entrega'], '50000');
      expect(s.llamadas.single.campos['traslado_retiro'], '20000');
    });

    prueba('un traslado mayor que el neto no se envía y lo dice', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, _muestra(), s));
      await _leerPdf(t);
      await t.enterText(_campo('Monto neto (opcional)'), '100.000');
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      expect(find.textContaining('no puede ser mayor que el monto neto'), findsOneWidget);
      expect(s.llamadas, isEmpty);
    });

    prueba('si la lectura falla el formulario sigue vacío y se llena a mano', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, null, s));
      await _leerPdf(t);
      expect(_texto(t, 'Folio SII *'), '');
      await t.enterText(_campo('Folio SII *'), '77');
      await t.enterText(_campo('Monto'), '119.000');
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      // sin valores nuevos no se mandan campos nuevos
      expect(s.llamadas.single.campos, {'guia_recepcion_id': '9', 'folio': '77', 'monto': '119000'});
    });

    prueba('una reparación no muestra neto, traslado ni fechas', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_reparacion, _muestra(), s));
      await _leerPdf(t);
      expect(_campo('Monto neto (opcional)'), findsNothing);
      expect(_campo('Traslado de entrega'), findsNothing);
      expect(find.text('Fecha de vencimiento'), findsNothing);
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      expect(s.llamadas.single.ruta, '/api/ordenes-trabajo/55/factura');
      expect(s.llamadas.single.campos, {'folio': '1512', 'monto': '249900'});
    });
  });

  group('aviso de vencimiento distinto del plazo del cliente', () {
    Map<String, dynamic> distinto() => _muestra()
      ..['plazo_cliente_dias'] = 30
      ..['vencimiento'] = {
        'propuesta': '2026-08-28',
        'origen': 'pdf',
        'alternativa': '2026-08-13',
        'coincide': false,
        'dias_pdf': 30 + 15,
        'plazo_cliente_dias': 30,
      }
      ..['avisos'] = [
        {
          'codigo': 'vencimiento_distinto_plazo',
          'mensaje': 'La fecha de vencimiento de la factura (28-08-2026 (45 días)) no coincide con el plazo habitual del cliente (30 días, 13-08-2026). Elige cuál guardar.',
        },
      ];

    prueba('muestra las dos opciones con la del PDF preseleccionada y no bloquea', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, distinto(), s));
      await _leerPdf(t);

      expect(find.text('Fecha de la factura: 28-08-2026 (45 días)'), findsOneWidget);
      expect(find.text('Plazo habitual del cliente: 30 días, 13-08-2026'), findsOneWidget);
      expect(t.widget<RadioGroup<String>>(find.byType(RadioGroup<String>)).groupValue, '2026-08-28', reason: 'la del PDF viene elegida');
      expect(find.textContaining('no coincide con el plazo habitual del cliente'), findsOneWidget);

      // sin tocar nada se puede subir, con la fecha del PDF
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      expect(s.llamadas.single.campos['fecha_vencimiento'], '2026-08-28');
    });

    prueba('elegir el plazo del cliente cambia el vencimiento que se envía', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, distinto(), s));
      await _leerPdf(t);
      await t.tap(find.text('Plazo habitual del cliente: 30 días, 13-08-2026'));
      await t.pumpAndSettle();
      expect(t.widget<RadioGroup<String>>(find.byType(RadioGroup<String>)).groupValue, '2026-08-13');
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      expect(s.llamadas.single.campos['fecha_vencimiento'], '2026-08-13');
    });

    prueba('los avisos de lo leído son región viva', (t) async {
      final manija = t.ensureSemantics();
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, distinto(), s));
      await _leerPdf(t);
      expect(
        t.getSemantics(find.text('Revisa lo que se leyó de la factura')),
        isSemantics(isLiveRegion: true),
        reason: 'los avisos se anuncian solos',
      );
      manija.dispose();
    });

    prueba('sin aviso cuando el vencimiento coincide con el plazo', (t) async {
      final d = _muestra()
        ..['plazo_cliente_dias'] = 30
        ..['vencimiento'] = {
          'propuesta': '2026-08-28',
          'origen': 'pdf',
          'alternativa': null,
          'coincide': true,
          'dias_pdf': 30,
          'plazo_cliente_dias': 30,
        }
        ..['avisos'] = [];
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, d, s));
      await _leerPdf(t);
      expect(find.byType(RadioListTile<String>), findsNothing);
      expect(find.text('Revisa lo que se leyó de la factura'), findsNothing);
      expect(find.text('28-08-2026'), findsOneWidget);
    });

    prueba('sin aviso cuando el cliente no tiene plazo', (t) async {
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, _muestra()..['avisos'] = [], s));
      await _leerPdf(t);
      expect(find.byType(RadioListTile<String>), findsNothing);
      expect(find.text('Revisa lo que se leyó de la factura'), findsNothing);
    });

    prueba('si el PDF no trae fecha, el vencimiento sale del plazo y lo avisa', (t) async {
      final d = _muestra()
        ..['vencimiento_detectado'] = null
        ..['plazo_cliente_dias'] = 30
        ..['vencimiento'] = {
          'propuesta': '2026-08-28',
          'origen': 'plazo_cliente',
          'alternativa': null,
          'coincide': null,
          'dias_pdf': null,
          'plazo_cliente_dias': 30,
        }
        ..['avisos'] = [
          {'codigo': 'vencimiento_desde_plazo', 'mensaje': 'La factura no trae fecha de pago: el vencimiento se calculó con el plazo habitual del cliente (30 días).'},
        ];
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, d, s));
      await _leerPdf(t);
      expect(find.text('28-08-2026'), findsOneWidget);
      expect(find.textContaining('se calculó con el plazo habitual del cliente'), findsOneWidget);
      expect(find.byType(RadioListTile<String>), findsNothing);
    });
  });

  group('después de crear la factura', () {
    Map<String, dynamic> creada() => {
          'id': 5,
          'folio': '1512',
          'monto': '249900.00',
          'monto_neto': '210000.00',
          'monto_traslado': '140000.00',
          'traslado_entrega': '70000.00',
          'traslado_retiro': '70000.00',
          'fecha_emision': '2026-07-29',
          'fecha_vencimiento': '2026-08-28',
        };

    prueba('los datos de la respuesta quedan en los campos de corrección y se guardan con el PATCH', (t) async {
      final s = _Subidas()..respuesta = creada();
      await t.pumpWidget(_app(_arriendo, _muestra(), s));
      await _leerPdf(t);
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();

      expect(find.text('Guardar cambios'), findsOneWidget);
      expect(_texto(t, 'Monto neto (opcional)'), '210000');
      expect(_texto(t, 'Traslado de entrega'), '70000');
      expect(_texto(t, 'Traslado de retiro'), '70000');
      expect(find.text('28-08-2026'), findsOneWidget);

      await t.enterText(_campo('Monto neto (opcional)'), '200.000');
      await t.enterText(_campo('Traslado de retiro'), '60.000');
      await t.tap(find.text('Guardar cambios'));
      await t.pumpAndSettle();
      final c = s.correcciones.single;
      expect(c.id, 5);
      expect(c.cuerpo['monto_neto'], 200000);
      expect(c.cuerpo['traslado_entrega'], 70000);
      expect(c.cuerpo['traslado_retiro'], 60000);
      expect(c.cuerpo.containsKey('monto_traslado'), isFalse, reason: 'con partes el servidor suma el total');
      expect(c.cuerpo['fecha_emision'], '2026-07-29');
      expect(c.cuerpo['fecha_vencimiento'], '2026-08-28');
    });

    prueba('sin partes se manda el total y se borra la división', (t) async {
      final s = _Subidas()
        ..respuesta = (creada()
          ..['traslado_entrega'] = null
          ..['traslado_retiro'] = null);
      await t.pumpWidget(_app(_arriendo, _muestra(), s));
      await _leerPdf(t);
      await t.tap(find.text('Subir factura'));
      await t.pumpAndSettle();
      await t.tap(find.text('Guardar cambios'));
      await t.pumpAndSettle();
      final c = s.correcciones.single.cuerpo;
      expect(c['traslado_entrega'], isNull);
      expect(c['traslado_retiro'], isNull);
      expect(c['monto_traslado'], 140000);
    });
  });

  group('teléfono', () {
    testWidgets('a 375 px el formulario con todo lo precargado y las opciones de vencimiento no desborda', (t) async {
      _tamano(t, const Size(375, 3000));
      final d = _muestra()
        ..['plazo_cliente_dias'] = 30
        ..['vencimiento'] = {
          'propuesta': '2026-08-28',
          'origen': 'pdf',
          'alternativa': '2026-08-13',
          'coincide': false,
          'dias_pdf': 45,
          'plazo_cliente_dias': 30,
        };
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, d, s));
      await _leerPdf(t);
      expect(t.takeException(), isNull);
      expect(find.text('Plazo habitual del cliente: 30 días, 13-08-2026'), findsOneWidget);
      // las dos partes del traslado van una bajo la otra
      expect(t.getTopLeft(_campo('Traslado de entrega')).dx, t.getTopLeft(_campo('Traslado de retiro')).dx);
      expect(t.getTopLeft(_campo('Traslado de entrega')).dy, lessThan(t.getTopLeft(_campo('Traslado de retiro')).dy));
    });

    testWidgets('el aviso usa advertenciaFuerte (cumple el contraste) con icono y texto', (t) async {
      _tamano(t, const Size(900, 3000));
      final s = _Subidas();
      await t.pumpWidget(_app(_arriendo, _muestra(), s));
      await _leerPdf(t);
      final titulo = t.widget<Text>(find.text('Revisa lo que se leyó de la factura'));
      expect(titulo.style!.color, GomaqColors.advertenciaFuerte);
      expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget);
    });
  });
}
