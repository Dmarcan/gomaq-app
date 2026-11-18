-- Comprobante de pago de la factura (foto JPG/PNG o PDF). Es la ruta dentro del bucket privado
-- `documentos-gomaq`, nunca una URL: se entrega siempre con URL firmada de 1 hora.
--
-- Solo agrega una columna nula: las facturas ya pagadas quedan "sin comprobante" y no se les exige
-- nada, y el servidor anterior sigue funcionando mientras se despliega.
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS comprobante_pago_ruta TEXT;
