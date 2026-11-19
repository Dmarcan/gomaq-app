-- Limpieza de datos de prueba creados durante las verificaciones de desarrollo.
-- NO se ejecuta automaticamente ni viaja en la imagen de despliegue (.dockerignore). Solo para una base
-- de desarrollo; borra de forma permanente, asi que hay que confirmarlo a proposito:
--   PGOPTIONS="-c gomaq.limpieza_confirmada=si" psql "$DATABASE_URL" -f db/scripts/limpiar_datos_prueba.sql
-- Sin esa opcion el script se detiene antes de borrar nada. Lee cada bloque antes de correrlo.

\set ON_ERROR_STOP on

DO $guarda$
BEGIN
    IF coalesce(current_setting('gomaq.limpieza_confirmada', true), '') <> 'si' THEN
        RAISE EXCEPTION 'Limpieza no confirmada: ver la cabecera de limpiar_datos_prueba.sql';
    END IF;
END
$guarda$;

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

-- 5b. Cambios de ficha hechos desde el portal (clientes_cambios, migracion 047, tambien de solo
--     insercion: aqui vale la via de purga) por el usuario de prueba o sobre los clientes de prueba
DELETE FROM clientes_cambios
WHERE usuario_id IN (SELECT id FROM usuarios WHERE email = 'clienteprueba@gomaq.test')
   OR cliente_id IN (SELECT id FROM clientes WHERE nombre IN ('Cliente Prueba Ejecutivo', 'Cliente Prueba Registro'));

-- 6. Usuario del registro de prueba (se creo al aprobar la solicitud de verificacion)
DELETE FROM usuarios WHERE email = 'clienteprueba@gomaq.test';

-- 7. Solicitudes de cuenta de prueba
DELETE FROM solicitudes_cliente WHERE email IN ('clienteprueba@gomaq.test', 'rechazo@test.cl');

-- 8. Clientes de prueba (verificar antes que no tengan datos reales colgando:
--    si alguno tiene OTs/maquinarias reales asociadas, este DELETE fallara por FK - es intencional)
DELETE FROM clientes WHERE nombre IN ('Cliente Prueba Ejecutivo', 'Cliente Prueba Registro');

COMMIT;
