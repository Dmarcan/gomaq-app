import 'package:flutter_test/flutter_test.dart';

import 'package:gomaq_web/main.dart';

void main() {
  testWidgets('La app arranca y muestra la pantalla de login', (WidgetTester tester) async {
    await tester.pumpWidget(const GomaqWebApp());
    await tester.pump();

    expect(find.text('GOMAQ'), findsOneWidget);
  });
}
