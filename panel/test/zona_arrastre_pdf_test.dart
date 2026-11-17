import 'dart:io';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/widgets/zona_arrastre_pdf.dart';

Widget _app({VoidCallback? alClic}) {
  return MaterialApp(
    home: Scaffold(
      body: ZonaArrastrePdf(
        onArchivo: (_) async {},
        builder: (context, arrastrando) => InkWell(
          onTap: alClic,
          child: Container(
            key: const ValueKey('caja'),
            width: double.infinity,
            padding: const EdgeInsets.all(32),
            decoration: BoxDecoration(border: Border.all(width: arrastrando ? 3 : 1)),
            child: Text(arrastrando ? 'Suelta el PDF aquí' : 'Haz clic o arrastra aquí el PDF'),
          ),
        ),
      ),
    ),
  );
}

DropEventDetails get _evento => DropEventDetails(localPosition: Offset.zero, globalPosition: Offset.zero);

void main() {
  testWidgets('se ve a 375 px y el clic sigue funcionando', (t) async {
    t.view.physicalSize = const Size(375, 700);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize);
    addTearDown(t.view.resetDevicePixelRatio);
    var clics = 0;
    await t.pumpWidget(_app(alClic: () => clics++));
    expect(find.byType(DropTarget), findsOneWidget);
    await t.tap(find.text('Haz clic o arrastra aquí el PDF'));
    expect(clics, 1);
    expect(t.takeException(), isNull);
  });

  testWidgets('al arrastrar encima cambia el texto y el borde, y al salir vuelve', (t) async {
    await t.pumpWidget(_app());
    final destino = t.widget<DropTarget>(find.byType(DropTarget));
    destino.onDragEntered!(_evento);
    await t.pump();
    expect(find.text('Suelta el PDF aquí'), findsOneWidget);
    final caja = t.widget<Container>(find.byKey(const ValueKey('caja')));
    expect(((caja.decoration as BoxDecoration).border as Border).top.width, 3);
    destino.onDragExited!(_evento);
    await t.pump();
    expect(find.text('Haz clic o arrastra aquí el PDF'), findsOneWidget);
  });

  group('revisarArchivosSoltados', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('zona_arrastre'));
    tearDown(() => dir.deleteSync(recursive: true));

    DropItemFile crear(String nombre, List<int> bytes) {
      final f = File('${dir.path}${Platform.pathSeparator}$nombre')..writeAsBytesSync(bytes);
      return DropItemFile(f.path);
    }

    test('un PDF pasa como PlatformFile con sus bytes', () async {
      final r = await revisarArchivosSoltados([crear('guia.PDF', [1, 2, 3])]);
      expect(r.error, isNull);
      expect(r.archivo!.name, 'guia.PDF');
      expect(r.archivo!.bytes, [1, 2, 3]);
      expect(r.archivo!.size, 3);
    });

    test('rechaza lo que no es PDF', () async {
      final r = await revisarArchivosSoltados([crear('foto.png', [1])]);
      expect(r.archivo, isNull);
      expect(r.error, 'Solo se aceptan archivos PDF');
    });

    test('rechaza más de un archivo y la lista vacía', () async {
      final dos = await revisarArchivosSoltados([crear('a.pdf', [1]), crear('b.pdf', [1])]);
      expect(dos.error, 'Suelta un solo PDF');
      final ninguno = await revisarArchivosSoltados([]);
      expect(ninguno.archivo, isNull);
    });
  });
}
