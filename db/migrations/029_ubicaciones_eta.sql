-- Migracion 029: ubicacion del cliente, destino de la OT, posicion del mecanico y hora estimada (ETA).
--
-- Hasta ahora la direccion era texto libre y no habia coordenadas en ningun lado. Esta migracion
-- agrega lo necesario para: (1) que el cliente marque la ubicacion de su empresa al registrarse,
-- (2) que el mecanico navegue hasta ella, (3) calcular y mostrar la hora estimada de llegada y
-- (4) dibujar equipos y furgones en un mapa.
--
-- Solo AGREGA y todo es NULL-able: el servidor anterior sigue funcionando durante el despliegue
-- (un APK o un panel viejo simplemente no mandan coordenadas). Se puede correr mas de una vez.
--
-- Coordenadas (clientes, solicitudes_cliente, solicitudes, guias):
--   La ubicacion de la empresa se pide UNA VEZ, al registrarse (solicitudes_cliente) y pasa a
--   clientes al aprobar la cuenta. solicitudes.latitud/longitud son opcionales: solo si el equipo
--   esta en una obra distinta a la empresa. guias guarda donde se despacho el equipo (arriendo vigente).
--   Un arriendo no tiene tabla propia: es una guia de despacho no fallida (utils/arriendos.js).
--   Siempre las dos o ninguna, dentro de rango. NUMERIC(9,6) = ~0,1 m.
--
-- ordenes_trabajo:
--   destino_*   "foto" del destino al crear o asignar la OT, para que no cambie a mitad del viaje
--               si despues se edita la direccion. destino_origen lo calcula el servidor.
--   eta_*       ultima hora estimada. eta_origen_lat/lng es la posicion del mecanico usada en ese
--               calculo: con ella se decide si se movio lo suficiente para volver a consultar.
--               eta_consultas cuenta las consultas al servicio de rutas de esta OT (tope por OT).
--
-- posiciones_mecanico: UNA fila por mecanico (se pisa en cada envio), sin historial. Solo tiene
--   sentido mientras la OT esta en_camino; el backend la borra al pasar a en_terreno, finalizar o
--   reasignar. El cliente nunca la ve, solo la ETA.
--
-- uso_ors: consultas diarias al servicio de rutas, para no pasar el cupo gratuito. El backend
--   reserva con un UPDATE atomico antes de llamar (no se lee y luego se incrementa).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Coordenadas
-- ---------------------------------------------------------------------------------------------
ALTER TABLE clientes            ADD COLUMN IF NOT EXISTS latitud NUMERIC(9,6);
ALTER TABLE clientes            ADD COLUMN IF NOT EXISTS longitud NUMERIC(9,6);
ALTER TABLE solicitudes_cliente ADD COLUMN IF NOT EXISTS latitud NUMERIC(9,6);
ALTER TABLE solicitudes_cliente ADD COLUMN IF NOT EXISTS longitud NUMERIC(9,6);
ALTER TABLE solicitudes         ADD COLUMN IF NOT EXISTS latitud NUMERIC(9,6);
ALTER TABLE solicitudes         ADD COLUMN IF NOT EXISTS longitud NUMERIC(9,6);
ALTER TABLE guias               ADD COLUMN IF NOT EXISTS latitud NUMERIC(9,6);
ALTER TABLE guias               ADD COLUMN IF NOT EXISTS longitud NUMERIC(9,6);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['clientes', 'solicitudes_cliente', 'solicitudes', 'guias']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_' || t || '_coordenadas') THEN
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I CHECK (
                    (latitud IS NULL AND longitud IS NULL)
                    OR (latitud IS NOT NULL AND longitud IS NOT NULL
                        AND latitud BETWEEN -90 AND 90 AND longitud BETWEEN -180 AND 180)
                )',
                t, 'chk_' || t || '_coordenadas'
            );
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Orden de trabajo: destino fijado y ultima ETA
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS destino_lat NUMERIC(9,6);
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS destino_lng NUMERIC(9,6);
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS destino_origen VARCHAR(10);
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_segundos INTEGER;
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_distancia_m INTEGER;
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_calculada_at TIMESTAMPTZ;
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_fuente VARCHAR(12);
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_origen_lat NUMERIC(9,6);
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_origen_lng NUMERIC(9,6);
ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS eta_consultas INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ot_destino') THEN
        ALTER TABLE ordenes_trabajo ADD CONSTRAINT chk_ot_destino CHECK (
            (destino_lat IS NULL AND destino_lng IS NULL AND destino_origen IS NULL)
            OR (destino_lat IS NOT NULL AND destino_lng IS NOT NULL AND destino_origen IS NOT NULL
                AND destino_lat BETWEEN -90 AND 90 AND destino_lng BETWEEN -180 AND 180
                AND destino_origen IN ('solicitud', 'guia', 'cliente'))
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ot_eta') THEN
        ALTER TABLE ordenes_trabajo ADD CONSTRAINT chk_ot_eta CHECK (
            (eta_fuente IS NULL OR eta_fuente IN ('ors', 'aproximada'))
            AND (eta_segundos IS NULL OR eta_segundos >= 0)
            AND (eta_distancia_m IS NULL OR eta_distancia_m >= 0)
            AND eta_consultas >= 0
            AND ((eta_origen_lat IS NULL AND eta_origen_lng IS NULL)
                 OR (eta_origen_lat IS NOT NULL AND eta_origen_lng IS NOT NULL
                     AND eta_origen_lat BETWEEN -90 AND 90 AND eta_origen_lng BETWEEN -180 AND 180))
        );
    END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Ultima posicion de cada mecanico (sin historial)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posiciones_mecanico (
    usuario_id        INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
    orden_trabajo_id  INTEGER NOT NULL REFERENCES ordenes_trabajo(id) ON DELETE CASCADE,
    latitud           NUMERIC(9,6) NOT NULL CHECK (latitud BETWEEN -90 AND 90),
    longitud          NUMERIC(9,6) NOT NULL CHECK (longitud BETWEEN -180 AND 180),
    precision_m       INTEGER CHECK (precision_m IS NULL OR precision_m >= 0),
    capturada_en      TIMESTAMPTZ NOT NULL, -- hora del telefono: decide cual posicion es mas nueva
    recibida_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posiciones_mecanico_ot ON posiciones_mecanico(orden_trabajo_id);

-- ---------------------------------------------------------------------------------------------
-- Cupo diario del servicio de rutas
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uso_ors (
    dia        DATE PRIMARY KEY,
    consultas  INTEGER NOT NULL DEFAULT 0 CHECK (consultas >= 0)
);
