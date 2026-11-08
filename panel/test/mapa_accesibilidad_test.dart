import 'dart:ui' show CheckedState, Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/mapa_screen.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';
import 'package:gomaq_web/utils/ubicacion.dart';

/// Pruebas de accesibilidad del mapa: lo que lee un lector de pantalla y lo que se puede hacer solo
/// con el teclado (WCAG 1.3.1, 2.1.1, 4.1.2).

EquipoMapa _equipo(int id, {bool arrendado = true, Coordenada? u = const Coordenada(-33.45, -70.65)}) => EquipoMapa(
  id: id,
  codigo: 'EQ-$id',
  tipo: 'Grúa',
  estado: 'operativa',
  arrendado: arrendado,
  clienteNombre: arrendado ? 'Acsa' : null,
  ubicacion: u,
);

DatosMapa _datos() => DatosMapa(
  bodega: const BodegaMapa(id: 1, nombre: 'Bodega central', ubicacion: Coordenada(-33.5, -70.7)),
  equipos: [
    _equipo(1),
    _equipo(2, arrendado: false, u: const Coordenada(-33.5, -70.7)),
    _equipo(3, arrendado: false, u: const Coordenada(-33.5, -70.7)),
    _equipo(4, arrendado: false, u: const Coordenada(-33.5, -70.7)),
  ],
  furgones: [
    FurgonMapa(
      ordenTrabajoId: 9,
      mecanicoNombre: 'Pedro',
      clienteNombre: 'Acsa',
      maquinariaCodigo: 'EQ-1',
      ubicacion: const Coordenada(-33.4, -70.6),
      posicionAt: DateTime.now().subtract(const Duration(minutes: 40)),
    ),
  ],
);

Widget _app() => MaterialApp(
  home: Scaffold(
    body: MapaScreen(cargar: () async => _datos(), capaImagenes: () => const SizedBox.shrink()),
  ),
);

void _tamano(WidgetTester t) {
  t.view.physicalSize = const Size(1200, 900);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('los títulos son encabezados para el lector de pantalla', (t) async {
    final h = t.ensureSemantics();
    _tamano(t);
    await t.pumpWidget(_app());
    await t.pumpAndSettle();
    expect(t.getSemantics(find.text('Mapa operativo')).flagsCollection.isHeader, isTrue);
    expect(t.getSemantics(find.textContaining('Furgones en camino (1)').last).flagsCollection.isHeader, isTrue);
    h.dispose();
  });

  testWidgets('cada icono dice qué es y cuántos equipos agrupa (no un número suelto)', (t) async {
    final h = t.ensureSemantics();
    _tamano(t);
    await t.pumpWidget(_app());
    await t.pumpAndSettle();
    expect(find.bySemanticsLabel('Bodega central, 3 equipos'), findsOneWidget);
    expect(find.bySemanticsLabel('Arrendado: Acsa'), findsOneWidget);
    // la posición vieja se dice con palabras, no solo con el color gris
    expect(find.bySemanticsLabel(RegExp('Furgón de Pedro, posición de hace más de 15 minutos')), findsOneWidget);
    h.dispose();
  });

  testWidgets('el icono es un botón que se alcanza con Tab y se abre con Enter', (t) async {
    final h = t.ensureSemantics();
    _tamano(t);
    await t.pumpWidget(_app());
    await t.pumpAndSettle();
    final bodega = find.bySemanticsLabel('Bodega central, 3 equipos');
    expect(t.getSemantics(bodega).flagsCollection.isButton, isTrue);

    var enfocado = false;
    for (var i = 0; i < 25 && !enfocado; i++) {
      await t.sendKeyEvent(LogicalKeyboardKey.tab);
      await t.pump();
      enfocado = t.getSemantics(bodega).flagsCollection.isFocused == Tristate.isTrue;
    }
    expect(enfocado, isTrue, reason: 'el icono de la bodega no recibió el foco con Tab');

    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pumpAndSettle();
    expect(find.text('3 equipos'), findsOneWidget, reason: 'Enter debe abrir la ficha de la bodega');
    h.dispose();
  });

  testWidgets('el estado del equipo se lee como texto y no como casilla', (t) async {
    final h = t.ensureSemantics();
    _tamano(t);
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MapaScreen(
            conMapa: false,
            cargar: () async => DatosMapa(
              bodega: const BodegaMapa(id: 1, nombre: 'Bodega central'),
              equipos: [_equipo(1, u: null)],
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    // la fila del equipo fusiona sus textos en una sola lectura: "EQ-1, Grúa, Cliente..., Estado: Operativa"
    final estado = find.bySemanticsLabel(RegExp('Estado: Operativa'));
    expect(estado, findsOneWidget);
    expect(t.getSemantics(estado).flagsCollection.isChecked, CheckedState.none, reason: 'no debe leerse como casilla');
    h.dispose();
  });

  testWidgets('el campo de búsqueda tiene una etiqueta visible que no desaparece al escribir', (t) async {
    _tamano(t);
    await t.pumpWidget(_app());
    await t.pumpAndSettle();
    expect(find.text('Buscar equipo, cliente o técnico'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'acsa');
    await t.pumpAndSettle();
    expect(find.text('Buscar equipo, cliente o técnico'), findsOneWidget);
  });

  testWidgets('un filtro apagado se distingue sin depender del color: borde fino y texto normal', (t) async {
    _tamano(t);
    await t.pumpWidget(_app());
    await t.pumpAndSettle();
    final chip = find.widgetWithText(FilterChip, 'En bodega (3)');
    FilterChip actual() => t.widget<FilterChip>(chip);
    expect(actual().side!.width, 2, reason: 'activo: borde grueso');
    expect(actual().label is Text && (actual().label as Text).style!.fontWeight == FontWeight.w700, isTrue);
    await t.tap(chip);
    await t.pumpAndSettle();
    expect(actual().side!.width, 1, reason: 'apagado: borde fino');
    expect((actual().label as Text).style!.fontWeight, FontWeight.w400);
  });
}
