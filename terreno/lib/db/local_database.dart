import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

class LocalDatabase {
  LocalDatabase._();
  static final LocalDatabase instance = LocalDatabase._();

  Database? _db;

  Future<Database> get database async {
    _db ??= await _init();
    return _db!;
  }

  Future<Database> _init() async {
    final dbPath = await getDatabasesPath();
    final path = join(dbPath, 'gomaq_mecanico.db');
    return openDatabase(
      path,
      version: 10,
      onCreate: (db, version) => crearEsquema(db),
      onUpgrade: (db, oldVersion, newVersion) => migrarEsquema(db, oldVersion, newVersion),
    );
  }

  /// Esquema completo de la version actual (instalacion nueva). Separado de `openDatabase` para
  /// poder probarlo con una base en memoria (ver test/local_database_migracion_test.dart).
  @visibleForTesting
  static Future<void> crearEsquema(Database db) async {
    await db.execute('''
      CREATE TABLE ordenes_locales (
        id INTEGER PRIMARY KEY,
        maquinaria_id INTEGER,
        maquinaria_codigo TEXT,
        cliente_nombre TEXT,
        motivo TEXT,
        diagnostico TEXT,
        estado TEXT,
        facturable INTEGER,
        fecha_creacion TEXT,
        actualizado_en TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE cola_sincronizacion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL,
        orden_trabajo_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        intentos INTEGER NOT NULL DEFAULT 0,
        ultimo_error TEXT,
        creado_en TEXT NOT NULL
      )
    ''');

    await db.execute('''
      CREATE TABLE evidencias_locales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL,
        ruta_local TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'antes',
        sincronizado INTEGER NOT NULL DEFAULT 0,
        creado_en TEXT NOT NULL
      )
    ''');

    await _crearCatalogoInsumos(db);
    await _crearTablaLineas(db);
    await _crearTablasOrdenPapel(db);
    await _crearTablasEquipos(db);
    await _crearTablasFurgon(db);
    await _migrarV7(db);
    await _migrarV8(db);
    await _migrarV9(db);
    await _migrarV10(db);
  }

  /// Actualiza una base existente de `desde` a `hasta`. Mismo motivo que [crearEsquema].
  @visibleForTesting
  static Future<void> migrarEsquema(Database db, int desde, int hasta) async {
    if (desde < 2) {
      // esquema de la v2: la migracion a v4 de mas abajo lo actualiza
      await _crearCatalogoInsumos(db);
      await _crearTablaLineasV3(db);
    }
    if (desde < 3) {
      // fotos anteriores al rediseño: 'antes' es el default conservador (igual que el backend)
      await db.execute(
        "ALTER TABLE evidencias_locales ADD COLUMN tipo TEXT NOT NULL DEFAULT 'antes'",
      );
    }
    if (desde < 4) {
      await _crearTablasOrdenPapel(db);
      await db.execute("ALTER TABLE insumos_locales ADD COLUMN descripcion TEXT");
      await db.execute("ALTER TABLE insumos_locales ADD COLUMN precio_unitario REAL");
      await db.execute(
        "ALTER TABLE insumos_locales ADD COLUMN facturable TEXT NOT NULL DEFAULT 'pendiente'",
      );
      // una linea escrita a mano no tiene insumo del catalogo (igual que en el papel).
      // SQLite no permite quitar un NOT NULL, asi que se recrea la tabla.
      await db.execute('ALTER TABLE insumos_locales RENAME TO insumos_locales_v3');
      await _crearTablaLineas(db);
      await db.execute('''
        INSERT INTO insumos_locales
          (id, orden_trabajo_id, insumo_id, insumo_nombre, cantidad, descripcion,
           precio_unitario, facturable, sincronizado, creado_en)
        SELECT id, orden_trabajo_id, insumo_id, insumo_nombre, cantidad, descripcion,
               precio_unitario, facturable, sincronizado, creado_en
        FROM insumos_locales_v3
      ''');
      await db.execute('DROP TABLE insumos_locales_v3');
    }
    if (desde < 5) {
      await _crearTablasEquipos(db);
    }
    if (desde < 6) {
      await _crearTablasFurgon(db);
    }
    if (desde < 7) {
      await _migrarV7(db);
    }
    if (desde < 8) {
      await _migrarV8(db);
    }
    if (desde < 9) {
      await _migrarV9(db);
    }
    if (desde < 10) {
      await _migrarV10(db);
    }
  }

  /// v10: destino de la OT (la ubicacion del cliente) para el boton "Como llegar". Solo agrega dos
  /// columnas nulas: nunca se recrea la tabla, porque esa base guarda la cola de sincronizacion
  /// y el trabajo del mecanico aun no enviado. Las OT que ya estan en el telefono quedan sin destino
  /// hasta la proxima sincronizacion, y mientras tanto la app simplemente no muestra el boton.
  static Future<void> _migrarV10(Database db) async {
    await db.execute('ALTER TABLE ordenes_locales ADD COLUMN destino_lat REAL');
    await db.execute('ALTER TABLE ordenes_locales ADD COLUMN destino_lng REAL');
  }

  /// v9: costo de cada repuesto del catalogo. Precarga el precio de una linea de repuesto (por ahora
  /// se cobra al costo: GOMAQ aun no define un precio de venta) y se guarda aunque la linea no sea
  /// facturable, porque "Costos por equipo" cuenta el gasto de todas las lineas.
  static Future<void> _migrarV9(Database db) async {
    await db.execute('ALTER TABLE insumos_catalogo_local ADD COLUMN costo_unitario REAL');
  }

  /// v8: cabecera del talonario en la OT local. Hasta aqui el tipo de servicio, la observacion
  /// final y el folio del papel solo se enviaban al servidor y no se guardaban en el telefono:
  /// al reabrir la orden aparecian vacios (y no se podia saber que ya estaban completos).
  static Future<void> _migrarV8(Database db) async {
    await db.execute('ALTER TABLE ordenes_locales ADD COLUMN tipo_servicio TEXT');
    await db.execute('ALTER TABLE ordenes_locales ADD COLUMN observacion_final TEXT');
    await db.execute('ALTER TABLE ordenes_locales ADD COLUMN folio_papel TEXT');
  }

  /// v7: anulacion de lineas de repuesto y dueño de la cola.
  ///
  /// - `servidor_id`: id de la linea en el servidor, para poder anularla despues de sincronizada.
  /// - `anulada`: la linea queda tachada, como en el talonario; no se borra.
  /// - `sesion_local`: a quien pertenece el trabajo guardado en el telefono. Si otro mecanico
  ///   inicia sesion en el mismo equipo, sus cambios pendientes no deben enviarse con su cuenta.
  ///
  /// Se aplica con ALTER tanto en instalaciones nuevas como en actualizaciones, para que la
  /// tabla de lineas tenga un solo camino de creacion (el de la v4).
  static Future<void> _migrarV7(Database db) async {
    await db.execute('ALTER TABLE insumos_locales ADD COLUMN servidor_id INTEGER');
    await db.execute('ALTER TABLE insumos_locales ADD COLUMN anulada INTEGER NOT NULL DEFAULT 0');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sesion_local (
        clave TEXT PRIMARY KEY,
        valor TEXT
      )
    ''');
  }

  /// Borra todo el trabajo y la cache local. Se usa cuando otro mecanico inicia sesion en un
  /// telefono sin cambios pendientes: no debe ver las ordenes ni el furgon del anterior.
  Future<void> limpiarDatosDeUsuario() async {
    final db = await database;
    await db.transaction((txn) async {
      for (final tabla in [
        'ordenes_locales', 'cola_sincronizacion', 'evidencias_locales', 'insumos_locales',
        'ot_servicios_locales', 'tramos_locales', 'furgon_stock_local', 'mi_vehiculo_local',
        'mi_perfil_local', 'historial_ot_local', 'horometro_local',
      ]) {
        await txn.delete(tabla);
      }
    });
  }

  Future<String?> leerSesion(String clave) async {
    final db = await database;
    final filas = await db.query('sesion_local', where: 'clave = ?', whereArgs: [clave]);
    return filas.isEmpty ? null : filas.first['valor'] as String?;
  }

  Future<void> guardarSesion(String clave, String valor) async {
    final db = await database;
    await db.insert('sesion_local', {'clave': clave, 'valor': valor},
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  /// Stock del furgon y datos del vehiculo asignado, para consultarlos en terreno sin señal.
  /// La CARGA del furgon en cambio es solo online: se hace en el taller y hay que validar
  /// contra la bodega en el momento (ver /api/insumos/transferencia).
  static Future<void> _crearTablasFurgon(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS furgon_stock_local (
        insumo_id INTEGER PRIMARY KEY,
        nombre TEXT NOT NULL,
        unidad_medida TEXT,
        cantidad REAL NOT NULL
      )
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS mi_vehiculo_local (
        id INTEGER PRIMARY KEY,
        patente TEXT,
        marca TEXT,
        modelo TEXT,
        anio INTEGER,
        tipo TEXT,
        kilometraje INTEGER
      )
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS mi_perfil_local (
        id INTEGER PRIMARY KEY,
        nombre TEXT,
        email TEXT,
        rut TEXT,
        telefono_whatsapp TEXT
      )
    ''');
  }

  /// Ficha y historial de los equipos, para que el mecanico pueda consultarlos en terreno
  /// sin señal. El catalogo trae toda la flota pero solo con lo minimo para el selector;
  /// los campos de ficha se completan unicamente en los equipos de sus OT.
  static Future<void> _crearTablasEquipos(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS maquinarias_local (
        id INTEGER PRIMARY KEY,
        codigo TEXT NOT NULL,
        tipo TEXT,
        estado TEXT,
        categoria_equipo TEXT,
        marca TEXT,
        modelo TEXT,
        anio INTEGER,
        numero_serie TEXT,
        numero_motor TEXT,
        numero_chasis TEXT,
        numero_mastil TEXT,
        capacidad_carga REAL,
        altura_trabajo REAL,
        tipo_combustible TEXT,
        ubicacion TEXT,
        cliente_nombre TEXT,
        ficha_completa INTEGER NOT NULL DEFAULT 0
      )
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS historial_ot_local (
        id INTEGER PRIMARY KEY,
        maquinaria_id INTEGER NOT NULL,
        motivo TEXT,
        diagnostico TEXT,
        observacion_final TEXT,
        estado TEXT,
        fecha_creacion TEXT,
        fecha_cierre TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS horometro_local (
        id INTEGER PRIMARY KEY,
        maquinaria_id INTEGER NOT NULL,
        valor REAL NOT NULL,
        origen TEXT,
        fecha TEXT
      )
    ''');
  }

  /// Catalogo del checklist (solo lectura, se refresca en cada sync) y las marcas locales
  /// de que sistemas se intervinieron en cada OT.
  static Future<void> _crearTablasOrdenPapel(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS checklist_catalogo_local (
        id INTEGER PRIMARY KEY,
        grupo TEXT NOT NULL,
        nombre TEXT NOT NULL,
        orden INTEGER NOT NULL
      )
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS ot_servicios_locales (
        orden_trabajo_id INTEGER NOT NULL,
        servicio_id INTEGER NOT NULL,
        PRIMARY KEY (orden_trabajo_id, servicio_id)
      )
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS tramos_locales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL,
        inicio TEXT NOT NULL,
        termino TEXT,
        sincronizado INTEGER NOT NULL DEFAULT 0
      )
    ''');
  }

  static Future<void> _crearTablaLineas(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS insumos_locales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL,
        insumo_id INTEGER,
        insumo_nombre TEXT NOT NULL,
        cantidad REAL NOT NULL,
        descripcion TEXT,
        precio_unitario REAL,
        facturable TEXT NOT NULL DEFAULT 'pendiente',
        sincronizado INTEGER NOT NULL DEFAULT 0,
        creado_en TEXT NOT NULL
      )
    ''');
  }

  /// catalogo de insumos, de solo lectura: se refresca en cada sync
  static Future<void> _crearCatalogoInsumos(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS insumos_catalogo_local (
        id INTEGER PRIMARY KEY,
        nombre TEXT NOT NULL,
        unidad_medida TEXT NOT NULL
      )
    ''');
  }

  /// Esquema de lineas anterior a la v4. Solo lo usa el camino de actualizacion desde la v1,
  /// para que el bloque de la v4 tenga la tabla vieja que espera migrar.
  static Future<void> _crearTablaLineasV3(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS insumos_locales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orden_trabajo_id INTEGER NOT NULL,
        insumo_id INTEGER NOT NULL,
        insumo_nombre TEXT NOT NULL,
        cantidad REAL NOT NULL,
        sincronizado INTEGER NOT NULL DEFAULT 0,
        creado_en TEXT NOT NULL
      )
    ''');
  }
}
