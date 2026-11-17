import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/facturacion_screen.dart';
import 'package:gomaq_web/services/auth_service.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';

/// La pantalla de Facturación abre en la pestaña Emitidas y con el filtro que viaja en la URL
/// (`?pestana=emitidas&filtro=vencidas`). Sin servidor las consultas fallan: la prueba mira la pestaña y el
/// filtro elegidos, que no dependen de la respuesta.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => initializeDateFormatting('es_CL'));

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (_) async => null);
  });

  Widget app({String? pestana, String? filtro}) => ChangeNotifierProvider<AuthService>(
        create: (_) => AuthService(),
        child: MaterialApp(home: FacturacionScreen(pestanaInicial: pestana, filtroInicial: filtro)),
      );

  testWidgets('hay cuatro pestañas y la última es Emitidas', (t) async {
    await t.pumpWidget(app());
    await t.pumpAndSettle();
    expect(find.text('Emitidas'), findsOneWidget);
    expect(find.text('Arriendos en curso'), findsOneWidget);
    expect(find.byType(Tab), findsNWidgets(4));
  });

  testWidgets('?pestana=emitidas&filtro=vencidas abre Emitidas con Vencidas elegido', (t) async {
    await t.pumpWidget(app(pestana: 'emitidas', filtro: 'vencidas'));
    await t.pumpAndSettle();
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Vencidas')).selected, isTrue);
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Todas')).selected, isFalse);
  });

  testWidgets('?pestana=emitidas&filtro=proximas abre Emitidas con Próximas a vencer elegido', (t) async {
    await t.pumpWidget(app(pestana: 'emitidas', filtro: 'proximas'));
    await t.pumpAndSettle();
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Próximas a vencer')).selected, isTrue);
  });

  testWidgets('el filtro de Arriendos en curso (aviso) no afecta a Emitidas', (t) async {
    await t.pumpWidget(app(pestana: 'emitidas', filtro: 'aviso'));
    await t.pumpAndSettle();
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Todas')).selected, isTrue);
  });

  testWidgets('un fallo de /pendientes no deja sin pantalla a las facturas emitidas', (t) async {
    await t.pumpWidget(app(pestana: 'emitidas'));
    await t.pumpAndSettle();
    // las pestañas que dependen de /pendientes dicen su error; Emitidas muestra su propia pantalla
    expect(find.widgetWithText(ChoiceChip, 'Por cobrar'), findsOneWidget);
  });
}
