-- Migracion 013: llevar la Orden de Trabajo en papel al sistema
-- Modelada sobre el talonario que GOMAQ usa hoy (ejemplo: OT N 00904). Cubre lo que la app
-- del mecanico todavia no tenia: tipo de servicio, checklist de sistemas intervenidos, tramos
-- de trabajo, repuestos con facturable por linea, y observaciones iniciales/finales separadas.
--
-- Queda deliberadamente fuera, pendiente de confirmar con GOMAQ: el campo "LLAMADO", el
-- checkbox "TRABAJO REALIZADO" de la cabecera, y las columnas NORMALES / EXTRAS de horas.

CREATE TYPE tipo_servicio_ot AS ENUM (
    'preventivo', 'reparacion', 'garantia_full_mantencion',
    'correctivo', 'bateria_cargador', 'administrativo'
);

-- Lo marca el mecanico en terreno, que es quien sabe de que se trato la visita.
ALTER TABLE ordenes_trabajo ADD COLUMN tipo_servicio tipo_servicio_ot;

-- El papel separa "OBSERVACIONES INICIALES" de "OBSERVACIONES FINALES" (entrevista el jefe de taller,
-- punto 5). La columna `diagnostico` que ya existe es la inicial - se conserva con ese
-- significado porque el portal del cliente y el panel ya la leen - y esta es la final.
ALTER TABLE ordenes_trabajo ADD COLUMN observacion_final TEXT;

-- Numero preimpreso del talonario. La app mantiene su propio correlativo (ordenes_trabajo.id);
-- esto permite rastrear una orden de papel durante la transicion.
ALTER TABLE ordenes_trabajo ADD COLUMN folio_papel VARCHAR(20);

-- ---------------------------------------------------------------------------
-- Checklist de sistemas intervenidos (los 31 items del formulario, en 5 grupos)
-- Marcar un item significa que ahi SE INTERVINO, no que se reviso.
-- ---------------------------------------------------------------------------
CREATE TABLE servicios_checklist (
    id SERIAL PRIMARY KEY,
    grupo VARCHAR(40) NOT NULL,
    nombre VARCHAR(80) NOT NULL,
    orden INTEGER NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE ot_servicios (
    id SERIAL PRIMARY KEY,
    orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id) ON DELETE CASCADE,
    servicio_id INTEGER NOT NULL REFERENCES servicios_checklist(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (orden_trabajo_id, servicio_id)
);

CREATE INDEX idx_ot_servicios_orden ON ot_servicios(orden_trabajo_id);

INSERT INTO servicios_checklist (grupo, nombre, orden) VALUES
    ('mecanicos', 'Torre / Carro / Pantógrafo', 1),
    ('mecanicos', 'Frenos', 2),
    ('mecanicos', 'Ruedas / Neumáticos', 3),
    ('mecanicos', 'Motor', 4),
    ('mecanicos', 'Chasis / Jaula / Defensas', 5),
    ('mecanicos', 'Unidad Motriz', 6),
    ('mecanicos', 'Tren Trasero', 7),
    ('mecanicos', 'Puente', 8),
    ('mecanicos', 'Unidad Dirección', 9),
    ('mecanicos', 'Columna Dirección / Volante', 10),
    ('mecanicos', 'Desabolladura / Pintura', 11),
    ('electronicos', 'Controlador / Acces', 12),
    ('electronicos', 'Contactos / Contractores', 13),
    ('electronicos', 'Switch / Fusible', 14),
    ('electronicos', 'Terminales / Enchufes', 15),
    ('electronicos', 'Encoder / Potenciómetros', 16),
    ('electronicos', 'Joystick / Ópticos', 17),
    ('electronicos', 'Baliza / Alarmas / Bocina', 18),
    ('electronicos', 'Otros Accesorios', 19),
    ('hidraulicos', 'Cañerías / Flexibles / Niples', 20),
    ('hidraulicos', 'Motor / Bomba Hidráulica', 21),
    ('hidraulicos', 'Manifold / Caja Válvulas', 22),
    ('hidraulicos', 'Cilindro Lev / Incl. / Desplaz.', 23),
    ('hidraulicos', 'Estanques / Depósitos', 24),
    ('administrativos', 'Capacitación', 25),
    ('administrativos', 'Atención Bodega', 26),
    ('administrativos', 'Inventario', 27),
    ('administrativos', 'Traslado Máquinas', 28),
    ('complementos', 'Batería', 29),
    ('complementos', 'Cargador', 30),
    ('complementos', 'Carro Baterías', 31);

-- ---------------------------------------------------------------------------
-- Tramos de trabajo
-- El papel trae dos bloques de INICIO/TERMINO porque el trabajo se puede retomar en otra
-- visita. Aca son N tramos: un equipo que necesita tres visitas no deberia quedar sin registro.
-- ---------------------------------------------------------------------------
CREATE TABLE tramos_trabajo (
    id SERIAL PRIMARY KEY,
    orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id) ON DELETE CASCADE,
    inicio TIMESTAMPTZ NOT NULL,
    termino TIMESTAMPTZ,  -- nulo mientras el tramo sigue abierto
    usuario_id INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT termino_posterior_al_inicio CHECK (termino IS NULL OR termino >= inicio)
);

CREATE INDEX idx_tramos_trabajo_orden ON tramos_trabajo(orden_trabajo_id, inicio);

-- ---------------------------------------------------------------------------
-- Lineas de repuesto de la OT
-- Se extiende movimientos_insumo en vez de crear una tabla paralela: ya vincula insumo,
-- orden de trabajo, cantidad y usuario, y ya descuenta stock.
-- ---------------------------------------------------------------------------
CREATE TYPE estado_facturable_linea AS ENUM ('si', 'no', 'pendiente');

-- El papel tiene tres casillas por linea (SI / NO / ?). El '?' es el caso que describio el jefe de taller:
-- clientes antiguos donde se decide despues si se cobra o no. Nace en 'pendiente' para que esa
-- decision sea explicita y no un olvido.
ALTER TABLE movimientos_insumo
    ADD COLUMN facturable estado_facturable_linea NOT NULL DEFAULT 'pendiente';

-- Texto libre de la columna DESCRIPCION / OBSERVACIONES del papel
ALTER TABLE movimientos_insumo ADD COLUMN descripcion TEXT;

-- Precio de la linea. Segun la entrevista (punto 8) se cobra el valor de reposicion mas
-- reciente, no el historico, asi que se guarda por movimiento y no se deriva del catalogo.
ALTER TABLE movimientos_insumo ADD COLUMN precio_unitario NUMERIC(12,2);

-- En el papel el tecnico escribe el repuesto a mano ("llave de contacto") sin codigo. Ademas
-- el stock parte de cero (entrevista, punto 11), asi que exigir catalogo bloquearia el uso real.
ALTER TABLE movimientos_insumo ALTER COLUMN insumo_id DROP NOT NULL;

-- Una linea tiene que identificar el repuesto de alguna forma: por catalogo o escrito a mano.
ALTER TABLE movimientos_insumo
    ADD CONSTRAINT linea_con_insumo_o_descripcion
    CHECK (insumo_id IS NOT NULL OR descripcion IS NOT NULL);
