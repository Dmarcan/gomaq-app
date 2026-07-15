import 'package:flutter_test/flutter_test.dart';

import 'package:gomaq_mecanico/main.dart';

void main() {
  testWidgets('La app arranca y muestra la pantalla de login', (WidgetTester tester) async {
    await tester.pumpWidget(const GomaqMecanicoApp());
    await tester.pump();

    expect(find.text('GOMAQ Mecanico'), findsOneWidget);
  });
}
