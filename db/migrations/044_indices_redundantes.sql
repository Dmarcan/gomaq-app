-- Dos indices que otro objeto ya cubre, y que solo cuestan escritura:
--   * idx_facturas_guia_recepcion (008): lo cubre el unico parcial facturas_guia_recepcion_unica (016), que
--     sirve para buscar por guia_recepcion_id y para revisar la clave foranea al borrar una guia.
--   * idx_ot_servicios_orden (013): lo cubre UNIQUE (orden_trabajo_id, servicio_id) como prefijo.
--
-- Sin CONCURRENTLY: migrar.js corre cada migracion dentro de una transaccion. Las tablas son chicas.

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_facturas_guia_recepcion;
DROP INDEX IF EXISTS idx_ot_servicios_orden;
