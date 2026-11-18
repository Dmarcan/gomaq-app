-- La clave de una solicitud de cuenta (solicitudes_cliente.password_hash) solo se usa mientras la solicitud
-- esta pendiente: al aprobarla se copia a usuarios y al rechazarla ya no sirve. Hasta ahora quedaba guardada
-- para siempre en las aprobadas y 30 dias en las rechazadas, sin que nadie la leyera.
--
-- Cambio: la columna admite NULL, se vacia en las que ya no estan pendientes, y un CHECK exige la clave solo
-- a las pendientes. El codigo (usuarios.js) la pone en NULL al aprobar y al rechazar.
--
-- Compatible con el servidor anterior mientras se despliega: sigue escribiendo la clave en las pendientes
-- (cumple el CHECK) y, si aprueba o rechaza en esos segundos, la deja con valor (el CHECK lo permite).
-- NOT VALID y despues VALIDATE: migrar.js corre cada migracion en una transaccion, sin CONCURRENTLY.

SET LOCAL lock_timeout = '5s';

ALTER TABLE solicitudes_cliente ALTER COLUMN password_hash DROP NOT NULL;

UPDATE solicitudes_cliente SET password_hash = NULL WHERE estado <> 'pendiente';

ALTER TABLE solicitudes_cliente
    ADD CONSTRAINT chk_solicitud_pendiente_con_clave
    CHECK (estado <> 'pendiente' OR password_hash IS NOT NULL) NOT VALID;

ALTER TABLE solicitudes_cliente VALIDATE CONSTRAINT chk_solicitud_pendiente_con_clave;
