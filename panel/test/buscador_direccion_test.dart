import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/utils/direcciones.dart';
import 'package:gomaq_web/utils/ubicacion.dart';
import 'package:gomaq_web/widgets/buscador_direccion.dart';

const _espera = Duration(milliseconds: 20);

class _Anfitrion extends StatefulWidget {
  final BuscarDirecciones buscar;
  final String? textoInicial;
  final Coordenada? inicial;
  final ObtenerUbicacion? gps;
  final void Function(Coordenada?) alCambiar;
  const _Anfitrion({required this.buscar, required this.alCambiar, this.textoInicial, this.inicial, this.gps});

  @override
  State<_Anfitrion> createState() => _AnfitrionState();
}

class _AnfitrionState extends State<_Anfitrion> {
  Coordenada? valor;

  @override
  void initState() {
    super.initState();
    valor = widget.inicial;
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: BuscadorDireccion(
              valor: valor,
              buscar: widget.buscar,
              obtenerUbicacion: widget.gps,
              textoInicial: widget.textoInicial,
              conMapa: false,
              espera: _espera,
              onChanged: (c) {
                setState(() => valor = c);
                widget.alCambiar(c);
              },
            ),
          ),
        ),
      );
}

SugerenciaDireccion _s(String e, double lat, double lng) => SugerenciaDireccion(e, Coordenada(lat, lng));

void main() {
  group('SugerenciaDireccion.fromJson', () {
    test('lee etiqueta y coordenadas, enteras o decimales', () {
      final s = SugerenciaDireccion.fromJson({'etiqueta': ' Av. Uno 1, Chile ', 'latitud': -33, 'longitud': -70.5})!;
      expect(s.etiqueta, 'Av. Uno 1, Chile');
      expect(s.ubicacion, const Coordenada(-33, -70.5));
    });

    test('lee si la sugerencia es aproximada (solo la calle)', () {
      expect(SugerenciaDireccion.fromJson({'etiqueta': 'x', 'latitud': 1, 'longitud': 2, 'aproximada': true})!.aproximada, isTrue);
      expect(SugerenciaDireccion.fromJson({'etiqueta': 'x', 'latitud': 1, 'longitud': 2})!.aproximada, isFalse);
    });

    test('una fila sin etiqueta, sin coordenadas o con texto en vez de número se descarta', () {
      expect(SugerenciaDireccion.fromJson({'etiqueta': '', 'latitud': 1, 'longitud': 2}), isNull);
      expect(SugerenciaDireccion.fromJson({'etiqueta': 'x', 'latitud': null, 'longitud': 2}), isNull);
      expect(SugerenciaDireccion.fromJson({'etiqueta': 'x', 'latitud': '1', 'longitud': '2'}), isNull);
      expect(SugerenciaDireccion.fromJson('nada'), isNull);
    });
  });

  testWidgets('no busca con menos de 3 letras; con 3 o más busca tras una pausa y muestra las sugerencias', (t) async {
    final consultas = <String>[];
    await t.pumpWidget(_Anfitrion(
      buscar: (texto) async {
        consultas.add(texto);
        return [_s('Av. Providencia 1234, Santiago, Chile', -33.43, -70.62)];
      },
      alCambiar: (_) {},
    ));
    await t.enterText(find.byType(TextField), 'Av');
    await t.pump(const Duration(milliseconds: 100));
    expect(consultas, isEmpty);
    await t.enterText(find.byType(TextField), 'Av. Prov');
    await t.pump(const Duration(milliseconds: 5));
    expect(consultas, isEmpty, reason: 'espera a que se deje de escribir');
    await t.pump(const Duration(milliseconds: 100));
    expect(consultas, ['Av. Prov']);
    expect(find.text('Av. Providencia 1234, Santiago, Chile'), findsOneWidget);
  });

  testWidgets('seguir escribiendo cancela la consulta anterior: se busca una sola vez con el texto final', (t) async {
    final consultas = <String>[];
    await t.pumpWidget(_Anfitrion(buscar: (texto) async {
      consultas.add(texto);
      return [];
    }, alCambiar: (_) {}));
    await t.enterText(find.byType(TextField), 'Prov');
    await t.pump(const Duration(milliseconds: 5));
    await t.enterText(find.byType(TextField), 'Providen');
    await t.pump(const Duration(milliseconds: 5));
    await t.enterText(find.byType(TextField), 'Providencia');
    await t.pump(const Duration(milliseconds: 100));
    expect(consultas, ['Providencia']);
  });

  testWidgets('una sugerencia aproximada avisa que solo ubica la calle', (t) async {
    await t.pumpWidget(_Anfitrion(
      buscar: (_) async => [const SugerenciaDireccion('Avenida Apoquindo, Santiago, RM, Chile', Coordenada(-33.41, -70.58), aproximada: true)],
      alCambiar: (_) {},
    ));
    await t.enterText(find.byType(TextField), 'Av. Apoquindo 4500');
    await t.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('Ubica la calle, no el número'), findsOneWidget);
  });

  testWidgets('elegir una sugerencia marca el punto, rellena el texto y oculta la lista', (t) async {
    Coordenada? marcada;
    await t.pumpWidget(_Anfitrion(
      buscar: (_) async => [_s('Av. Uno 1, Chile', -33.4, -70.6), _s('Av. Dos 2, Chile', -33.5, -70.7)],
      alCambiar: (c) => marcada = c,
    ));
    await t.enterText(find.byType(TextField), 'Av. U');
    await t.pump(const Duration(milliseconds: 100));
    await t.tap(find.text('Av. Dos 2, Chile'));
    await t.pump();
    expect(marcada, const Coordenada(-33.5, -70.7));
    expect(find.text('Av. Uno 1, Chile'), findsNothing, reason: 'la lista se cierra');
    expect(find.textContaining('Ubicación marcada'), findsOneWidget);
    expect(t.widget<TextField>(find.byType(TextField)).controller!.text, 'Av. Dos 2, Chile');
  });

  testWidgets('Enter elige la primera sugerencia', (t) async {
    Coordenada? marcada;
    await t.pumpWidget(_Anfitrion(
      buscar: (_) async => [_s('Av. Uno 1, Chile', -33.4, -70.6), _s('Av. Dos 2, Chile', -33.5, -70.7)],
      alCambiar: (c) => marcada = c,
    ));
    await t.enterText(find.byType(TextField), 'Av. U');
    await t.pump(const Duration(milliseconds: 100));
    await t.testTextInput.receiveAction(TextInputAction.search);
    await t.pump();
    expect(marcada, const Coordenada(-33.4, -70.6));
    expect(find.text('Av. Dos 2, Chile'), findsNothing);
  });

  testWidgets('una respuesta vieja que llega tarde no pisa a la nueva', (t) async {
    final lenta = Completer<List<SugerenciaDireccion>>();
    var llamada = 0;
    await t.pumpWidget(_Anfitrion(
      buscar: (texto) {
        llamada++;
        if (llamada == 1) return lenta.future;
        return Future.value([_s('Resultado nuevo, Chile', -33.1, -70.1)]);
      },
      alCambiar: (_) {},
    ));
    await t.enterText(find.byType(TextField), 'Primera');
    await t.pump(const Duration(milliseconds: 100));
    await t.enterText(find.byType(TextField), 'Primera busq');
    await t.pump(const Duration(milliseconds: 100));
    expect(find.text('Resultado nuevo, Chile'), findsOneWidget);
    lenta.complete([_s('Resultado viejo, Chile', -1, -1)]);
    await t.pump();
    expect(find.text('Resultado viejo, Chile'), findsNothing);
    expect(find.text('Resultado nuevo, Chile'), findsOneWidget);
  });

  testWidgets('sin resultados y con errores avisa con un mensaje claro y deja seguir', (t) async {
    var modo = 0;
    await t.pumpWidget(_Anfitrion(
      buscar: (_) async {
        modo++;
        if (modo == 1) return [];
        if (modo == 2) throw ApiException(429, 'Estás buscando muy seguido. Espera unos segundos.');
        throw Exception('sin red');
      },
      alCambiar: (_) {},
    ));
    await t.enterText(find.byType(TextField), 'calle inexistente');
    await t.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('No encontré esa dirección'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'calle inexistente 2');
    await t.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('Estás buscando muy seguido'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'calle inexistente 3');
    await t.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('Revisa tu conexión'), findsOneWidget);
  });

  testWidgets('con una dirección escrita y sin punto, la busca al abrir; con punto ya marcado no gasta consulta', (t) async {
    final consultas = <String>[];
    Future<List<SugerenciaDireccion>> buscar(String texto) async {
      consultas.add(texto);
      return [_s('Calle Larga 10, Chile', -33.2, -70.2)];
    }

    await t.pumpWidget(_Anfitrion(buscar: buscar, textoInicial: 'Calle Larga 10', alCambiar: (_) {}));
    await t.pump(const Duration(milliseconds: 100));
    expect(consultas, ['Calle Larga 10']);
    expect(find.text('Calle Larga 10, Chile'), findsOneWidget);

    consultas.clear();
    await t.pumpWidget(_Anfitrion(buscar: buscar, textoInicial: 'Calle Larga 10', inicial: const Coordenada(-33, -70), alCambiar: (_) {}));
    await t.pump(const Duration(milliseconds: 100));
    expect(consultas, isEmpty);
  });

  testWidgets('Quitar borra el punto y el texto; el GPS opcional marca la ubicación actual', (t) async {
    Coordenada? marcada = const Coordenada(1, 1);
    await t.pumpWidget(_Anfitrion(
      buscar: (_) async => [],
      inicial: const Coordenada(-33.4, -70.6),
      gps: () async => const Coordenada(-33.9, -70.9),
      alCambiar: (c) => marcada = c,
    ));
    await t.tap(find.text('Quitar'));
    await t.pump();
    expect(marcada, isNull);
    expect(find.textContaining('Ubicación marcada'), findsNothing);
    await t.tap(find.text('Usar mi ubicación actual'));
    await t.pumpAndSettle();
    expect(marcada, const Coordenada(-33.9, -70.9));
  });
}
