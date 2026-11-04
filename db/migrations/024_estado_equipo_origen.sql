-- Migracion 024: quien fijo el estado de un equipo (bloque 3).
--
-- `maquinarias.estado_origen` dice quien dejo el estado actual: 'ot' (lo puso una orden de trabajo
-- al llegar el mecanico a terreno), 'mecanico' (lo indico el mecanico al cerrar) o 'panel' (se
-- cambio a mano). Sirve para que el cierre de una orden no pise un estado que alguien puso a mano.
-- NULL = fijado antes de esta migracion, cuando solo lo escribia PATCH /estado: se trata como manual.
--
-- Relleno: un equipo operativo con alguna orden abierta (en_terreno o en_reparacion) pasa a
-- en_mantencion con origen 'ot', que es lo que hara el codigo nuevo desde ahora.
--
-- Segura con la version anterior del servidor corriendo: la columna es nulable, sin DEFAULT ni
-- CHECK, y el codigo viejo no la lee ni la escribe. Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE maquinarias ADD COLUMN IF NOT EXISTS estado_origen VARCHAR(20);

UPDATE maquinarias m SET estado = 'en_mantencion', estado_origen = 'ot'
WHERE m.estado = 'operativa'
  AND EXISTS (SELECT 1 FROM ordenes_trabajo o
              WHERE o.maquinaria_id = m.id AND o.estado IN ('en_terreno', 'en_reparacion'));
