import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/utils/archivos_locales.dart';
import 'package:sqflite/sqflite.dart';

import 'ayuda_cola.dart';

void main() {
  late Directory carpetaBase;
  late Database db;
  late Directory documentos;

  setUpAll(() async {
    carpetaBase = await prepararBaseDePruebas();
  });

  tearDownAll(() async {
    try {
      await carpetaBase.delete(recursive: true);
    } catch (_) {}
  });

  setUp(() async {
    db = await baseLimpia();
    documentos = await Directory.systemTemp.createTemp('gomaq_docs_test_');
  });

  tearDown(() async {
    try {
      await documentos.delete(recursive: true);
    } catch (_) {}
  });

  File crear(String nombre) => File('${documentos.path}/$nombre')..writeAsBytesSync([1]);

  Future<void> encolarCualquiera(String estado) => db.insert('cola_sincronizacion', {
        'tipo': 'evidencia',
        'orden_trabajo_id': 5,
        'payload': '{}',
        'estado': estado,
        'intentos': 0,
        'creado_en': DateTime.now().toIso8601String(),
      });

  group('limpiarArchivosLocalesSiColaVacia', () {
    test('con la cola vacia borra fotos y firmas de la app y respeta los demas archivos', () async {
      final foto = crear('ot5_111.jpg');
      final fotoLocal = crear('ot-1700000000_222.jpg');
      final firma = crear('ot5_firma_333.png');
      final ajeno = crear('notas.txt');
      final bd = crear('gomaq_mecanico.db');

      final borrados = await limpiarArchivosLocalesSiColaVacia(db, documentos);

      expect(borrados, 3);
      expect(foto.existsSync() || fotoLocal.existsSync() || firma.existsSync(), isFalse);
      expect(ajeno.existsSync(), isTrue);
      expect(bd.existsSync(), isTrue);
    });

    test('con una tarea pendiente NO borra nada', () async {
      final foto = crear('ot5_111.jpg');
      final firma = crear('ot5_firma_333.png');
      await encolarCualquiera('pendiente');

      expect(await limpiarArchivosLocalesSiColaVacia(db, documentos), 0);
      expect(foto.existsSync(), isTrue);
      expect(firma.existsSync(), isTrue);
    });

    test('con una tarea en error tampoco borra nada', () async {
      final foto = crear('ot5_111.jpg');
      await encolarCualquiera('error');

      expect(await limpiarArchivosLocalesSiColaVacia(db, documentos), 0);
      expect(foto.existsSync(), isTrue);
    });

    test('conserva las filas de evidencias (la lista de fotos sigue mostrando la foto como enviada)', () async {
      await sembrarOrden(db, 5);
      final foto = crear('ot5_111.jpg');
      await db.insert('evidencias_locales', {
        'orden_trabajo_id': 5,
        'ruta_local': foto.path,
        'tipo': 'antes',
        'sincronizado': 1,
        'creado_en': DateTime.now().toIso8601String(),
      });

      await limpiarArchivosLocalesSiColaVacia(db, documentos);

      expect(foto.existsSync(), isFalse);
      expect((await db.query('evidencias_locales')).single['sincronizado'], 1);
    });

    test('una carpeta inexistente no falla', () async {
      final inexistente = Directory('${documentos.path}/no_existe');
      expect(await limpiarArchivosLocalesSiColaVacia(db, inexistente), 0);
    });
  });

  group('borrarArchivoLocal', () {
    test('borra el archivo, y no falla si no existe, es nulo o esta vacio', () async {
      final f = crear('ot5_1.jpg');
      expect(await borrarArchivoLocal(f.path), isTrue);
      expect(f.existsSync(), isFalse);
      expect(await borrarArchivoLocal(f.path), isFalse);
      expect(await borrarArchivoLocal(null), isFalse);
      expect(await borrarArchivoLocal(''), isFalse);
    });
  });
}
