import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/ubicacion.dart';
import 'package:gomaq_web/widgets/campo_ubicacion.dart';

/// Contenedor mínimo con estado propio, como lo usa la pantalla de registro.
class _Anfitrion extends StatefulWidget {
  final ObtenerUbicacion obtener;
  final void Function(Coordenada?)? alCambiar;
  const _Anfitrion(this.obtener, {this.alCambiar});

  @override
  State<_Anfitrion> createState() => _AnfitrionState();
}

class _AnfitrionState extends State<_Anfitrion> {
  Coordenada? valor;

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: CampoUbicacion(valor: valor, obtener: widget.obtener, onChanged: (c) {
              setState(() => valor = c);
              widget.alCambiar?.call(c);
            }),
          ),
        ),
      );
}

void main() {
  group('Coordenada', () {
    test('se muestra con cuatro decimales y punto', () {
      expect(const Coordenada(-38.735912, -72.590412).texto, '-38.7359, -72.5904');
    });

    test('dos coordenadas con los mismos valores son iguales', () {
      expect(const Coordenada(1, 2), const Coordenada(1, 2));
      expect(const Coordenada(1, 2) == const Coordenada(1, 3), isFalse);
    });
  });

  group('mensajeUbicacion', () {
    test('todo motivo tiene un mensaje que deja seguir con la dirección escrita', () {
      for (final m in MotivoUbicacion.values) {
        final texto = mensajeUbicacion(m);
        expect(texto, isNotEmpty);
        expect(texto.toLowerCase(), contains('dirección'), reason: '$m debe decir que se puede escribir la dirección');
      }
    });
  });

  group('CampoUbicacion', () {
    testWidgets('al tocar el botón marca la ubicación y la muestra', (tester) async {
      await tester.pumpWidget(_Anfitrion(() async => const Coordenada(-38.7359, -72.5904)));
      expect(find.text('Usar mi ubicación actual'), findsOneWidget);

      await tester.tap(find.text('Usar mi ubicación actual'));
      await tester.pumpAndSettle();

      expect(find.text('Ubicación marcada'), findsOneWidget);
      expect(find.text('Usar mi ubicación actual'), findsNothing);
    });

    testWidgets('mientras busca muestra el avance y no deja tocar de nuevo', (tester) async {
      final espera = Future<Coordenada>.delayed(const Duration(seconds: 2), () => const Coordenada(1, 2));
      await tester.pumpWidget(_Anfitrion(() => espera));

      await tester.tap(find.text('Usar mi ubicación actual'));
      await tester.pump();
      expect(find.text('Buscando tu ubicación…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle(const Duration(seconds: 3));
      expect(find.textContaining('Ubicación marcada'), findsOneWidget);
    });

    testWidgets('si no dan permiso muestra el motivo y el botón sigue disponible', (tester) async {
      await tester.pumpWidget(_Anfitrion(() async => throw const UbicacionException(MotivoUbicacion.permisoDenegado)));

      await tester.tap(find.text('Usar mi ubicación actual'));
      await tester.pumpAndSettle();

      expect(find.text(mensajeUbicacion(MotivoUbicacion.permisoDenegado)), findsOneWidget);
      expect(find.text('Usar mi ubicación actual'), findsOneWidget, reason: 'puede reintentar');
    });

    testWidgets('un error inesperado no rompe la pantalla', (tester) async {
      await tester.pumpWidget(_Anfitrion(() async => throw StateError('algo raro')));

      await tester.tap(find.text('Usar mi ubicación actual'));
      await tester.pumpAndSettle();

      expect(find.text(mensajeUbicacion(MotivoUbicacion.otro)), findsOneWidget);
    });

    testWidgets('"Quitar" borra la ubicación y vuelve el botón', (tester) async {
      await tester.pumpWidget(_Anfitrion(() async => const Coordenada(-38.7359, -72.5904)));
      await tester.tap(find.text('Usar mi ubicación actual'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Quitar'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Ubicación marcada'), findsNothing);
      expect(find.text('Usar mi ubicación actual'), findsOneWidget);
    });

    testWidgets('"Actualizar" pide la ubicación otra vez y reemplaza la anterior', (tester) async {
      var llamadas = 0;
      Coordenada? ultima;
      await tester.pumpWidget(_Anfitrion(
        () async => llamadas++ == 0 ? const Coordenada(1, 2) : const Coordenada(3, 4),
        alCambiar: (c) => ultima = c,
      ));
      await tester.tap(find.text('Usar mi ubicación actual'));
      await tester.pumpAndSettle();
      expect(ultima, const Coordenada(1, 2));
      expect(find.text('Ubicación marcada'), findsOneWidget);

      await tester.tap(find.text('Actualizar'));
      await tester.pumpAndSettle();
      expect(ultima, const Coordenada(3, 4));
      expect(find.textContaining('(3.0000'), findsNothing, reason: 'no se muestran coordenadas');
    });
  });
}
