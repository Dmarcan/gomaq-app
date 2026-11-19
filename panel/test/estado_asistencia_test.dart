import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/theme/gomaq_theme.dart';
import 'package:gomaq_web/widgets/estado_chip.dart';
import 'package:gomaq_web/widgets/estado_equipo.dart';

void main() {
  test('parcialmente operativa se ve como advertencia, no como error', () {
    expect(GomaqColors.colorEstado('parcialmente_operativa'), GomaqColors.estadoAdvertencia);
    expect(GomaqColors.etiquetaEstado('parcialmente_operativa'), 'Parcialmente operativa');
  });

  test('asistencia pedida tiene su propio color, distinto de los estados del equipo', () {
    final color = GomaqColors.colorEstado('asistencia_pedida');
    expect(color, GomaqColors.estadoAsistencia);
    for (final e in ['operativa', 'parcialmente_operativa', 'en_mantencion', 'fuera_de_servicio']) {
      expect(GomaqColors.colorEstado(e), isNot(color), reason: e);
    }
    expect(GomaqColors.etiquetaEstado('asistencia_pedida'), 'Asistencia pedida');
  });

  testWidgets('el chip de asistencia pedida lleva texto e icono, no solo color', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: EstadoChip(estado: 'asistencia_pedida', icono: Icons.support_agent)),
    ));
    expect(find.text('Asistencia pedida'), findsOneWidget);
    expect(find.byIcon(Icons.support_agent), findsOneWidget);
  });

  testWidgets('el estado parcialmente operativa de un equipo lleva icono y texto', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: EstadoEquipo(estado: 'parcialmente_operativa'))));
    expect(find.text('Parcialmente operativa'), findsOneWidget);
    expect(find.byIcon(Icons.warning_amber_outlined), findsOneWidget);
  });
}
