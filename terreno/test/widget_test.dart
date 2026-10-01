import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:gomaq_mecanico/main.dart';

void main() {
  testWidgets('La app arranca y muestra la pantalla de login', (WidgetTester tester) async {
    // Sin sesion guardada: el almacenamiento seguro no existe en las pruebas, se simula vacio.
    FlutterSecureStorage.setMockInitialValues({});

    await tester.pumpWidget(const GomaqMecanicoApp());
    await tester.pumpAndSettle();

    expect(find.text('ACCESO A GOMAQ'), findsOneWidget);
  });
}
