-- Migracion 037: giro y plazo de pago habitual del cliente.
--
-- giro: actividad del cliente, como aparece en sus facturas (la planilla de facturacion lo trae).
-- plazo_pago_dias: dias entre la emision y el vencimiento que se acostumbra con el cliente. Nulo = aun
-- no elegido; 0 = contado. Sirve para calcular el vencimiento cuando la factura no lo trae y para
-- avisar cuando el PDF trae un vencimiento distinto.
--
-- Solo AGREGA dos columnas nulas: el servidor anterior no las lee ni las escribe (SELECT c.* las
-- devuelve y el panel anterior las ignora). Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS giro VARCHAR(150);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS plazo_pago_dias INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clientes_plazo_pago_dias_chk') THEN
        ALTER TABLE clientes ADD CONSTRAINT clientes_plazo_pago_dias_chk
            CHECK (plazo_pago_dias IS NULL OR plazo_pago_dias BETWEEN 0 AND 365);
    END IF;
END $$;
