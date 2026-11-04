-- Migracion 025: ajustes de inventario (conteo fisico) y motivo de los movimientos.
--
-- El administrativo cuadra un descuadre (existencia negativa en una ubicacion) registrando el
-- conteo fisico: el sistema guarda la diferencia como un movimiento de tipo 'ajuste', con su motivo.
--   tipo 'ajuste'    nuevo valor del enum tipo_movimiento_insumo
--   motivo_codigo    por que se ajusta o traspasa (se valida en utils/stock.js, sin CHECK aqui)
-- Dos indices parciales aceleran la reconstruccion de "desde cuando esta negativo" y "ver
-- movimientos" por ubicacion e insumo.
--
-- Solo agrega, y es segura con la version anterior del servidor corriendo: esa version nunca escribe
-- 'ajuste' y sus consultas de movimientos filtran por tipo 'salida' o no miran el tipo. El valor
-- nuevo del enum no se usa dentro de esta misma transaccion (Postgres no lo permite), asi que no
-- hay CHECK ni relleno que lo mencione.
--
-- Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TYPE tipo_movimiento_insumo ADD VALUE IF NOT EXISTS 'ajuste';

ALTER TABLE movimientos_insumo ADD COLUMN IF NOT EXISTS motivo_codigo VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_mov_insumo_origen
    ON movimientos_insumo (ubicacion_origen_id, insumo_id, created_at)
    WHERE ubicacion_origen_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mov_insumo_destino
    ON movimientos_insumo (ubicacion_destino_id, insumo_id, created_at)
    WHERE ubicacion_destino_id IS NOT NULL;
