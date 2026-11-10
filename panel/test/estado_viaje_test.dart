import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/mapa_screen.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';
import 'package:gomaq_web/utils/ubicacion.dart';

/// "Detenido" y "sin posición" se dicen distinto: un furgón parado en un taco no es uno cuya app
/// dejó de enviar. El panel nunca afirma "sin señal", dice desde qué hora no llega una posición.

final _ahora = DateTime(2026, 11, 9, 12, 0);
DateTime _hace(int minutos) => _ahora.subtract(Duration(minutes: minutos));

FurgonMapa _furgon({int? posicionHace, int? quietoHace, bool conUbicacion = true, int? maquinariaId = 44}) => FurgonMapa(
  ordenTrabajoId: 9,
  mecanicoNombre: 'Pedro',
  clienteNombre: 'Acsa',
  maquinariaId: maquinariaId,
  maquinariaCodigo: 'EQ-1',
  ubicacion: conUbicacion ? const Coordenada(-33.4, -70.6) : null,
  posicionAt: posicionHace == null ? null : _hace(posicionHace),
  quietoDesde: quietoHace == null ? null : _hace(quietoHace),
);

void main() {
  group('estadoViaje', () {
    test('sin posición todavía', () {
      expect(estadoViaje(_furgon(conUbicacion: false), _ahora), EstadoViaje.sinPosicion);
      expect(estadoViaje(_furgon(), _ahora), EstadoViaje.sinPosicion, reason: 'sin hora de posición');
    });

    test('posición reciente y moviéndose', () {
      expect(estadoViaje(_furgon(posicionHace: 2, quietoHace: 0), _ahora), EstadoViaje.enMovimiento);
      expect(estadoViaje(_furgon(posicionHace: 2), _ahora), EstadoViaje.enMovimiento, reason: 'APK o servidor antiguo sin quieto_desde');
    });

    test('quieto 5 min o más con posición fresca es detenido; menos no', () {
      expect(estadoViaje(_furgon(posicionHace: 1, quietoHace: 4), _ahora), EstadoViaje.enMovimiento);
      expect(estadoViaje(_furgon(posicionHace: 1, quietoHace: 5), _ahora), EstadoViaje.detenido);
      expect(estadoViaje(_furgon(posicionHace: 1, quietoHace: 40), _ahora), EstadoViaje.detenido);
    });

    test('posición de hace más de 15 min es sin señal aunque esté "quieto"', () {
      expect(estadoViaje(_furgon(posicionHace: 15, quietoHace: 30), _ahora), EstadoViaje.detenido, reason: '15 min justos aún es reciente');
      expect(estadoViaje(_furgon(posicionHace: 16, quietoHace: 30), _ahora), EstadoViaje.sinSenal);
    });
  });

  group('textoEstadoViaje', () {
    test('detenido dice hace cuánto', () {
      expect(textoEstadoViaje(_furgon(posicionHace: 1, quietoHace: 22), _ahora), 'Detenido hace 22 min');
    });

    test('sin posición reciente dice desde qué hora, sin afirmar "sin señal"', () {
      final t = textoEstadoViaje(_furgon(posicionHace: 45), DateTime(2026, 11, 9, 12, 0))!;
      expect(t, 'Sin posición desde las 11:15');
      expect(t.toLowerCase(), isNot(contains('señal')));
    });

    test('en movimiento o sin posición no hay nada que decir', () {
      expect(textoEstadoViaje(_furgon(posicionHace: 1, quietoHace: 0), _ahora), isNull);
      expect(textoEstadoViaje(_furgon(conUbicacion: false), _ahora), isNull);
    });
  });

  test('FurgonMapa.fromJson lee maquinaria_id y quieto_desde; sin ellos (servidor anterior) no rompe', () {
    final con = FurgonMapa.fromJson({
      'orden_trabajo_id': 9,
      'maquinaria_id': 44,
      'maquinaria_codigo': 'EQ-1',
      'latitud': -33.4,
      'longitud': -70.6,
      'quieto_desde': '2026-11-09T14:40:00.000Z',
    });
    expect(con.maquinariaId, 44);
    expect(con.quietoDesde, isNotNull);
    final sin = FurgonMapa.fromJson({'orden_trabajo_id': 9, 'maquinaria_codigo': 'EQ-1'});
    expect(sin.maquinariaId, isNull);
    expect(sin.quietoDesde, isNull);
  });

  group('ficha del furgón', () {
    Widget app(FurgonMapa f) => MaterialApp(
      home: Scaffold(
        body: MapaScreen(
          conMapa: false,
          cargar: () async => DatosMapa(
            bodega: const BodegaMapa(id: 1, nombre: 'Bodega central', ubicacion: Coordenada(-33.5, -70.7)),
            furgones: [f],
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

    FurgonMapa reciente({int? quietoMin, int posMin = 1, int? maq = 44}) {
      final ahora = DateTime.now();
      return FurgonMapa(
        ordenTrabajoId: 9,
        mecanicoNombre: 'Pedro',
        clienteNombre: 'Acsa',
        maquinariaId: maq,
        maquinariaCodigo: 'EQ-1',
        ubicacion: const Coordenada(-33.4, -70.6),
        posicionAt: ahora.subtract(Duration(minutes: posMin)),
        quietoDesde: quietoMin == null ? null : ahora.subtract(Duration(minutes: quietoMin)),
      );
    }

    testWidgets('un furgón detenido lo dice en la ficha y en la lista, con Ver equipo', (t) async {
      tamano(t);
      await t.pumpWidget(app(reciente(quietoMin: 20)));
      await t.pumpAndSettle();
      expect(find.textContaining('Detenido hace 20 min'), findsOneWidget, reason: 'en la lista');
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.textContaining('Detenido hace 20 min'), findsNWidgets(2), reason: 'lista y ficha');
      expect(find.text('Ver OT'), findsOneWidget);
      expect(find.text('Ver equipo'), findsOneWidget);
    });

    testWidgets('con posición vieja dice desde qué hora y explica Maps o Waze', (t) async {
      tamano(t);
      await t.pumpWidget(app(reciente(posMin: 40)));
      await t.pumpAndSettle();
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.textContaining('Sin posición desde las'), findsWidgets);
      expect(find.textContaining('puede ir en Maps o Waze y la app no alcanzó'), findsOneWidget);
    });

    testWidgets('sin maquinaria_id (servidor anterior) no muestra Ver equipo', (t) async {
      tamano(t);
      await t.pumpWidget(app(reciente(maq: null)));
      await t.pumpAndSettle();
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.text('Ver OT'), findsOneWidget);
      expect(find.text('Ver equipo'), findsNothing);
    });

    testWidgets('en movimiento no agrega ningún aviso', (t) async {
      tamano(t);
      await t.pumpWidget(app(reciente(quietoMin: 0)));
      await t.pumpAndSettle();
      await t.tap(find.text('Pedro'));
      await t.pumpAndSettle();
      expect(find.textContaining('Detenido'), findsNothing);
      expect(find.textContaining('Sin posición'), findsNothing);
    });
  });
}
