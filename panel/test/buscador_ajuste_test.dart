import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/direcciones.dart';
import 'package:gomaq_web/utils/ubicacion.dart';
import 'package:gomaq_web/widgets/buscador_direccion.dart';

const _calle = SugerenciaDireccion('Avenida Apoquindo, Santiago, RM, Chile', Coordenada(-33.41, -70.58), aproximada: true);
const _exacta = SugerenciaDireccion('Avenida Apoquindo 4500, Santiago, RM, Chile', Coordenada(-33.41, -70.58));

class _Anfitrion extends StatefulWidget {
  final SugerenciaDireccion sugerencia;
  final bool conMapa;
  final void Function(Coordenada?) alCambiar;
  const _Anfitrion(this.sugerencia, this.alCambiar, {this.conMapa = false});

  @override
  State<_Anfitrion> createState() => _AnfitrionState();
}

class _AnfitrionState extends State<_Anfitrion> {
  Coordenada? valor;

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: BuscadorDireccion(
              valor: valor,
              buscar: (_) async => [widget.sugerencia],
              conMapa: widget.conMapa,
              espera: const Duration(milliseconds: 10),
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

Future<void> _elegir(WidgetTester t) async {
  await t.enterText(find.byType(TextField), 'Apoquindo');
  await t.pump(const Duration(milliseconds: 50));
  await t.pumpAndSettle();
  await t.tap(find.byType(ListTile));
  await t.pumpAndSettle();
}

void main() {
  const aviso = 'Encontramos la calle, pero no el número. Arrastra el punto o toca el mapa para dejarlo en el lugar exacto.';

  testWidgets('si solo se ubicó la calle, aparece el aviso visible con qué pasó y qué hacer', (t) async {
    final semantica = t.ensureSemantics();
    await t.pumpWidget(_Anfitrion(_calle, (_) {}));
    await _elegir(t);
    expect(find.text(aviso), findsOneWidget);
    expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget, reason: 'no depende solo del color');
    expect(find.bySemanticsLabel(RegExp('Encontramos la calle')), findsOneWidget);
    semantica.dispose();
  });

  testWidgets('con número exacto no hay aviso', (t) async {
    await t.pumpWidget(_Anfitrion(_exacta, (_) {}));
    await _elegir(t);
    expect(find.text('Ubicación marcada'), findsOneWidget);
    expect(find.textContaining('Encontramos la calle'), findsNothing);
  });

  testWidgets('las flechas mueven el punto, avisan con onChanged y retiran el aviso', (t) async {
    Coordenada? ultima;
    await t.pumpWidget(_Anfitrion(_calle, (c) => ultima = c));
    await _elegir(t);
    expect(ultima, _calle.ubicacion);

    await t.tap(find.byTooltip('Mover el punto al norte'));
    await t.pump();
    expect(ultima!.latitud, greaterThan(_calle.ubicacion.latitud));
    expect(ultima!.longitud, _calle.ubicacion.longitud);
    expect(find.textContaining('Encontramos la calle'), findsNothing, reason: 'ya se ajustó');

    final alNorte = ultima!;
    await t.tap(find.byTooltip('Mover el punto al sur'));
    await t.pump();
    expect(ultima!.latitud, lessThan(alNorte.latitud));

    await t.tap(find.byTooltip('Mover el punto al este'));
    await t.pump();
    expect(ultima!.longitud, greaterThan(_calle.ubicacion.longitud));
    await t.tap(find.byTooltip('Mover el punto al oeste'));
    await t.tap(find.byTooltip('Mover el punto al oeste'));
    await t.pump();
    expect(ultima!.longitud, lessThan(_calle.ubicacion.longitud));
  });

  testWidgets('arrastrar el pin sobre el mapa mueve el punto y guarda la coordenada ajustada', (t) async {
    t.view.physicalSize = const Size(800, 900);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize);
    addTearDown(t.view.resetDevicePixelRatio);
    Coordenada? ultima;
    await t.pumpWidget(_Anfitrion(_calle, (c) => ultima = c, conMapa: true));
    await _elegir(t);
    expect(find.byType(FlutterMap), findsOneWidget);
    final antes = ultima!;

    await t.drag(find.byKey(const ValueKey('pin-ubicacion')), const Offset(40, 0));
    await t.pumpAndSettle();
    expect(ultima, isNot(antes));
    expect(ultima!.longitud, greaterThan(antes.longitud), reason: 'a la derecha es hacia el este');
    expect((ultima!.latitud - antes.latitud).abs(), lessThan(0.0005));
    expect(find.textContaining('Encontramos la calle'), findsNothing);
  });
}
