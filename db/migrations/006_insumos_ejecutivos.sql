-- Migracion 006: consumo de insumos con descuento de stock, y atribucion de arriendos por ejecutivo
-- (entrevista con la empresa: hoy no hay descuento de stock por insumo usado en una OT, ni forma de saber
-- que porcentaje de lo arrendado corresponde a cada ejecutivo en terreno)

CREATE TYPE tipo_movimiento_insumo AS ENUM ('salida', 'ingreso');

CREATE TABLE insumos (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    unidad_medida VARCHAR(20) NOT NULL,
    costo_unitario NUMERIC(12,2),
    stock_actual NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE movimientos_insumo (
    id SERIAL PRIMARY KEY,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id),
    orden_trabajo_id INTEGER REFERENCES ordenes_trabajo(id), -- nulo en movimientos de tipo 'ingreso' (compra)
    cantidad NUMERIC(12,2) NOT NULL,
    tipo tipo_movimiento_insumo NOT NULL,
    usuario_id INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ejecutivos (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- nulo = cliente directo del jefe, no gestionado por un ejecutivo en terreno
ALTER TABLE clientes ADD COLUMN ejecutivo_id INTEGER REFERENCES ejecutivos(id);

CREATE INDEX idx_movimientos_insumo_ot ON movimientos_insumo(orden_trabajo_id);
CREATE INDEX idx_clientes_ejecutivo ON clientes(ejecutivo_id);
