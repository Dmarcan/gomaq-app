-- Migracion 031: hora de llegada que se mantiene al dia, "detenido" frente a "sin senal" y espera
-- tras un intento fallido del servicio de rutas.
--
-- Solo AGREGA columnas NULL-ables: el servidor anterior las ignora y puede correr un momento con
-- este esquema. Se puede correr mas de una vez. Ninguna columna guarda historial de posiciones.
--
-- ordenes_trabajo:
--  - eta_ajustada_llegada_at: la hora de llegada de la ETA de rutas (ORS) escalada con la distancia
--    recta que queda al destino (utils/etaViaje.js). Se calcula con cada posicion nueva. Las columnas
--    eta_segundos y eta_calculada_at NO se tocan: services/rutasEta.js las usa para decidir cuando
--    consultar de nuevo. NULL cuando no aplica o cuando llega una ruta nueva.
--  - eta_ajustada_at: hora de captura de la posicion con la que se hizo ese ajuste, para mostrar
--    "Actualizada hace X" sin exponer la posicion.
--  - eta_intento_at: cuando se reservo la ultima consulta al servicio de rutas, haya salido bien o
--    no. Sin esto, si el servicio falla la OT nunca tiene una ETA de rutas "previa" y cada posicion
--    nueva contaria como primera consulta, gastando las consultas de la OT en pocos minutos.
-- posiciones_mecanico:
--  - quieto_desde: desde cuando el mecanico no se mueve de ese punto. Es una hora, no un historial.

SET LOCAL lock_timeout = '5s';

ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_ajustada_llegada_at TIMESTAMPTZ;
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_ajustada_at TIMESTAMPTZ;
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_intento_at TIMESTAMPTZ;
ALTER TABLE posiciones_mecanico ADD COLUMN IF NOT EXISTS quieto_desde TIMESTAMPTZ;
