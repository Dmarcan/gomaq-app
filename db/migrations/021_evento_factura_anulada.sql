-- Migracion 021: tipo de evento 'factura_anulada' en el historial de la orden de trabajo.
--
-- Anular una factura subida por error borra su fila de `facturas`; el rastro (folio, monto, archivo,
-- motivo y quien la anulo) queda como un evento de este tipo en ordenes_eventos. La migracion 020
-- limito los tipos con un CHECK que no lo incluye, asi que se reemplaza por uno con el tipo nuevo.
--
-- Solo agrega, y es segura sobre datos existentes y con la version anterior del servidor corriendo
-- un momento: el CHECK nuevo admite todo lo que admitia el anterior (los eventos que ya hay lo
-- cumplen) y la version vieja nunca escribe el tipo nuevo. No toca los triggers de solo insercion,
-- el indice unico (uuid_cliente, tipo) ni ninguna fila.
--
-- Se puede correr mas de una vez: borra por contenido cualquier CHECK que limite `tipo`, sea cual
-- sea su nombre, y vuelve a crear el suyo.

-- migrar.js corre cada migracion en su transaccion: SET LOCAL vale solo para esta. Si hay una
-- transaccion abierta sobre ordenes_eventos, el ALTER TABLE espera su bloqueo; con el limite falla
-- en 5 s (y Railway no reemplaza la version) en vez de colgar el despliegue.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    restriccion RECORD;
BEGIN
    FOR restriccion IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'ordenes_eventos'::regclass AND c.contype = 'c' AND a.attname = 'tipo'
    LOOP
        EXECUTE format('ALTER TABLE ordenes_eventos DROP CONSTRAINT %I', restriccion.conname);
    END LOOP;
END $$;

ALTER TABLE ordenes_eventos ADD CONSTRAINT ordenes_eventos_tipo_check CHECK (tipo IN (
    'creacion', 'asignacion', 'toma', 'cambio_estado', 'cierre', 'valorizacion',
    'linea_agregada', 'linea_modificada', 'linea_anulada', 'factura_cargada', 'factura_anulada'
));
