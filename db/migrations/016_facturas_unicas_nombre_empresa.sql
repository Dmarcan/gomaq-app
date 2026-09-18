-- Migracion 016: una factura por arriendo y por reparacion, y el nombre de la empresa al registrarse
--
-- 1) Un doble clic en "Subir factura" creaba dos facturas para el mismo ciclo de arriendo o la
-- misma OT, y el reporte de ventas por ejecutivo sumaba el monto dos veces. Indices unicos
-- parciales: solo aplican cuando la columna tiene valor, porque cada factura es de un tipo o
-- del otro.
--
-- ANTES DE APLICARLA EN EL SERVIDOR, revisar que no existan duplicados (si los hay, la migracion
-- falla y hay que decidir cual factura conservar):
--   SELECT guia_recepcion_id, COUNT(*) FROM facturas WHERE guia_recepcion_id IS NOT NULL
--   GROUP BY 1 HAVING COUNT(*) > 1;
--   SELECT orden_trabajo_id, COUNT(*) FROM facturas WHERE orden_trabajo_id IS NOT NULL
--   GROUP BY 1 HAVING COUNT(*) > 1;
--
-- 2) El formulario de registro decia "Datos de la empresa que representas" pero no pedia el
-- nombre de la empresa: al aprobar la cuenta, el cliente se creaba con el nombre de la persona
-- de contacto, y eso aparecia en Clientes y en las facturas.

CREATE UNIQUE INDEX facturas_guia_recepcion_unica ON facturas (guia_recepcion_id)
    WHERE guia_recepcion_id IS NOT NULL;
CREATE UNIQUE INDEX facturas_orden_trabajo_unica ON facturas (orden_trabajo_id)
    WHERE orden_trabajo_id IS NOT NULL;

ALTER TABLE solicitudes_cliente ADD COLUMN nombre_empresa VARCHAR(150);
