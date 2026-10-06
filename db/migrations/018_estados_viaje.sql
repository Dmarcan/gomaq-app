-- Estados del viaje del mecanico: aceptada y en_camino.
--
-- El flujo real es: la orden la crea el cliente o el administrativo, el mecanico la acepta, viaja
-- al destino y al llegar pulsa Iniciar. Hasta ahora solo existia asignada -> en_terreno, asi que
-- el viaje y el trabajo quedaban mezclados. Con estos dos estados (y sus horas) se puede medir
-- cuanto tarda el mecanico en aceptar, cuanto viaja y cuando empieza el trabajo.
--
-- Orden del ciclo: pendiente -> asignada -> aceptada -> en_camino -> en_terreno <-> en_reparacion
-- -> finalizada. Los valores nuevos no se usan en esta migracion: Postgres no deja usar un valor
-- de enum agregado en la misma transaccion.

ALTER TYPE estado_orden ADD VALUE IF NOT EXISTS 'aceptada' AFTER 'asignada';
ALTER TYPE estado_orden ADD VALUE IF NOT EXISTS 'en_camino' AFTER 'aceptada';

ALTER TABLE ordenes_trabajo ADD COLUMN aceptada_at TIMESTAMPTZ;
ALTER TABLE ordenes_trabajo ADD COLUMN en_camino_at TIMESTAMPTZ;
-- hora a la que el mecanico llego y pulso Iniciar por primera vez (inicio del trabajo)
ALTER TABLE ordenes_trabajo ADD COLUMN llegada_at TIMESTAMPTZ;
