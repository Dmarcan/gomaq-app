import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/clientes_screen.dart';
import 'package:gomaq_web/screens/panel/vehiculos_screen.dart';
import 'package:gomaq_web/services/auth_service.dart';
import 'package:gomaq_web/widgets/estado_vacio.dart';
import 'package:provider/provider.dart';

/// Un cliente HTTP que nunca consigue conectarse: lo que pasa sin internet. El ApiClient del panel
/// es un singleton, así que se corta la red por debajo (HttpOverrides) y se prueba la pantalla real.
class _SinRed implements HttpClient {
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) => Future.error(const SocketException('sin red'));

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _OverridesSinRed extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _SinRed();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    HttpOverrides.global = _OverridesSinRed();
    // flutter_secure_storage (la sesión) no existe en las pruebas: devuelve vacío
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (_) async => null);
  });

  tearDown(() => HttpOverrides.global = null);

  Widget app(Widget pantalla) => ChangeNotifierProvider<AuthService>(
        create: (_) => AuthService(),
        child: MaterialApp(home: Scaffold(body: pantalla)),
      );

  testWidgets('Vehículos sin red muestra el error con Reintentar, no una lista vacía', (tester) async {
    await tester.pumpWidget(app(const VehiculosScreen()));
    await tester.pumpAndSettle();
    expect(find.byType(EstadoError), findsOneWidget);
    expect(find.textContaining('Sin conexión'), findsOneWidget);
    expect(find.text('Reintentar'), findsOneWidget);
  });

  testWidgets('Clientes sin red muestra el error con Reintentar, no "Aún no hay clientes"', (tester) async {
    await tester.pumpWidget(app(const ClientesScreen()));
    await tester.pumpAndSettle();
    expect(find.byType(EstadoError), findsWidgets);
    expect(find.textContaining('Aún no hay'), findsNothing);
    expect(find.text('Reintentar'), findsWidgets);
  });

  test('mensajeErrorCarga: los errores de red no se leen como vacío', () {
    for (final e in [const SocketException('x'), TimeoutException('x'), Exception('x')]) {
      expect(mensajeErrorCarga(e), startsWith('Sin conexión'));
    }
  });
}
