import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/mapa_screen.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';
import 'package:gomaq_web/utils/ubicacion.dart';
import 'utils/tamano.dart';

DatosMapa _datos({BodegaMapa? bodega}) => DatosMapa(bodega: bodega, equipos: const [], furgones: const []);

Widget _app(MapaScreen m) => MaterialApp(home: Scaffold(body: m));

void main() {
  testWidgets('sin ubicación: tarjeta destacada con aviso y botón principal', (t) async {
    fijarTamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(
      cargar: () async => _datos(bodega: const BodegaMapa(id: 1, nombre: 'Bodega', ubicacion: null)),
      conMapa: false,
    )));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('La bodega no tiene ubicación'), findsOneWidget);
    expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget, reason: 'el estado no va solo en color');
    expect(find.widgetWithText(FilledButton, 'Cargar ubicación'), findsOneWidget);
    expect(find.text('Bodega ubicada'), findsNothing);
    final tarjeta = t.widget<Card>(find.ancestor(of: find.text('La bodega no tiene ubicación'), matching: find.byType(Card)).first);
    expect((tarjeta.shape! as RoundedRectangleBorder).side.width, greaterThan(1), reason: 'lleva borde');
  });

  testWidgets('ubicada: una línea chica con centrar y cambiar, sin desbordar a 375 px', (t) async {
    fijarTamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(
      cargar: () async => _datos(bodega: const BodegaMapa(id: 1, nombre: 'Bodega', ubicacion: Coordenada(-33.5, -70.7))),
      conMapa: false,
    )));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('Bodega ubicada'), findsOneWidget);
    expect(find.text('Cambiar ubicación'), findsOneWidget);
    expect(find.byTooltip('Centrar el mapa en la bodega'), findsOneWidget);
    expect(find.text('La bodega no tiene ubicación'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Cargar ubicación'), findsNothing);
  });

  testWidgets('sin bodega registrada: solo el aviso, sin botones', (t) async {
    fijarTamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(), conMapa: false)));
    await t.pumpAndSettle();
    expect(find.text('No hay una bodega registrada.'), findsOneWidget);
    expect(find.text('Cargar ubicación'), findsNothing);
    expect(find.byTooltip('Centrar el mapa en la bodega'), findsNothing);
  });

  testWidgets('centrar el mapa en la bodega mueve la cámara a su ubicación', (t) async {
    fijarTamano(t, const Size(1200, 800));
    await t.pumpWidget(_app(MapaScreen(
      // un equipo lejos de la bodega: el encuadre inicial abarca los dos y no queda centrado en la bodega
      cargar: () async => DatosMapa(
        bodega: const BodegaMapa(id: 1, nombre: 'Bodega', ubicacion: Coordenada(-33.5, -70.7)),
        equipos: const [
          EquipoMapa(
            id: 1,
            codigo: 'EQ-1',
            tipo: 'Grúa',
            estado: 'operativa',
            arrendado: true,
            clienteNombre: 'Acsa',
            ubicacion: Coordenada(-34.5, -71.7),
          ),
        ],
        furgones: const [],
      ),
      capaImagenes: () => const SizedBox.shrink(),
    )));
    await t.pumpAndSettle();
    final controlador = t.widget<FlutterMap>(find.byType(FlutterMap)).mapController!;
    expect((controlador.camera.center.latitude + 33.5).abs(), greaterThan(0.01), reason: 'parte lejos de la bodega');
    await t.tap(find.byTooltip('Centrar el mapa en la bodega'));
    await t.pumpAndSettle();
    expect(controlador.camera.center.latitude, closeTo(-33.5, 1e-6));
    expect(controlador.camera.center.longitude, closeTo(-70.7, 1e-6));
  });
}
