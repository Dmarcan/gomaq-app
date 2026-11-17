import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/mapa_screen.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';
import 'package:gomaq_web/utils/ubicacion.dart';

EquipoMapa _equipo(int id, {bool arrendado = true, Coordenada? u = const Coordenada(-33.45, -70.65)}) => EquipoMapa(
      id: id,
      codigo: 'EQ-$id',
      tipo: 'Grúa',
      estado: 'operativa',
      arrendado: arrendado,
      clienteNombre: arrendado ? 'Acsa' : null,
      ubicacion: u,
    );

DatosMapa _datos({Coordenada? bodega = const Coordenada(-33.5, -70.7)}) => DatosMapa(
      bodega: BodegaMapa(id: 1, nombre: 'Bodega central', ubicacion: bodega),
      equipos: [
        _equipo(1),
        _equipo(2, arrendado: false, u: bodega),
        _equipo(3, u: null),
      ],
      furgones: const [
        FurgonMapa(ordenTrabajoId: 9, mecanicoNombre: 'Pedro', clienteNombre: 'Acsa', maquinariaCodigo: 'EQ-1'),
      ],
    );

Widget _app(Widget hijo) => MaterialApp(home: Scaffold(body: hijo));

void _tamano(WidgetTester t, Size s) {
  t.view.physicalSize = s;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('a 375 px se arma sin desbordes y muestra bodega, filtros y las listas', (t) async {
    _tamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(), conMapa: false)));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('Mapa operativo'), findsOneWidget);
    expect(find.byIcon(Icons.refresh), findsNothing, reason: 'el encabezado del panel ya trae el botón de actualizar');
    expect(find.text('Bodega ubicada'), findsOneWidget);
    expect(find.textContaining('Arrendados (2)'), findsOneWidget);
    expect(find.textContaining('En bodega (1)'), findsOneWidget);
    expect(find.widgetWithText(FilterChip, 'Furgones en camino (1)'), findsOneWidget);
    // el equipo sin ubicación y el furgón sin posición están en la lista, no se pierden (a 375 px
    // la lista queda bajo el mapa: se baja hasta ella)
    await t.scrollUntilVisible(find.textContaining('Sin ubicación en el mapa (1)'), 120, scrollable: find.byType(Scrollable).last);
    await t.scrollUntilVisible(find.text('EQ-3'), 120, scrollable: find.byType(Scrollable).last);
    expect(find.text('EQ-3'), findsOneWidget);
  });

  testWidgets('en pantalla ancha usa el panel lateral y tampoco desborda', (t) async {
    _tamano(t, const Size(1200, 800));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(), conMapa: false)));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('EQ-3'), findsOneWidget);
  });

  testWidgets('sin bodega cargada el mapa funciona y avisa en la lista', (t) async {
    _tamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(bodega: null), conMapa: false)));
    await t.pumpAndSettle();
    expect(find.text('La bodega no tiene ubicación'), findsOneWidget);
    expect(find.text('Cargar ubicación'), findsOneWidget);
    await t.scrollUntilVisible(find.textContaining('hasta que cargues'), 120, scrollable: find.byType(Scrollable).last);
    expect(find.textContaining('hasta que cargues la ubicación de la bodega'), findsOneWidget);
    // los dos equipos sin coordenadas (el de la bodega y el arrendado) están en la lista
    expect(find.textContaining('Sin ubicación en el mapa (2)'), findsOneWidget);
  });

  testWidgets('cargar la ubicación de la bodega: usa el GPS, guarda y recarga', (t) async {
    _tamano(t, const Size(375, 812));
    Coordenada? guardada;
    var cargas = 0;
    await t.pumpWidget(_app(MapaScreen(
      cargar: () async {
        cargas++;
        return _datos(bodega: guardada);
      },
      guardarBodega: (c) async => guardada = c,
      obtenerUbicacion: () async => const Coordenada(-33.52, -70.71),
      conMapa: false,
    )));
    await t.pumpAndSettle();
    await t.ensureVisible(find.text('Cargar ubicación'));
    await t.tap(find.text('Cargar ubicación'));
    await t.pumpAndSettle();
    await t.tap(find.text('Usar mi ubicación actual'));
    await t.pumpAndSettle();
    expect(find.textContaining('Ubicación marcada'), findsOneWidget);
    await t.tap(find.text('Guardar'));
    await t.pumpAndSettle();
    expect(guardada, const Coordenada(-33.52, -70.71));
    expect(cargas, 2, reason: 'recarga tras guardar');
    expect(find.text('Bodega ubicada'), findsOneWidget);
    expect(find.textContaining('-33.52'), findsNothing, reason: 'no se muestran coordenadas');
  });

  testWidgets('un error al guardar se muestra en el diálogo y no lo cierra', (t) async {
    _tamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(
      cargar: () async => _datos(bodega: null),
      guardarBodega: (_) async => throw Exception('sin red'),
      obtenerUbicacion: () async => const Coordenada(-33.5, -70.7),
      conMapa: false,
    )));
    await t.pumpAndSettle();
    await t.ensureVisible(find.text('Cargar ubicación'));
    await t.tap(find.text('Cargar ubicación'));
    await t.pumpAndSettle();
    await t.tap(find.text('Usar mi ubicación actual'));
    await t.pumpAndSettle();
    await t.tap(find.text('Guardar'));
    await t.pumpAndSettle();
    expect(find.textContaining('No se pudo guardar'), findsOneWidget);
    expect(find.text('Guardar'), findsOneWidget, reason: 'el diálogo sigue abierto');
  });

  testWidgets('al tocar un furgón en la lista se abre su ficha', (t) async {
    _tamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(), conMapa: false)));
    await t.pumpAndSettle();
    await t.scrollUntilVisible(find.textContaining('todavía sin posición'), 120, scrollable: find.byType(Scrollable).last);
    await t.tap(find.textContaining('todavía sin posición'));
    await t.pumpAndSettle();
    expect(find.text('Furgón de Pedro'), findsOneWidget);
    expect(find.textContaining('Va a: Acsa'), findsOneWidget);
  });

  testWidgets('el buscador deja solo lo que coincide y avisa cuando nada coincide', (t) async {
    _tamano(t, const Size(1200, 800));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(), conMapa: false)));
    await t.pumpAndSettle();
    expect(find.text('Resultados (4)'), findsNothing);
    await t.enterText(find.byType(TextField), 'EQ-3');
    await t.pumpAndSettle();
    expect(find.text('Resultados (1)'), findsOneWidget);
    expect(find.widgetWithText(FilterChip, 'Arrendados (1)'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'zzzz');
    await t.pumpAndSettle();
    expect(find.textContaining('Nada coincide'), findsOneWidget);
    await t.tap(find.byTooltip('Borrar búsqueda'));
    await t.pumpAndSettle();
    expect(find.text('Resultados (4)'), findsNothing);
    expect(find.widgetWithText(FilterChip, 'Arrendados (2)'), findsOneWidget);
  });

  testWidgets('los filtros llevan el icono de su marcador (leyenda) y se dice cuándo se actualizó', (t) async {
    _tamano(t, const Size(1200, 800));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(), conMapa: false)));
    await t.pumpAndSettle();
    expect(find.descendant(of: find.widgetWithText(FilterChip, 'Arrendados (2)'), matching: find.byIcon(Icons.construction)), findsOneWidget);
    expect(find.descendant(of: find.widgetWithText(FilterChip, 'En bodega (1)'), matching: find.byIcon(Icons.warehouse)), findsOneWidget);
    expect(find.descendant(of: find.widgetWithText(FilterChip, 'Furgones en camino (1)'), matching: find.byIcon(Icons.local_shipping)), findsOneWidget);
    expect(find.text('Actualizado hace un momento'), findsOneWidget);
  });

  testWidgets('un furgón con posición vieja se explica en gris y tocarlo abre su ficha', (t) async {
    _tamano(t, const Size(1200, 800));
    final vieja = DateTime.now().subtract(const Duration(minutes: 40));
    await t.pumpWidget(_app(MapaScreen(
      cargar: () async => DatosMapa(
        bodega: const BodegaMapa(id: 1, nombre: 'Bodega central', ubicacion: Coordenada(-33.5, -70.7)),
        equipos: const [],
        furgones: [
          FurgonMapa(ordenTrabajoId: 9, mecanicoNombre: 'Pedro', clienteNombre: 'Acsa', maquinariaCodigo: 'EQ-1', ubicacion: const Coordenada(-33.4, -70.6), posicionAt: vieja),
        ],
      ),
      conMapa: false,
    )));
    await t.pumpAndSettle();
    expect(find.textContaining('En gris: la última posición tiene más de 15 minutos'), findsOneWidget);
    await t.tap(find.text('Pedro'));
    await t.pumpAndSettle();
    expect(find.text('Furgón de Pedro'), findsOneWidget);
  });
}
