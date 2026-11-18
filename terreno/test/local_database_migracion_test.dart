import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/db/local_database.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

// Prueba de la migracion de la base local del telefono con datos reales en la cola.
//
// Como agregar la proxima version (N+1):
//  1. Antes de cambiar el esquema, copiar el esquema vigente (solo CREATE/ALTER, sin datos) a
//     test/fixtures/esquema_vN.sql.
//  2. Agregar un grupo que cree la base con ese fixture, siembre filas, corra
//     LocalDatabase.migrarEsquema(db, N, N + 1) y compare filas y PRAGMA table_info.
//  3. Las columnas nuevas se agregan en onUpgrade y en onCreate con ALTER TABLE (nunca recrear tablas).

const _versionActual = 10;

/// Lee un fixture de esquema y lo parte en sentencias (no hay punto y coma dentro de ellas).
Future<List<String>> _sentenciasDe(String archivo) async {
  final texto = await File('test/fixtures/$archivo').readAsString();
  final sinComentarios = texto.split('\n').where((l) => !l.trimLeft().startsWith('--')).join('\n');
  return sinComentarios.split(';').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
}

Future<Database> _baseV9() async {
  final db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath, options: OpenDatabaseOptions(singleInstance: false));
  for (final sentencia in await _sentenciasDe('esquema_v9.sql')) {
    await db.execute(sentencia);
  }
  return db;
}

Future<List<String>> _tablas(Database db) async {
  final filas = await db.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return filas.map((f) => f['name'] as String).toList();
}

/// Columnas de una tabla (nombre, tipo, NOT NULL, default, llave primaria) en orden.
Future<List<String>> _columnas(Database db, String tabla) async {
  final filas = await db.rawQuery('PRAGMA table_info($tabla)');
  return filas.map((c) => '${c['name']}|${c['type']}|${c['notnull']}|${c['dflt_value']}|${c['pk']}').toList();
}

Future<Map<String, List<Map<String, Object?>>>> _foto(Database db) async {
  final foto = <String, List<Map<String, Object?>>>{};
  for (final t in await _tablas(db)) {
    foto[t] = (await db.query(t, orderBy: 'rowid')).map((f) => Map<String, Object?>.from(f)).toList();
  }
  return foto;
}

/// Trabajo realista de un mecanico con la v9: una OT con repuestos, una foto sin subir, tareas
/// pendientes, una con reintentos y error, y la sesion que protege la cola.
Future<void> _sembrar(Database db) async {
  await db.insert('ordenes_locales', {
    'id': 41, 'maquinaria_id': 7, 'maquinaria_codigo': 'GRU-07', 'cliente_nombre': 'Constructora Sur',
    'motivo': 'Falla hidraulica', 'diagnostico': 'Manguera rota', 'estado': 'en_reparacion', 'facturable': 1,
    'fecha_creacion': '2026-11-10T08:00:00.000', 'actualizado_en': '2026-11-10T09:30:00.000',
    'tipo_servicio': 'correctivo', 'observacion_final': 'Se cambia manguera', 'folio_papel': 'F-1234',
  });
  await db.insert('ordenes_locales', {
    'id': 42, 'maquinaria_id': 8, 'maquinaria_codigo': 'EXC-02', 'estado': 'aceptada', 'facturable': 0,
    'fecha_creacion': '2026-11-11T10:00:00.000', 'actualizado_en': '2026-11-11T10:00:00.000',
  });
  await db.insert('insumos_catalogo_local', {'id': 3, 'nombre': 'Manguera 1/2', 'unidad_medida': 'm', 'costo_unitario': 4500.5});
  await db.insert('insumos_locales', {
    'orden_trabajo_id': 41, 'insumo_id': 3, 'insumo_nombre': 'Manguera 1/2', 'cantidad': 2.5,
    'descripcion': 'Repuesto', 'precio_unitario': 4500.5, 'facturable': 'si', 'sincronizado': 0,
    'creado_en': '2026-11-10T09:00:00.000', 'servidor_id': null, 'anulada': 0,
  });
  await db.insert('insumos_locales', {
    'orden_trabajo_id': 41, 'insumo_nombre': 'Aceite a mano', 'cantidad': 1.0, 'sincronizado': 1,
    'creado_en': '2026-11-10T09:05:00.000', 'servidor_id': 99, 'anulada': 1,
  });
  await db.insert('evidencias_locales', {
    'orden_trabajo_id': 41, 'ruta_local': '/data/user/0/cl.gomaq.gomaq_mecanico/files/foto1.jpg',
    'tipo': 'despues', 'sincronizado': 0, 'creado_en': '2026-11-10T09:10:00.000',
  });
  await db.insert('tramos_locales', {'orden_trabajo_id': 41, 'inicio': '2026-11-10T08:10:00.000', 'sincronizado': 0});
  await db.insert('cola_sincronizacion', {
    'tipo': 'cambio_estado', 'orden_trabajo_id': 41,
    'payload': '{"uuid_cliente":"a1b2c3d4-0000-4000-8000-000000000001","estado":"en_reparacion"}',
    'estado': 'pendiente', 'intentos': 0, 'creado_en': '2026-11-10T08:11:00.000',
  });
  await db.insert('cola_sincronizacion', {
    'tipo': 'insumo', 'orden_trabajo_id': 41,
    'payload': '{"uuid_cliente":"a1b2c3d4-0000-4000-8000-000000000002","insumo_id":3,"cantidad":2.5}',
    'estado': 'error', 'intentos': 3, 'ultimo_error': 'HTTP 500', 'creado_en': '2026-11-10T09:01:00.000',
  });
  await db.insert('cola_sincronizacion', {
    'tipo': 'horometro', 'orden_trabajo_id': 0,
    'payload': '{"uuid_cliente":"a1b2c3d4-0000-4000-8000-000000000003","maquinaria_id":8,"valor":1520.5}',
    'estado': 'pendiente', 'intentos': 1, 'creado_en': '2026-11-11T10:05:00.000',
  });
  await db.insert('sesion_local', {'clave': 'usuario_id', 'valor': '12'});
  await db.insert('mi_perfil_local', {'id': 12, 'nombre': 'Mecanico Prueba', 'email': 'm@example.cl', 'rut': '1-9'});
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  group('migracion v9 -> v10 con datos', () {
    late Database db;

    setUp(() async {
      db = await _baseV9();
      await _sembrar(db);
    });

    tearDown(() => db.close());

    test('la base sembrada tiene cola y trabajo antes de migrar', () async {
      expect(await db.query('cola_sincronizacion'), hasLength(3));
      expect(await db.query('insumos_locales'), hasLength(2));
    });

    test('conserva todas las filas con los mismos valores', () async {
      final antes = await _foto(db);
      await LocalDatabase.migrarEsquema(db, 9, _versionActual);
      final despues = await _foto(db);

      expect(despues.keys, antes.keys);
      for (final tabla in antes.keys) {
        // las columnas nuevas de la v10 nacen en null; el resto debe quedar igual
        final esperado = antes[tabla]!;
        final real = despues[tabla]!.map((f) {
          final copia = Map<String, Object?>.from(f);
          if (tabla == 'ordenes_locales') {
            expect(copia.remove('destino_lat'), isNull);
            expect(copia.remove('destino_lng'), isNull);
          }
          return copia;
        }).toList();
        expect(real, esperado, reason: 'tabla $tabla');
      }
    });

    test('la cola y el trabajo no enviado siguen intactos', () async {
      await LocalDatabase.migrarEsquema(db, 9, _versionActual);
      final cola = await db.query('cola_sincronizacion', orderBy: 'id');
      expect(cola.map((f) => f['tipo']), ['cambio_estado', 'insumo', 'horometro']);
      expect(cola[1]['estado'], 'error');
      expect(cola[1]['intentos'], 3);
      expect(cola[1]['ultimo_error'], 'HTTP 500');
      expect(cola[2]['orden_trabajo_id'], 0);
      expect(cola.every((f) => (f['payload'] as String).contains('uuid_cliente')), isTrue);
      expect(await db.query('evidencias_locales', where: 'sincronizado = 0'), hasLength(1));
      expect(await db.query('insumos_locales', where: 'sincronizado = 0'), hasLength(1));
    });

    test('el esquema migrado coincide con el de una base creada directo en la v10', () async {
      await LocalDatabase.migrarEsquema(db, 9, _versionActual);

      final nueva = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath, options: OpenDatabaseOptions(singleInstance: false));
      addTearDown(nueva.close);
      await LocalDatabase.crearEsquema(nueva);

      final tablasNuevas = await _tablas(nueva);
      expect(await _tablas(db), tablasNuevas);
      for (final tabla in tablasNuevas) {
        expect(await _columnas(db, tabla), await _columnas(nueva, tabla), reason: 'tabla $tabla');
      }
    });

    test('una fila nueva de la v10 convive con las migradas', () async {
      await LocalDatabase.migrarEsquema(db, 9, _versionActual);
      await db.update('ordenes_locales', {'destino_lat': -33.45, 'destino_lng': -70.66}, where: 'id = 41');
      final fila = (await db.query('ordenes_locales', where: 'id = 41')).single;
      expect(fila['destino_lat'], -33.45);
      expect(fila['folio_papel'], 'F-1234');
    });

    test('migrar desde una version ya actual no rompe ni cambia nada', () async {
      await LocalDatabase.migrarEsquema(db, 9, _versionActual);
      final antes = await _foto(db);
      await LocalDatabase.migrarEsquema(db, _versionActual, _versionActual);
      expect(await _foto(db), antes);
    });
  });
}
