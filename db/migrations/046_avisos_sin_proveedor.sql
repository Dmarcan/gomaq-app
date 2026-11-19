-- Migracion 046: avisos sin proveedor.
-- Desde este cambio solo se encola lo que tiene envio real (el correo de factura, ver utils/avisos.js). Los avisos
-- que ya estaban en la cola y no tienen proveedor (WhatsApp, mecanico asignado, OT finalizada, mantencion, etc.)
-- no se van a enviar nunca: se cancelan para que el panel no los cuente en "Avisos con problemas".
-- Solo datos, no cambia el esquema: el worker con el codigo anterior puede seguir corriendo mientras se despliega.
-- Los ya enviados o cancelados no se tocan. COALESCE: un aviso sin tipo tambien cuenta como sin proveedor.
-- Durante el despliegue una instancia antigua de la API puede encolar alguno mas: si el panel muestra avisos en
-- error de estos tipos justo despues, basta repetir este UPDATE a mano.

UPDATE notificaciones_pendientes
   SET estado = 'cancelado',
       ultimo_error = 'Sin proveedor: este aviso ya no se envia'
 WHERE estado IN ('pendiente', 'error')
   AND NOT (canal = 'email' AND COALESCE(payload->>'tipo', '') = 'factura_emitida');
