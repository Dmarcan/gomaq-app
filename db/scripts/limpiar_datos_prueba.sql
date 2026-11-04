-- Limpieza de datos de prueba creados durante las verificaciones de desarrollo.
-- NO se ejecuta automaticamente: correr a mano cuando se decida, con
--   cat db/scripts/limpiar_datos_prueba.sql | sudo -u postgres psql -d gomaq
-- Revisa cada bloque antes de correr - borra datos de forma permanente.

BEGIN;

-- ordenes_eventos (historial de la OT, migracion 020) es de solo insercion: sus triggers rechazan el
-- DELETE. Esta limpieza es una de las tres vias de purga permitidas (con las pruebas de escritura y
-- usuarios-demo.js borrar); SET LOCAL vale solo hasta el COMMIT de esta transaccion.
SET LOCAL gomaq.purga = 'on';

-- 1. Movimientos de insumos asociados a OTs de prueba (consumos de verificacion)
DELETE FROM movimientos_insumo
WHERE orden_trabajo_id IN (SELECT id FROM ordenes_trabajo WHERE maquinaria_id IN (SELECT id FROM maquinarias WHERE codigo = 'GH-999'));

-- 2. Facturas de prueba: las ligadas a guias de la maquinaria de prueba GH-999
--    y las que se crearon en las verificaciones del ciclo de arriendo de GH-204
DELETE FROM facturas
WHERE guia_recepcion_id IN (SELECT id FROM guias WHERE maquinaria_id IN (SELECT id FROM maquinarias WHERE codigo = 'GH-999'));
DELETE FROM facturas WHERE folio IN ('FOLIO-MAL', '8842', '15414', 'TEST-9001');

-- 3. Guias de prueba de la maquinaria GH-999 (PDFs dummy)
DELETE FROM guias WHERE maquinaria_id IN (SELECT id FROM maquinarias WHERE codigo = 'GH-999');

-- 4. Ordenes de trabajo de la maquinaria de prueba (si se crearon), con su historial
DELETE FROM ordenes_eventos
WHERE orden_trabajo_id IN (SELECT id FROM ordenes_trabajo WHERE maquinaria_id IN (SELECT id FROM maquinarias WHERE codigo = 'GH-999'));
DELETE FROM ordenes_trabajo WHERE maquinaria_id IN (SELECT id FROM maquinarias WHERE codigo = 'GH-999');

-- 5. Maquinaria de prueba GH-999 ("Toyota 8FG25-EDITADO", creada para verificar el perfil de equipo)
DELETE FROM maquinarias WHERE codigo = 'GH-999';

-- 6. Usuario del registro de prueba (se creo al aprobar la solicitud de verificacion)
DELETE FROM usuarios WHERE email = 'clienteprueba@gomaq.test';

-- 7. Solicitudes de cuenta de prueba
DELETE FROM solicitudes_cliente WHERE email IN ('clienteprueba@gomaq.test', 'rechazo@test.cl');

-- 8. Clientes de prueba (verificar antes que no tengan datos reales colgando:
--    si alguno tiene OTs/maquinarias reales asociadas, este DELETE fallara por FK - es intencional)
DELETE FROM clientes WHERE nombre IN ('Cliente Prueba Ejecutivo', 'Cliente Prueba Registro');

COMMIT;
