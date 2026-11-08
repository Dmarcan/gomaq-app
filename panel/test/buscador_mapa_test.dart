import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/ubicacion.dart';
import 'package:gomaq_web/widgets/buscador_direccion.dart';

/// El mapa del buscador con su gesto de toque, sin imágenes de red.
class _Anfitrion extends StatefulWidget {
  final void Function(Coordenada?) alCambiar;
  const _Anfitrion(this.alCambiar);

  @override
  State<_Anfitrion> createState() => _AnfitrionState();
}

class _AnfitrionState extends State<_Anfitrion> {
  Coordenada? valor = const Coordenada(-33.4138, -70.5834);

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: BuscadorDireccion(
              valor: valor,
              buscar: (_) async => [],
              capaImagenes: () => const SizedBox.shrink(),
              onChanged: (c) {
                setState(() => valor = c);
                widget.alCambiar(c);
              },
            ),
          ),
        ),
      );
}

void main() {
  testWidgets('tocar el mapa mueve el punto y avisa la nueva coordenada', (t) async {
    t.view.physicalSize = const Size(800, 900);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize);
    addTearDown(t.view.resetDevicePixelRatio);
    Coordenada? nueva;
    await t.pumpWidget(_Anfitrion((c) => nueva = c));
    await t.pump();
    expect(find.text('Ubicación marcada'), findsOneWidget);
    expect(find.textContaining('-33.4138'), findsNothing, reason: 'no se muestran coordenadas');

    // un toque a un lado del centro del mapa
    final centro = t.getCenter(find.byType(FlutterMap));
    await t.tapAt(centro + const Offset(60, 30));
    await t.pump(const Duration(milliseconds: 400)); // el mapa espera por si es un doble toque

    expect(nueva, isNotNull, reason: 'onTap del mapa no avisó el cambio');
    expect(nueva, isNot(const Coordenada(-33.4138, -70.5834)));
  });
}
