import 'dart:io';

import 'package:gomaq_mecanico/db/local_database.dart';
import 'package:gomaq_mecanico/services/api_client.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// Base SQLite real (FFI) en una carpeta temporal, con el esquema verdadero de la app
/// (`LocalDatabase`, version 10). Llamar una vez en `setUpAll`.
Future<Directory> prepararBaseDePruebas() async {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;
  final carpeta = await Directory.systemTemp.createTemp('gomaq_cola_test_');
  await databaseFactory.setDatabasesPath(carpeta.path);
  return carpeta;
}

/// Deja la base vacia entre pruebas (y quita triggers de prueba) sin reabrirla.
Future<Database> baseLimpia() async {
  final db = await LocalDatabase.instance.database;
  await db.execute('DROP TRIGGER IF EXISTS falla_cola');
  await LocalDatabase.instance.limpiarDatosDeUsuario();
  return db;
}

/// Fila minima de una OT local.
Future<void> sembrarOrden(Database db, int id, {String estado = 'en_terreno'}) => db.insert('ordenes_locales', {
      'id': id,
      'maquinaria_id': 1,
      'maquinaria_codigo': 'EQ-1',
      'estado': estado,
      'facturable': 0,
      'fecha_creacion': DateTime.now().toIso8601String(),
      'actualizado_en': DateTime.now().toIso8601String(),
    });

/// Hace fallar cualquier INSERT en la cola, como si el telefono se quedara sin disco o la app muriera
/// justo despues de la escritura local.
Future<void> romperEncolado(Database db) => db.execute(
    "CREATE TRIGGER falla_cola BEFORE INSERT ON cola_sincronizacion BEGIN SELECT RAISE(ABORT, 'cola rota'); END");

/// Cliente HTTP falso de la cola: registra las llamadas y responde lo minimo que el servidor real.
class ApiFalsa implements ApiCola {
  final llamadas = <String>[];

  /// Si no es null, se lanza en las llamadas de escritura (post/patch/put).
  Object? errorAlEscribir;

  /// Si no es null, se lanza solo al confirmar una evidencia (la subida del archivo ya salio bien).
  Object? errorEnConfirmar;

  /// Si no es null, se lanza solo en los PATCH (por ejemplo el cierre de la OT).
  Object? errorEnPatch;

  @override
  Future<dynamic> get(String path) async {
    llamadas.add('GET $path');
    if (path == '/api/ordenes-trabajo') {
      return {
        'items': [
          {'id': 5, 'maquinaria_id': 1, 'maquinaria_codigo': 'EQ-1', 'estado': 'en_terreno', 'facturable': false},
        ],
      };
    }
    return <String, dynamic>{};
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body) async {
    llamadas.add('POST $path');
    if (errorEnConfirmar != null && path.endsWith('/confirmar')) throw errorEnConfirmar!;
    if (errorAlEscribir != null) throw errorAlEscribir!;
    if (path.endsWith('/solicitar-upload')) {
      return {'signedUrl': 'https://almacen.falso/subida', 'path': 'ot/${body['nombre_archivo']}'};
    }
    return <String, dynamic>{};
  }

  @override
  Future<dynamic> patch(String path, Map<String, dynamic> body) async {
    llamadas.add('PATCH $path');
    if (errorEnPatch != null) throw errorEnPatch!;
    if (errorAlEscribir != null) throw errorAlEscribir!;
    return <String, dynamic>{};
  }

  @override
  Future<dynamic> put(String path, Map<String, dynamic> body) async {
    llamadas.add('PUT $path');
    if (errorAlEscribir != null) throw errorAlEscribir!;
    return <String, dynamic>{};
  }
}
