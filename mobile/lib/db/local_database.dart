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
      version: 3,
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

        await _crearTablasInsumos(db);
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await _crearTablasInsumos(db);
        }
        if (oldVersion < 3) {
          // fotos anteriores al rediseño: 'antes' es el default conservador (igual que el backend)
          await db.execute(
            "ALTER TABLE evidencias_locales ADD COLUMN tipo TEXT NOT NULL DEFAULT 'antes'",
          );
        }
      },
    );
  }

  Future<void> _crearTablasInsumos(Database db) async {
    // catalogo de insumos, de solo lectura: se refresca en cada sync
    await db.execute('''
      CREATE TABLE IF NOT EXISTS insumos_catalogo_local (
        id INTEGER PRIMARY KEY,
        nombre TEXT NOT NULL,
        unidad_medida TEXT NOT NULL
      )
    ''');

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
