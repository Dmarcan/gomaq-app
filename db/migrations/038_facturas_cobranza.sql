-- Migracion 038: cobranza de facturas (neto, vencimiento, pago, nota de credito) y division del traslado.
--
-- Columnas nuevas en `facturas`, todas nulas y sin valor por defecto (no reescriben filas):
--   monto_neto         MONTO NETO de la factura, leido del PDF y confirmado por el administrativo. Con neto,
--                      la rentabilidad cuenta como ingreso neto - traslado (utils/rentabilidad.js); sin neto
--                      (las facturas ya cargadas) sigue la regla anterior, monto - traslado.
--   traslado_entrega   division del traslado que confirma el administrativo (montos netos, como la linea de
--   traslado_retiro    la factura). Nulos los dos = un solo monto, sin dividir. monto_traslado sigue siendo
--                      el total y la unica cifra que usa la rentabilidad.
--   fecha_vencimiento  vencimiento de la factura ("Pagos: AAAA-MM-DD" del PDF, o emision + plazo del cliente)
--   fecha_pago         dia en que se pago; nulo = por cobrar
--   anulada_nc         folio de la nota de credito que anulo la factura en el SII
-- El estado (vencida, proxima, pagada...) y los dias de mora NO se guardan: salen de utils/cobranza.js.
--
-- Trigger facturas_traslado_coherente (BEFORE INSERT OR UPDATE): si alguna de las dos partes tiene valor y
-- su suma no es igual a monto_traslado, deja las dos en NULL. El servidor anterior solo escribe el total:
-- si corrige monto_traslado, la division vieja que ya no cuadra se borra sola, sin un CHECK que le rompa
-- la peticion.
-- El mismo trigger deja monto_neto en NULL si queda mayor que monto (el neto nunca supera al total): el
-- servidor anterior puede corregir el monto de una factura que ya tiene neto, y un neto inflado inflaria la
-- rentabilidad. Sin neto, la factura vuelve a la regla anterior (monto - traslado), la de todas las
-- facturas cargadas antes de esta migracion.
--
-- Compatible con el servidor anterior corriendo un momento durante el despliegue: no nombra estas
-- columnas y sus INSERT y UPDATE siguen valiendo. No toca el trigger facturas_completar (023) ni rellena
-- emision o vencimiento en las facturas existentes.
--
-- Solo agrega, y se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE facturas
    ADD COLUMN IF NOT EXISTS monto_neto NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS traslado_entrega NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS traslado_retiro NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE,
    ADD COLUMN IF NOT EXISTS fecha_pago DATE,
    ADD COLUMN IF NOT EXISTS anulada_nc VARCHAR(50);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facturas_cobranza_montos_chk') THEN
        ALTER TABLE facturas ADD CONSTRAINT facturas_cobranza_montos_chk CHECK (
            (monto_neto IS NULL OR monto_neto >= 0)
            AND (traslado_entrega IS NULL OR traslado_entrega >= 0)
            AND (traslado_retiro IS NULL OR traslado_retiro >= 0));
    END IF;
    -- una nota de credito sin folio no es una anulacion: el texto vacio no se guarda
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facturas_anulada_nc_chk') THEN
        ALTER TABLE facturas ADD CONSTRAINT facturas_anulada_nc_chk
            CHECK (anulada_nc IS NULL OR btrim(anulada_nc) <> '');
    END IF;
END $$;

CREATE OR REPLACE FUNCTION facturas_traslado_coherente() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.traslado_entrega IS NOT NULL OR NEW.traslado_retiro IS NOT NULL)
       AND COALESCE(NEW.traslado_entrega, 0) + COALESCE(NEW.traslado_retiro, 0) <> COALESCE(NEW.monto_traslado, 0) THEN
        NEW.traslado_entrega := NULL;
        NEW.traslado_retiro := NULL;
    END IF;
    IF NEW.monto_neto IS NOT NULL AND NEW.monto IS NOT NULL AND NEW.monto_neto > NEW.monto THEN
        NEW.monto_neto := NULL;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS facturas_traslado_coherente ON facturas;
CREATE TRIGGER facturas_traslado_coherente BEFORE INSERT OR UPDATE ON facturas
    FOR EACH ROW EXECUTE FUNCTION facturas_traslado_coherente();

-- las tarjetas del inicio y la lista de vencidas y proximas buscan por vencimiento entre las por cobrar
CREATE INDEX IF NOT EXISTS idx_facturas_por_cobrar_vencimiento ON facturas (fecha_vencimiento)
    WHERE fecha_pago IS NULL AND anulada_nc IS NULL;
