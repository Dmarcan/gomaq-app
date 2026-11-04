-- Historial de eventos de la orden de trabajo.
--
-- Hasta ahora la OT solo guardaba su estado actual y unas pocas horas (aceptada_at, en_camino_at,
-- llegada_at, fecha_cierre): no habia forma de saber quien la creo, quien la asigno, quien la tomo,
-- quien la valorizo, ni cuando se cambio algo y desde que estado. Esta tabla es el registro de esos
-- hechos. Es de SOLO INSERCION: el servidor escribe cada evento en la misma transaccion que el
-- cambio, y despues nadie lo modifica ni lo borra (lo imponen los triggers de mas abajo).
--
-- Solo agrega: no toca ordenes_trabajo ni ninguna otra tabla, asi que la instancia anterior sigue
-- funcionando mientras Railway reemplaza la version.

CREATE TABLE ordenes_eventos (
    id BIGSERIAL PRIMARY KEY,
    -- sin ON DELETE CASCADE a proposito: borrar una OT no debe llevarse su historial en silencio
    -- (solo la via de purga de mas abajo permite borrarlo)
    orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
    tipo TEXT NOT NULL CHECK (tipo IN (
        'creacion', 'asignacion', 'toma', 'cambio_estado', 'cierre', 'valorizacion',
        'linea_agregada', 'linea_modificada', 'linea_anulada', 'factura_cargada'
    )),
    estado_anterior estado_orden,
    estado_nuevo estado_orden,
    -- nulo en la carga inicial (no se sabe quien hizo lo que ya estaba hecho)
    usuario_id INTEGER REFERENCES usuarios(id),
    rol TEXT,
    -- cuando ocurrio: la hora del telefono si la hay, o la del servidor
    ocurrio_en TIMESTAMPTZ NOT NULL,
    -- cuando llego al servidor; la diferencia con ocurrio_en es el atraso de la cola offline
    registrado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    origen TEXT NOT NULL CHECK (origen IN ('terreno', 'panel', 'sistema', 'migracion')),
    -- uuid de la tarea de la cola offline; un reintento con el mismo uuid y tipo no duplica
    uuid_cliente UUID,
    -- false cuando el cambio llego atrasado y no se aplico (la OT ya estaba en ese estado o mas
    -- adelante): queda el registro de que el mecanico lo hizo, pero no movio nada
    aplicado BOOLEAN NOT NULL DEFAULT true,
    -- la hora del telefono esta en el futuro o es anterior a la creacion de la OT
    hora_dudosa BOOLEAN NOT NULL DEFAULT false,
    detalle JSONB
);

CREATE UNIQUE INDEX uq_ordenes_eventos_uuid_tipo ON ordenes_eventos (uuid_cliente, tipo)
    WHERE uuid_cliente IS NOT NULL;
CREATE INDEX idx_ordenes_eventos_orden ON ordenes_eventos (orden_trabajo_id, ocurrio_en);

-- Candado de solo insercion. La unica salida es la via de purga: una transaccion que hace
-- SET LOCAL gomaq.purga = 'on' (o set_config('gomaq.purga', 'on', true)). La usan solo las pruebas
-- de escritura, db/scripts/limpiar_datos_prueba.sql y scripts/usuarios-demo.js borrar, que
-- necesitan borrar OT y usuarios de prueba. La aplicacion nunca la activa.
CREATE FUNCTION ordenes_eventos_solo_insercion() RETURNS trigger AS $$
BEGIN
    IF current_setting('gomaq.purga', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'ordenes_eventos es de solo insercion: % no esta permitido', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ordenes_eventos_sin_cambios
    BEFORE UPDATE OR DELETE ON ordenes_eventos
    FOR EACH ROW EXECUTE FUNCTION ordenes_eventos_solo_insercion();

CREATE TRIGGER ordenes_eventos_sin_truncate
    BEFORE TRUNCATE ON ordenes_eventos
    FOR EACH STATEMENT EXECUTE FUNCTION ordenes_eventos_solo_insercion();

-- Carga inicial: lo que cada OT ya existente permite reconstruir con sus fechas. La asignacion y
-- la valorizacion no tienen fecha propia y no se reconstruyen; tampoco se sabe quien hizo nada
-- (usuario_id nulo). Con una base vacia no inserta nada.
INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_anterior, estado_nuevo, ocurrio_en, origen, detalle)
SELECT id, 'creacion', NULL, NULL, fecha_creacion, 'migracion', '{"reconstruido": true}'::jsonb
FROM ordenes_trabajo;

INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_anterior, estado_nuevo, ocurrio_en, origen, detalle)
SELECT id, 'cambio_estado', 'asignada', 'aceptada', aceptada_at, 'migracion', '{"reconstruido": true}'::jsonb
FROM ordenes_trabajo WHERE aceptada_at IS NOT NULL;

-- un APK antiguo salta de asignada a en_camino y deja aceptada_at nulo: ahi el estado anterior no
-- se conoce y no se inventa
INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_anterior, estado_nuevo, ocurrio_en, origen, detalle)
SELECT id, 'cambio_estado', CASE WHEN aceptada_at IS NULL THEN NULL ELSE 'aceptada'::estado_orden END,
       'en_camino', en_camino_at, 'migracion', '{"reconstruido": true}'::jsonb
FROM ordenes_trabajo WHERE en_camino_at IS NOT NULL;

-- el estado anterior de la llegada no se conoce (un APK antiguo salta de asignada a en_terreno)
INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_anterior, estado_nuevo, ocurrio_en, origen, detalle)
SELECT id, 'cambio_estado', NULL, 'en_terreno', llegada_at, 'migracion', '{"reconstruido": true}'::jsonb
FROM ordenes_trabajo WHERE llegada_at IS NOT NULL;

INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_anterior, estado_nuevo, ocurrio_en, origen, detalle)
SELECT id, 'cierre', NULL, 'finalizada', fecha_cierre, 'migracion', '{"reconstruido": true}'::jsonb
FROM ordenes_trabajo WHERE fecha_cierre IS NOT NULL;
