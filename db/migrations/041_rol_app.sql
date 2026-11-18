-- Rol de base con menos permisos para la API y el worker (`gomaq_app`).
--
-- Hoy la API se conecta con el dueno de la base: una inyeccion SQL o un error podrian cambiar el
-- esquema, borrar tablas o reescribir el historial. Este rol solo puede leer y escribir filas:
--   * sin DDL (no puede crear, alterar ni borrar tablas, ni TRUNCATE);
--   * sin UPDATE ni DELETE en `ordenes_eventos` (historial de solo insercion: el candado de la
--     migracion 020 queda reforzado, la via de purga ya no sirve con este rol);
--   * solo lectura en `schema_migraciones`.
--
-- Esta migracion NO cambia nada que ya funcione: crea el rol sin login. David le pone la clave y
-- cambia la variable DATABASE_URL de `gomaq-app` y `gomaq-worker` cuando quiera (ver ESTADO.md);
-- las migraciones y los scripts de carga o borrado siguen usando el dueno por DATABASE_URL_MIGRACION.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gomaq_app') THEN
        CREATE ROLE gomaq_app NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO gomaq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gomaq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gomaq_app;

REVOKE UPDATE, DELETE ON ordenes_eventos FROM gomaq_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migraciones FROM gomaq_app;

-- tablas y secuencias que creen las migraciones futuras (las crea el dueno que corre migrar.js)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gomaq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gomaq_app;
