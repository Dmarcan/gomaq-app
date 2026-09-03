-- Migracion 014: vehiculos del personal y stock por ubicacion (furgon de cada mecanico)
--
-- Entrevista el jefe de taller del 21 de julio de 2026, punto 3: "cada uno tiene un furgon asignado",
-- no rotan entre mecanicos, y cada furgon lleva su propio stock de repuestos. Ademas existe
-- un furgon exclusivo de compras que no sale a terreno: por eso `vehiculos.usuario_id` es
-- nullable y solo los furgones con mecanico asignado tienen ubicacion de stock.
--
-- Cierra tambien dos huecos ya documentados: HU-07 promete avisarle al cliente "quien llega
-- a reparar su equipo Y CON QUE VEHICULO" (hoy el aviso no lleva vehiculo porque no existian),
-- y la OT en papel pide el RUT del tecnico, que `usuarios` no tenia.

-- RUT del tecnico: aparece en el bloque de firmas del talonario y se le muestra al cliente
-- en el aviso previo a la visita, para que porteria pueda validar quien entra.
ALTER TABLE usuarios ADD COLUMN rut VARCHAR(20);

CREATE TABLE vehiculos (
    id SERIAL PRIMARY KEY,
    patente VARCHAR(15) UNIQUE NOT NULL,
    marca VARCHAR(100),
    modelo VARCHAR(100),
    anio INTEGER,
    tipo VARCHAR(50), -- furgon, camioneta, etc.
    kilometraje INTEGER,
    -- nulo = vehiculo sin mecanico asignado, como el furgon de compras
    usuario_id INTEGER UNIQUE REFERENCES usuarios(id),
    activo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE tipo_documento_vehiculo AS ENUM (
    'permiso_circulacion', 'revision_tecnica', 'seguro', 'padron', 'otro'
);

-- Solo se guardan los documentos, sin control de vencimiento: el calendario chileno de
-- revision tecnica depende del tipo de vehiculo y cambia cada año, asi que una fecha
-- calculada por el sistema seria mas riesgo que ayuda.
CREATE TABLE documentos_vehiculo (
    id SERIAL PRIMARY KEY,
    vehiculo_id INTEGER NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
    tipo tipo_documento_vehiculo NOT NULL DEFAULT 'otro',
    nombre VARCHAR(150),
    archivo_path TEXT NOT NULL, -- ruta en el bucket privado documentos-gomaq
    usuario_id INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documentos_vehiculo ON documentos_vehiculo(vehiculo_id);

-- ---------------------------------------------------------------------------
-- Inventario multi-ubicacion (patron "van stock")
-- Hasta ahora `insumos.stock_actual` era un unico numero global y consumir en una OT lo
-- descontaba de ahi, aunque el repuesto haya salido del furgon del mecanico. Ahora la
-- existencia vive por ubicacion y `stock_actual` pasa a ser el total derivado.
-- ---------------------------------------------------------------------------
CREATE TYPE tipo_ubicacion_stock AS ENUM ('bodega', 'furgon');

CREATE TABLE ubicaciones_stock (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    tipo tipo_ubicacion_stock NOT NULL,
    vehiculo_id INTEGER UNIQUE REFERENCES vehiculos(id),
    activa BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_ubicacion (
    id SERIAL PRIMARY KEY,
    ubicacion_id INTEGER NOT NULL REFERENCES ubicaciones_stock(id),
    insumo_id INTEGER NOT NULL REFERENCES insumos(id),
    -- puede quedar negativa a proposito: si el mecanico instalo un repuesto que el sistema
    -- no tenia registrado en su furgon, impedirle anotarlo solo hace que el dato se pierda.
    -- El descuadre queda visible para que bodega lo cuadre.
    cantidad NUMERIC(12,2) NOT NULL DEFAULT 0,
    UNIQUE (ubicacion_id, insumo_id)
);

CREATE INDEX idx_stock_ubicacion_insumo ON stock_ubicacion(insumo_id);

-- De donde salio y a donde entro cada movimiento. Una transferencia bodega->furgon tiene los
-- dos; un consumo en una OT solo origen; una compra que ingresa a bodega solo destino.
ALTER TABLE movimientos_insumo ADD COLUMN ubicacion_origen_id INTEGER REFERENCES ubicaciones_stock(id);
ALTER TABLE movimientos_insumo ADD COLUMN ubicacion_destino_id INTEGER REFERENCES ubicaciones_stock(id);

-- Bodega central: la ubicacion por defecto de todo lo que ya existe.
INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ('Bodega central', 'bodega');

-- Siembra: el stock global que habia hasta ahora pasa integro a la bodega central, para que
-- la migracion no invente ni pierda existencias.
INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad)
SELECT (SELECT id FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1),
       i.id, i.stock_actual
FROM insumos i;
