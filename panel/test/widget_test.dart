import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:gomaq_web/main.dart';

void main() {
  testWidgets('La app arranca y muestra la pantalla de login', (WidgetTester tester) async {
    // Sin sesion guardada: el almacenamiento seguro no existe en las pruebas, se simula vacio.
    FlutterSecureStorage.setMockInitialValues({});

    await tester.pumpWidget(const GomaqWebApp());
    await tester.pumpAndSettle();

    // El logotipo de la pantalla de login es una imagen con la etiqueta "GOMAQ" para el lector de pantalla.
    expect(find.byWidgetPredicate((w) => w is Image && w.semanticLabel == 'GOMAQ'), findsOneWidget);
    expect(find.text('Ingresar'), findsWidgets);
  });
}
