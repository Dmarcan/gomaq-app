import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/mapa_screen.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';
import 'package:gomaq_web/utils/ubicacion.dart';

/// La OT abierta de un equipo se dice como texto en su ficha (no hay capa de OT en el mapa), y el
/// furgón seleccionado dibuja una línea punteada recta hasta el equipo al que va.

const _punto = Coordenada(-33.45, -70.65);

EquipoMapa _equipo({OrdenAbiertaMapa? ot, Coordenada? u = _punto}) => EquipoMapa(
  id: 44,
  codigo: 'EQ-44',
  tipo: 'Grúa',
  estado: 'operativa',
  arrendado: true,
  clienteNombre: 'Acsa',
  ubicacion: u,
  ordenAbierta: ot,
);

FurgonMapa _furgon({int? maquinariaId = 44, int posicionHace = 1}) => FurgonMapa(
  ordenTrabajoId: 9,
  mecanicoNombre: 'Pedro',
  clienteNombre: 'Acsa',
  maquinariaId: maquinariaId,
  maquinariaCodigo: 'EQ-44',
  ubicacion: const Coordenada(-33.42, -70.61),
  posicionAt: DateTime.now().subtract(Duration(minutes: posicionHace)),
);

Widget _app(DatosMapa d, {bool conMapa = false}) => MaterialApp(
  home: Scaffold(
    body: MapaScreen(conMapa: conMapa, cargar: () async => d, capaImagenes: () => const SizedBox.shrink()),
  ),
);

DatosMapa _datos({List<EquipoMapa>? equipos, List<FurgonMapa> furgones = const []}) => DatosMapa(
  bodega: const BodegaMapa(id: 1, nombre: 'Bodega central', ubicacion: Coordenada(-33.5, -70.7)),
  equipos: equipos ?? [_equipo()],
  furgones: furgones,
);

void _tamano(WidgetTester t) {
  t.view.physicalSize = const Size(1200, 800);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}

void main() {
  group('OrdenAbiertaMapa', () {
    test('resumen con y sin técnico, y estados legibles', () {
      expect(const OrdenAbiertaMapa(id: 2049, estado: 'asignada', mecanicoNombre: 'Pedro').resumen, 'OT-2049 · Asignada · Pedro');
      expect(const OrdenAbiertaMapa(id: 2051, estado: 'pendiente').resumen, 'OT-2051 · Pendiente');
      expect(const OrdenAbiertaMapa(id: 1, estado: 'en_reparacion').estadoLegible, 'En reparación');
      expect(const OrdenAbiertaMapa(id: 1, estado: 'raro').estadoLegible, 'raro');
    });

    test('EquipoMapa.fromJson lee orden_abierta; sin ella (o servidor anterior) es null', () {
      final base = {'id': 1, 'codigo': 'EQ-1', 'tipo': 'Grúa', 'estado': 'operativa', 'situacion': 'arrendado'};
      final con = EquipoMapa.fromJson({
        ...base,
        'orden_abierta': {'id': 2049, 'estado': 'en_camino', 'mecanico_nombre': 'Pedro'},
      });
      expect(con.ordenAbierta!.id, 2049);
      expect(con.ordenAbierta!.mecanicoNombre, 'Pedro');
      expect(EquipoMapa.fromJson({...base, 'orden_abierta': null}).ordenAbierta, isNull);
      expect(EquipoMapa.fromJson(base).ordenAbierta, isNull);
    });
  });

  group('distancia', () {
    test('distanciaMetros: un grado de latitud son unos 111 km, y un punto consigo mismo es 0', () {
      expect(distanciaMetros(_punto, _punto), 0);
      expect(distanciaMetros(const Coordenada(0, 0), const Coordenada(1, 0)), closeTo(111195, 200));
    });

    test('textoDistancia: metros redondeados a 10, km con coma y un decimal', () {
      expect(textoDistancia(847), '850 m');
      expect(textoDistancia(40), '40 m');
      expect(textoDistancia(3240), '~3,2 km');
      expect(textoDistancia(12000), '~12,0 km');
    });
  });

  group('ficha', () {
    testWidgets('el equipo con una OT abierta lo dice con texto y trae Ver OT y Ver equipo', (t) async {
      _tamano(t);
      await t.pumpWidget(_app(_datos(equipos: [_equipo(ot: const OrdenAbiertaMapa(id: 2049, estado: 'asignada', mecanicoNombre: 'Pedro'))])));
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField), 'EQ-44');
      await t.pumpAndSettle();
      await t.tap(find.text('EQ-44').last);
      await t.pumpAndSettle();
      expect(find.text('OT-2049 · Asignada · Pedro'), findsOneWidget);
      expect(find.text('Ver OT'), findsOneWidget);
      expect(find.text('Ver equipo'), findsOneWidget);
    });

    testWidgets('un equipo sin OT abierta no muestra la línea ni Ver OT', (t) async {
      _tamano(t);
      await t.pumpWidget(_app(_datos()));
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField), 'EQ-44');
      await t.pumpAndSettle();
      await t.tap(find.text('EQ-44').last);
      await t.pumpAndSettle();
      expect(find.textContaining('OT-'), findsNothing);
      expect(find.text('Ver OT'), findsNothing);
      expect(find.text('Ver equipo'), findsOneWidget);
    });

    testWidgets('la ficha del furgón dice cuánto le queda en línea recta al equipo al que va', (t) async {
      _tamano(t);
      await t.pumpWidget(_app(_datos(furgones: [_furgon()])));
      await t.pumpAndSettle();
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.textContaining('en línea recta (no es la ruta)'), findsOneWidget);
    });

    testWidgets('con posición vieja o sin equipo ubicado no dice la distancia', (t) async {
      _tamano(t);
      await t.pumpWidget(_app(_datos(furgones: [_furgon(posicionHace: 40)])));
      await t.pumpAndSettle();
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.textContaining('en línea recta'), findsNothing);
    });

    testWidgets('si el equipo al que va no tiene ubicación no dice la distancia', (t) async {
      _tamano(t);
      await t.pumpWidget(_app(_datos(equipos: [_equipo(u: null)], furgones: [_furgon()])));
      await t.pumpAndSettle();
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.textContaining('en línea recta'), findsNothing);
    });
  });

  group('línea punteada en el mapa', () {
    testWidgets('solo con un furgón seleccionado, con posición reciente y su equipo en el mapa', (t) async {
      _tamano(t);
      await t.pumpWidget(_app(_datos(furgones: [_furgon()]), conMapa: true));
      await t.pumpAndSettle();
      expect(find.byType(PolylineLayer), findsNothing, reason: 'sin selección no hay línea');
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.byType(PolylineLayer), findsOneWidget);
      await t.sendKeyEvent(LogicalKeyboardKey.escape);
      await t.pumpAndSettle();
      expect(find.byType(PolylineLayer), findsNothing, reason: 'al cerrar la ficha se va la línea');
    });

    testWidgets('con posición vieja no se dibuja', (t) async {
      _tamano(t);
      await t.pumpWidget(_app(_datos(furgones: [_furgon(posicionHace: 40)]), conMapa: true));
      await t.pumpAndSettle();
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.byType(PolylineLayer), findsNothing);
    });
  });
}
