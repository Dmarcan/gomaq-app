-- Migracion 030: ubicacion de la bodega central, para dibujarla en el mapa operativo.
--
-- La bodega ya existe como la fila ubicaciones_stock con tipo 'bodega' ("Bodega central", migracion 014).
-- Se le agregan coordenadas a esa fila: asi no hay una segunda "bodega" en otra tabla y el
-- administrativo o el gerente la editan desde el panel (PUT /api/mapa/bodega) sin desplegar.
--
-- Solo AGREGA y todo es NULL-able: el servidor anterior ignora las columnas nuevas. Se puede correr
-- mas de una vez. Un furgon nunca tiene coordenadas fijas: su posicion es la del mecanico en camino
-- (posiciones_mecanico), por eso el CHECK las limita a las ubicaciones de tipo bodega.

SET LOCAL lock_timeout = '5s';

ALTER TABLE ubicaciones_stock ADD COLUMN IF NOT EXISTS latitud NUMERIC(9,6);
ALTER TABLE ubicaciones_stock ADD COLUMN IF NOT EXISTS longitud NUMERIC(9,6);
ALTER TABLE ubicaciones_stock ADD COLUMN IF NOT EXISTS ubicacion_actualizada_por INTEGER REFERENCES usuarios(id);
ALTER TABLE ubicaciones_stock ADD COLUMN IF NOT EXISTS ubicacion_actualizada_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ubicaciones_stock_coordenadas') THEN
        ALTER TABLE ubicaciones_stock ADD CONSTRAINT chk_ubicaciones_stock_coordenadas CHECK (
            (latitud IS NULL AND longitud IS NULL)
            OR (latitud IS NOT NULL AND longitud IS NOT NULL
                AND tipo = 'bodega'
                AND latitud BETWEEN -90 AND 90 AND longitud BETWEEN -180 AND 180)
        );
    END IF;
END $$;
