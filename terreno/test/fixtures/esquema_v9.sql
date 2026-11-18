-- Esquema de la base local del telefono en la version 9 (ultima antes de agregar el destino de la OT).
-- Solo sentencias de esquema, sin datos. Reproduce lo que hacia onCreate en la v9: las tablas base y
-- luego los ALTER de las versiones 7, 8 y 9, para que el orden de las columnas sea el de un telefono real.
-- Una sentencia por bloque, separadas por punto y coma. Sin punto y coma dentro de las sentencias.

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
  );

CREATE TABLE cola_sincronizacion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  orden_trabajo_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en TEXT NOT NULL
  );

CREATE TABLE evidencias_locales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orden_trabajo_id INTEGER NOT NULL,
  ruta_local TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'antes',
  sincronizado INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS insumos_catalogo_local (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  unidad_medida TEXT NOT NULL
  );

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
  );

CREATE TABLE IF NOT EXISTS checklist_catalogo_local (
  id INTEGER PRIMARY KEY,
  grupo TEXT NOT NULL,
  nombre TEXT NOT NULL,
  orden INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS ot_servicios_locales (
  orden_trabajo_id INTEGER NOT NULL,
  servicio_id INTEGER NOT NULL,
  PRIMARY KEY (orden_trabajo_id, servicio_id)
  );

CREATE TABLE IF NOT EXISTS tramos_locales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orden_trabajo_id INTEGER NOT NULL,
  inicio TEXT NOT NULL,
  termino TEXT,
  sincronizado INTEGER NOT NULL DEFAULT 0
  );

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
  );

CREATE TABLE IF NOT EXISTS historial_ot_local (
  id INTEGER PRIMARY KEY,
  maquinaria_id INTEGER NOT NULL,
  motivo TEXT,
  diagnostico TEXT,
  observacion_final TEXT,
  estado TEXT,
  fecha_creacion TEXT,
  fecha_cierre TEXT
  );

CREATE TABLE IF NOT EXISTS horometro_local (
  id INTEGER PRIMARY KEY,
  maquinaria_id INTEGER NOT NULL,
  valor REAL NOT NULL,
  origen TEXT,
  fecha TEXT
  );

CREATE TABLE IF NOT EXISTS furgon_stock_local (
  insumo_id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  unidad_medida TEXT,
  cantidad REAL NOT NULL
  );

CREATE TABLE IF NOT EXISTS mi_vehiculo_local (
  id INTEGER PRIMARY KEY,
  patente TEXT,
  marca TEXT,
  modelo TEXT,
  anio INTEGER,
  tipo TEXT,
  kilometraje INTEGER
  );

CREATE TABLE IF NOT EXISTS mi_perfil_local (
  id INTEGER PRIMARY KEY,
  nombre TEXT,
  email TEXT,
  rut TEXT,
  telefono_whatsapp TEXT
  );

ALTER TABLE insumos_locales ADD COLUMN servidor_id INTEGER;

ALTER TABLE insumos_locales ADD COLUMN anulada INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sesion_local (
  clave TEXT PRIMARY KEY,
  valor TEXT
  );

ALTER TABLE ordenes_locales ADD COLUMN tipo_servicio TEXT;

ALTER TABLE ordenes_locales ADD COLUMN observacion_final TEXT;

ALTER TABLE ordenes_locales ADD COLUMN folio_papel TEXT;

ALTER TABLE insumos_catalogo_local ADD COLUMN costo_unitario REAL;
