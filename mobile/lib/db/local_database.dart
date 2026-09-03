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
      version: 4,
      onCreate: (db, version) async {
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
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          // esquema de la v2: la migracion a v4 de mas abajo lo actualiza
          await _crearCatalogoInsumos(db);
          await _crearTablaLineasV3(db);
        }
        if (oldVersion < 3) {
          // fotos anteriores al rediseño: 'antes' es el default conservador (igual que el backend)
          await db.execute(
            "ALTER TABLE evidencias_locales ADD COLUMN tipo TEXT NOT NULL DEFAULT 'antes'",
          );
        }
        if (oldVersion < 4) {
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
      },
    );
  }

  /// Catalogo del checklist (solo lectura, se refresca en cada sync) y las marcas locales
  /// de que sistemas se intervinieron en cada OT.
  Future<void> _crearTablasOrdenPapel(Database db) async {
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

  Future<void> _crearTablaLineas(Database db) async {
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
  Future<void> _crearCatalogoInsumos(Database db) async {
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
  Future<void> _crearTablaLineasV3(Database db) async {
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
