import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/dashboard_screen.dart';
import 'package:gomaq_web/services/auth_service.dart';
import 'package:gomaq_web/theme/gomaq_theme.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';

// Datos ficticios.
List<dynamic> _datos({Map<String, dynamic>? cobranza = const {'vencidas': 4, 'proximas': 2}}) => [
      {
        'flota': {'total': 10, 'arrendados': 3, 'disponibles': 5, 'operativas': 8, 'en_mantencion': 1, 'fuera_de_servicio': 1},
        'atajos': <String, dynamic>{},
        'cobranza': ?cobranza,
      },
      {'ejecutivos': [], 'total_general': 0},
      [],
    ];

class _Navegacion {
  final destinos = <({String ruta, Map<String, String>? filtro})>[];
  void ir(String ruta, {Map<String, String>? filtro}) => destinos.add((ruta: ruta, filtro: filtro));
}

Future<void> _montar(WidgetTester t, _Navegacion nav, {List<dynamic>? datos}) async {
  await t.pumpWidget(
    ChangeNotifierProvider<AuthService>(
      create: (_) => AuthService(),
      child: MaterialApp(
        home: Scaffold(body: DashboardScreen(onNavegar: nav.ir, cargarDatos: () async => datos ?? _datos())),
      ),
    ),
  );
  // el bloque de Pendientes pide su dato aparte y falla sin servidor: se espera a que termine
  await t.pump();
  await t.pump(const Duration(milliseconds: 600));
  await t.pump(const Duration(milliseconds: 600));
}

void _tamano(WidgetTester t, Size s) {
  t.view.physicalSize = s;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => initializeDateFormatting('es_CL'));

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (_) async => null);
  });

  testWidgets('las dos tarjetas de cobranza van junto a las de arrendados y disponibles, con su número', (t) async {
    // ancho de sobra: la tipografía de las pruebas es más ancha que la real y partiría las etiquetas
    _tamano(t, const Size(1800, 2000));
    await _montar(t, _Navegacion());
    expect(find.text('Facturas vencidas'), findsOneWidget);
    expect(find.text('Por vencer en 7 días'), findsOneWidget);
    expect(find.text('Equipos arrendados'), findsOneWidget);
    expect(find.text('Equipos disponibles'), findsOneWidget);
    // en escritorio las cuatro van en la misma fila
    final y = [for (final e in ['Facturas vencidas', 'Por vencer en 7 días', 'Equipos arrendados', 'Equipos disponibles']) t.getTopLeft(find.text(e)).dy];
    expect(y.toSet(), hasLength(1), reason: 'misma fila: $y');
    // el número de cada una
    expect(find.descendant(of: find.ancestor(of: find.text('Facturas vencidas'), matching: find.byType(InkWell)), matching: find.text('4')), findsOneWidget);
    expect(find.descendant(of: find.ancestor(of: find.text('Por vencer en 7 días'), matching: find.byType(InkWell)), matching: find.text('2')), findsOneWidget);
  });

  testWidgets('el estado no va solo en color: cada tarjeta lleva icono, y la vencida usa estadoNegativo', (t) async {
    _tamano(t, const Size(1200, 2000));
    await _montar(t, _Navegacion());
    final vencida = find.ancestor(of: find.text('Facturas vencidas'), matching: find.byType(InkWell));
    final proxima = find.ancestor(of: find.text('Por vencer en 7 días'), matching: find.byType(InkWell));
    expect(find.descendant(of: vencida, matching: find.byIcon(Icons.error_outline)), findsOneWidget);
    expect(find.descendant(of: proxima, matching: find.byIcon(Icons.schedule)), findsOneWidget);
    final numeroVencidas = t.widget<Text>(find.descendant(of: vencida, matching: find.text('4')));
    expect(numeroVencidas.style!.color, GomaqColors.estadoNegativo);
    final numeroProximas = t.widget<Text>(find.descendant(of: proxima, matching: find.text('2')));
    expect(numeroProximas.style!.color, GomaqColors.advertenciaFuerte);
  });

  testWidgets('tocar una tarjeta abre Facturación en la pestaña Emitidas con su filtro', (t) async {
    _tamano(t, const Size(1200, 2000));
    final nav = _Navegacion();
    await _montar(t, nav);
    await t.tap(find.text('Facturas vencidas'));
    await t.tap(find.text('Por vencer en 7 días'));
    expect(nav.destinos, hasLength(2));
    expect(nav.destinos[0].ruta, '/facturacion');
    expect(nav.destinos[0].filtro, {'pestana': 'emitidas', 'filtro': 'vencidas'});
    expect(nav.destinos[1].ruta, '/facturacion');
    expect(nav.destinos[1].filtro, {'pestana': 'emitidas', 'filtro': 'proximas'});
  });

  testWidgets('no se agregan al bloque Pendientes: cada número aparece una sola vez', (t) async {
    _tamano(t, const Size(1200, 2000));
    await _montar(t, _Navegacion());
    expect(find.text('Facturas vencidas'), findsOneWidget);
    expect(find.text('Por vencer en 7 días'), findsOneWidget);
  });

  testWidgets('con un servidor sin el dato de cobranza no aparecen las tarjetas', (t) async {
    _tamano(t, const Size(1200, 2000));
    await _montar(t, _Navegacion(), datos: _datos(cobranza: null));
    expect(find.text('Facturas vencidas'), findsNothing);
    expect(find.text('Equipos arrendados'), findsOneWidget);
  });

  testWidgets('con cero facturas las tarjetas siguen y dicen 0', (t) async {
    _tamano(t, const Size(1200, 2000));
    await _montar(t, _Navegacion(), datos: _datos(cobranza: {'vencidas': 0, 'proximas': 0}));
    final vencida = find.ancestor(of: find.text('Facturas vencidas'), matching: find.byType(InkWell));
    expect(find.descendant(of: vencida, matching: find.text('0')), findsOneWidget);
  });

  testWidgets('a 375 px las de cobranza van en su propia fila, de a dos, sin desbordar', (t) async {
    _tamano(t, const Size(375, 2400));
    await _montar(t, _Navegacion());
    expect(t.takeException(), isNull);
    final arrendados = t.getTopLeft(find.text('Equipos arrendados')).dy;
    final vencidas = t.getTopLeft(find.text('Facturas vencidas')).dy;
    final proximas = t.getTopLeft(find.text('Por vencer en 7 días')).dy;
    expect(vencidas, greaterThan(arrendados));
    expect(proximas, vencidas);
    // "Por vencer en 7 días" cabe completa en media pantalla
    expect(find.text('Por vencer en 7 días'), findsOneWidget);
  });

  testWidgets('con Tab se llega a la tarjeta y Enter o Espacio la abren', (t) async {
    _tamano(t, const Size(1200, 2000));
    final nav = _Navegacion();
    await _montar(t, nav);
    final tarjeta = find.ancestor(of: find.text('Facturas vencidas'), matching: find.byType(InkWell)).first;
    bool enTarjeta() {
      final contexto = FocusManager.instance.primaryFocus?.context;
      if (contexto == null) return false;
      final objetivo = t.element(tarjeta);
      var dentro = false;
      contexto.visitAncestorElements((e) {
        if (e == objetivo) {
          dentro = true;
          return false;
        }
        return true;
      });
      return dentro;
    }

    var intentos = 0;
    while (!enTarjeta() && intentos++ < 60) {
      await t.sendKeyEvent(LogicalKeyboardKey.tab);
      await t.pump();
    }
    expect(enTarjeta(), isTrue, reason: 'la tarjeta es alcanzable con Tab');
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(nav.destinos.single.filtro, {'pestana': 'emitidas', 'filtro': 'vencidas'});
    await t.sendKeyEvent(LogicalKeyboardKey.space);
    await t.pump();
    expect(nav.destinos, hasLength(2));
  });

  testWidgets('el lector de pantalla las lee como un botón con el número y a dónde lleva', (t) async {
    _tamano(t, const Size(1200, 2000));
    final manija = t.ensureSemantics();
    await _montar(t, _Navegacion());
    final etiqueta = find.bySemanticsLabel('Facturas vencidas: 4. Abre la lista de facturas vencidas');
    expect(etiqueta, findsOneWidget);
    expect(t.getSemantics(etiqueta), isSemantics(isButton: true, hasTapAction: true));
    expect(find.bySemanticsLabel('Por vencer en 7 días: 2. Abre la lista de facturas próximas a vencer'), findsOneWidget);
    manija.dispose();
  });
}
