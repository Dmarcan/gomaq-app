import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/mapa_screen.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';
import 'package:gomaq_web/utils/ubicacion.dart';

/// Los iconos de equipos arrendados que a este zoom se tocarían en pantalla se juntan en uno
/// ("N equipos cercanos"); al acercar el mapa se separan. El seleccionado nunca se funde.

EquipoMapa _equipo(int id, Coordenada u) => EquipoMapa(
  id: id,
  codigo: 'EQ-$id',
  tipo: 'Grúa',
  estado: 'operativa',
  arrendado: true,
  clienteNombre: 'Cliente $id',
  ubicacion: u,
);

// 0,001 grados son ~111 m: a zoom 15 son ~28 px; a zoom 10 son menos de 1 px
Coordenada _a(double dLat) => Coordenada(-33.45 + dLat, -70.65);

List<List<EquipoMapa>> _grupos(List<EquipoMapa> equipos) => agruparPorPunto(equipos);

void main() {
  group('agruparCercanos', () {
    test('dos puntos cercanos a poco zoom se juntan; a mucho zoom no', () {
      final grupos = _grupos([_equipo(1, _a(0)), _equipo(2, _a(0.001))]);
      expect(agruparCercanos(grupos, 10), hasLength(1));
      expect(agruparCercanos(grupos, 10).single, hasLength(2));
      expect(agruparCercanos(grupos, 18), hasLength(2), reason: 'a zoom 18 están a ~220 px');
    });

    test('puntos lejanos nunca se juntan', () {
      final grupos = _grupos([_equipo(1, _a(0)), _equipo(2, _a(0.5))]);
      expect(agruparCercanos(grupos, 10), hasLength(2));
    });

    test('el resultado no depende del orden de entrada', () {
      final g = _grupos([_equipo(1, _a(0)), _equipo(2, _a(0.0005)), _equipo(3, _a(0.5))]);
      String firma(List<List<List<EquipoMapa>>> r) =>
          (r.map((c) => c.map((x) => x.map((e) => e.id).join('+')).join(',')).toList()..sort()).join('|');
      expect(firma(agruparCercanos(g, 12)), firma(agruparCercanos(g.reversed.toList(), 12)));
    });

    test('el grupo fijo (seleccionado) nunca se funde con otro', () {
      final grupos = _grupos([_equipo(1, _a(0)), _equipo(2, _a(0.0005))]);
      final r = agruparCercanos(grupos, 10, fijo: (g) => g.any((e) => e.id == 1));
      expect(r, hasLength(2));
      expect(r.every((c) => c.length == 1), isTrue);
    });

    test('centroGrupos promedia los puntos', () {
      final c = centroGrupos(_grupos([_equipo(1, _a(0)), _equipo(2, _a(0.002))]));
      expect(c.latitud, closeTo(-33.449, 1e-9));
      expect(c.longitud, closeTo(-70.65, 1e-9));
    });

    test('sin grupos devuelve vacío', () {
      expect(agruparCercanos(const [], 10), isEmpty);
    });
  });

  group('en el mapa', () {
    Widget app(List<EquipoMapa> equipos) => MaterialApp(
      home: Scaffold(
        body: MapaScreen(
          capaImagenes: () => const SizedBox.shrink(),
          cargar: () async => DatosMapa(
            bodega: const BodegaMapa(id: 1, nombre: 'Bodega central', ubicacion: Coordenada(-33.5, -70.7)),
            equipos: equipos,
          ),
        ),
      ),
    );

    void tamano(WidgetTester t) {
      t.view.physicalSize = const Size(1200, 800);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.resetPhysicalSize);
      addTearDown(t.view.resetDevicePixelRatio);
    }

    testWidgets('dos clientes muy cerca se ven como un icono de equipos cercanos que acerca el mapa al tocarlo', (t) async {
      final h = t.ensureSemantics();
      tamano(t);
      await t.pumpWidget(app([_equipo(1, _a(0)), _equipo(2, _a(0.0004))]));
      await t.pumpAndSettle();
      final cumulo = find.bySemanticsLabel(RegExp('2 equipos arrendados cercanos'));
      expect(cumulo, findsOneWidget);
      expect(find.bySemanticsLabel('Arrendado: Cliente 1'), findsNothing);
      await t.tap(cumulo);
      await t.pumpAndSettle();
      // al acercar se separan: cada cliente vuelve a tener su icono
      expect(find.bySemanticsLabel('Arrendado: Cliente 1'), findsOneWidget);
      expect(find.bySemanticsLabel('Arrendado: Cliente 2'), findsOneWidget);
      h.dispose();
    });

    testWidgets('clientes lejanos conservan su icono', (t) async {
      final h = t.ensureSemantics();
      tamano(t);
      await t.pumpWidget(app([_equipo(1, _a(0)), _equipo(2, _a(0.3))]));
      await t.pumpAndSettle();
      expect(find.bySemanticsLabel('Arrendado: Cliente 1'), findsOneWidget);
      expect(find.bySemanticsLabel('Arrendado: Cliente 2'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('cercanos')), findsNothing);
      h.dispose();
    });
  });
}
