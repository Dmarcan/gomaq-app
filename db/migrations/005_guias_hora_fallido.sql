-- Migracion 005: hora exacta de despacho/recepcion y guias anuladas (despacho/retiro fallido)
-- La facturacion de dias de arriendo depende de la hora exacta, no solo la fecha (entrevista con la empresa)

ALTER TABLE guias ALTER COLUMN fecha TYPE TIMESTAMPTZ USING fecha::timestamptz;

-- guia anulada (equipo no se uso, o el cliente rechazo el retiro): no se factura ni cuenta como dia de arriendo
ALTER TABLE guias ADD COLUMN fallido BOOLEAN NOT NULL DEFAULT false;
