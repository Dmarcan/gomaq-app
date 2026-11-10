-- Migracion 033: parte de la factura que corresponde a traslado.
--
-- Una factura de arriendo puede traer, ademas del arriendo, un item de traslado (entrega y retiro del
-- equipo). La rentabilidad por equipo cuenta como ingreso solo el arriendo: monto - monto_traslado. El
-- costo real del traslado para GOMAQ no se registra, asi que dejarlo fuera de los dos lados evita
-- inflar el margen del equipo. El correo y las ventas por ejecutivo siguen usando el monto total.
--
-- Solo AGREGA una columna con valor por defecto: el servidor anterior no la envia y sigue funcionando.
-- Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE facturas ADD COLUMN IF NOT EXISTS monto_traslado NUMERIC(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facturas_monto_traslado_chk') THEN
        ALTER TABLE facturas ADD CONSTRAINT facturas_monto_traslado_chk
            CHECK (monto_traslado >= 0 AND monto_traslado <= COALESCE(monto, 0));
    END IF;
END $$;
