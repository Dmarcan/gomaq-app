import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/mapa_screen.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';
import 'package:gomaq_web/utils/ubicacion.dart';
import 'utils/tamano.dart';

/// La ficha del mapa va en la columna lateral (no es una hoja modal), no oscurece el mapa, se
/// mantiene al dia con cada refresco y se cierra con Esc. El refresco es mas seguido con furgones.

FurgonMapa _furgon({DateTime? posicionAt, int ot = 9}) => FurgonMapa(
  ordenTrabajoId: ot,
  mecanicoNombre: 'Pedro',
  clienteNombre: 'Acsa',
  maquinariaCodigo: 'EQ-1',
  ubicacion: const Coordenada(-33.4, -70.6),
  posicionAt: posicionAt,
);

EquipoMapa _equipo(int id) => EquipoMapa(
  id: id,
  codigo: 'EQ-$id',
  tipo: 'Grúa',
  estado: 'operativa',
  arrendado: true,
  clienteNombre: 'Acsa',
  ubicacion: const Coordenada(-33.45, -70.65),
);

DatosMapa _datos({List<FurgonMapa> furgones = const [], List<EquipoMapa> equipos = const []}) => DatosMapa(
  bodega: const BodegaMapa(id: 1, nombre: 'Bodega central', ubicacion: Coordenada(-33.5, -70.7)),
  equipos: equipos,
  furgones: furgones,
);

Widget _app(MapaScreen mapa) => MaterialApp(home: Scaffold(body: mapa));

void main() {
  testWidgets('tocar un furgón abre la ficha en la columna lateral, sin hoja modal ni barrera', (t) async {
    fijarTamano(t, const Size(1200, 800));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(furgones: [_furgon(posicionAt: DateTime.now())]), conMapa: false)));
    await t.pumpAndSettle();
    await t.tap(find.text('Pedro'));
    await t.pumpAndSettle();
    expect(find.text('Furgón de Pedro'), findsOneWidget);
    expect(find.text('Ver OT'), findsOneWidget);
    expect(find.byType(BottomSheet), findsNothing);
    // la lista sigue visible junto a la ficha
    expect(find.text('Furgones en camino (1)'), findsWidgets);
  });

  testWidgets('la ficha se mantiene al día con cada refresco', (t) async {
    fijarTamano(t, const Size(1200, 800));
    var cargas = 0;
    await t.pumpWidget(_app(MapaScreen(
      refrescoActivo: const Duration(seconds: 5),
      cargar: () async {
        cargas++;
        final hace = cargas == 1 ? const Duration(minutes: 10) : Duration.zero;
        return _datos(furgones: [_furgon(posicionAt: DateTime.now().subtract(hace))]);
      },
      conMapa: false,
    )));
    await t.pumpAndSettle();
    await t.tap(find.text('Pedro'));
    await t.pumpAndSettle();
    expect(find.text('Última posición: hace 10 min'), findsOneWidget);
    await t.pump(const Duration(seconds: 6));
    await t.pumpAndSettle();
    expect(find.text('Última posición: hace un momento'), findsOneWidget);
  });

  testWidgets('si el furgón llega, la ficha lo dice y no se cierra sola', (t) async {
    fijarTamano(t, const Size(1200, 800));
    var cargas = 0;
    await t.pumpWidget(_app(MapaScreen(
      refrescoActivo: const Duration(seconds: 5),
      refresco: const Duration(seconds: 5),
      cargar: () async {
        cargas++;
        return _datos(furgones: cargas == 1 ? [_furgon(posicionAt: DateTime.now())] : const []);
      },
      conMapa: false,
    )));
    await t.pumpAndSettle();
    await t.tap(find.text('Pedro'));
    await t.pumpAndSettle();
    await t.pump(const Duration(seconds: 6));
    await t.pumpAndSettle();
    expect(find.text('Furgón de Pedro'), findsOneWidget);
    expect(find.text('Ya no está en camino.'), findsOneWidget);
  });

  testWidgets('Esc y el botón cerrar cierran la ficha', (t) async {
    fijarTamano(t, const Size(1200, 800));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(furgones: [_furgon(posicionAt: DateTime.now())]), conMapa: false)));
    await t.pumpAndSettle();
    await t.tap(find.text('Pedro'));
    await t.pumpAndSettle();
    expect(find.text('Ver OT'), findsOneWidget);
    await t.sendKeyEvent(LogicalKeyboardKey.escape);
    await t.pumpAndSettle();
    expect(find.text('Ver OT'), findsNothing);

    await t.tap(find.text('Pedro'));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Cerrar ficha (Esc)'));
    await t.pumpAndSettle();
    expect(find.text('Ver OT'), findsNothing);
  });

  testWidgets('la ficha de un equipo trae "Ver equipo" y a 375 px va entre el mapa y las listas sin desbordar', (t) async {
    fijarTamano(t, const Size(375, 812));
    await t.pumpWidget(_app(MapaScreen(cargar: () async => _datos(equipos: [_equipo(1)]), conMapa: false)));
    await t.pumpAndSettle();
    // sin mapa no hay icono que tocar: el equipo se abre desde el buscador
    await t.enterText(find.byType(TextField), 'EQ-1');
    await t.pumpAndSettle();
    await t.tap(find.text('EQ-1').last);
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('Ver equipo'), findsOneWidget);
    expect(find.text('1 equipo'), findsOneWidget);
  });

  testWidgets('el refresco es cada refrescoActivo con furgones en camino y cada refresco sin ellos', (t) async {
    fijarTamano(t, const Size(1200, 800));
    var conFurgones = 0;
    await t.pumpWidget(_app(MapaScreen(
      refrescoActivo: const Duration(seconds: 1),
      refresco: const Duration(seconds: 10),
      cargar: () async {
        conFurgones++;
        return _datos(furgones: [_furgon(posicionAt: DateTime.now())]);
      },
      conMapa: false,
    )));
    await t.pumpAndSettle();
    await t.pump(const Duration(seconds: 3));
    expect(conFurgones, greaterThanOrEqualTo(3));

    var sinFurgones = 0;
    await t.pumpWidget(_app(MapaScreen(
      key: const ValueKey('otro'),
      refrescoActivo: const Duration(seconds: 1),
      refresco: const Duration(seconds: 10),
      cargar: () async {
        sinFurgones++;
        return _datos();
      },
      conMapa: false,
    )));
    await t.pumpAndSettle();
    await t.pump(const Duration(seconds: 3));
    expect(sinFurgones, 1, reason: 'sin furgones se espera el intervalo largo');
  });
}
