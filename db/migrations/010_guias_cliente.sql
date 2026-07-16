-- Migracion 010: la guia guarda su propio cliente (snapshot al momento del evento)
-- Bug detectado en auditoria: el cliente de un arriendo se derivaba de maquinarias.cliente_id,
-- pero la guia de recepcion pone ese campo en NULL justo antes de facturar - todo arriendo
-- pendiente de facturar aparecia sin cliente y el envio de correo fallaba. Practica estandar:
-- los documentos transaccionales copian los datos al momento del evento, nunca los derivan
-- de estado mutable.

ALTER TABLE guias ADD COLUMN cliente_id INTEGER REFERENCES clientes(id);

-- backfill best-effort para las guias existentes: si la maquinaria todavia tiene el cliente
-- asignado se copia; las que ya se liberaron quedan NULL (son datos de prueba)
UPDATE guias g
SET cliente_id = m.cliente_id
FROM maquinarias m
WHERE m.id = g.maquinaria_id AND m.cliente_id IS NOT NULL AND g.cliente_id IS NULL;
