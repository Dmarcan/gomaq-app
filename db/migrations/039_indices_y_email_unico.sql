-- Indices por las llaves foraneas que las pantallas consultan (hoy cada una recorre la tabla entera)
-- y correo unico sin distinguir mayusculas.
--
-- Solo agrega: no cambia datos ni quita nada, asi que el servidor anterior sigue funcionando
-- mientras se despliega. Las tablas son chicas (cientos de filas), el bloqueo de escritura de cada
-- CREATE INDEX dura milisegundos.

CREATE INDEX IF NOT EXISTS idx_ordenes_maquinaria ON ordenes_trabajo (maquinaria_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_cliente ON ordenes_trabajo (cliente_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_mecanico ON ordenes_trabajo (mecanico_id);

-- la linea de tiempo del equipo y el historial del cliente piden lo mas reciente primero
CREATE INDEX IF NOT EXISTS idx_guias_maquinaria_fecha ON guias (maquinaria_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_guias_cliente ON guias (cliente_id);

CREATE INDEX IF NOT EXISTS idx_facturas_maquinaria ON facturas (maquinaria_id);
CREATE INDEX IF NOT EXISTS idx_facturas_cliente ON facturas (cliente_id);

CREATE INDEX IF NOT EXISTS idx_maquinarias_cliente ON maquinarias (cliente_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_cliente ON usuarios (cliente_id);

-- Ya existe UNIQUE(email), pero distingue mayusculas, y el login busca con lower(email): dos filas
-- que solo difieren en mayusculas harian ambiguo el inicio de sesion. Si hubiera duplicados, la
-- migracion se detiene con la lista (y el servidor anterior se mantiene) en vez de un error generico.
DO $$
DECLARE
    duplicados text;
BEGIN
    SELECT string_agg(correo || ' (ids ' || ids || ')', '; ') INTO duplicados
    FROM (
        SELECT lower(email) AS correo, string_agg(id::text, ',' ORDER BY id) AS ids
        FROM usuarios
        GROUP BY lower(email)
        HAVING count(*) > 1
    ) d;
    IF duplicados IS NOT NULL THEN
        RAISE EXCEPTION 'Hay correos duplicados en usuarios (ignorando mayusculas): %', duplicados;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_lower_unico ON usuarios (lower(email));
