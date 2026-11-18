import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/facturacion_screen.dart';
import 'package:gomaq_web/screens/panel/facturas_emitidas_screen.dart';
import 'package:gomaq_web/services/auth_service.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';

/// Facturas emitidas tiene su propia pantalla (`/facturas?filtro=vencidas`). Sin servidor las
/// consultas fallan: la prueba mira el filtro elegido, que no depende de la respuesta.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => initializeDateFormatting('es_CL'));

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (_) async => null);
  });

  Widget app({String? filtro}) => ChangeNotifierProvider<AuthService>(
        create: (_) => AuthService(),
        child: MaterialApp(home: FacturasEmitidasScreen(filtroInicial: filtro)),
      );

  testWidgets('Facturar quedó con tres pestañas y sin Emitidas', (t) async {
    await t.pumpWidget(ChangeNotifierProvider<AuthService>(
      create: (_) => AuthService(),
      child: const MaterialApp(home: FacturacionScreen()),
    ));
    await t.pumpAndSettle();
    expect(find.text('Emitidas'), findsNothing);
    expect(find.text('Arriendos en curso'), findsOneWidget);
    expect(find.byType(Tab), findsNWidgets(3));
  });

  testWidgets('?filtro=vencidas abre con Vencidas elegido', (t) async {
    await t.pumpWidget(app(filtro: 'vencidas'));
    await t.pumpAndSettle();
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Vencidas')).selected, isTrue);
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Todas')).selected, isFalse);
  });

  testWidgets('?filtro=proximas abre con Próximas a vencer elegido', (t) async {
    await t.pumpWidget(app(filtro: 'proximas'));
    await t.pumpAndSettle();
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Próximas a vencer')).selected, isTrue);
  });

  testWidgets('un filtro ajeno (aviso) deja la lista completa', (t) async {
    await t.pumpWidget(app(filtro: 'aviso'));
    await t.pumpAndSettle();
    expect(t.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Todas')).selected, isTrue);
  });
}
