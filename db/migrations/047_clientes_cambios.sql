-- Registro de los cambios que un cliente hace a los datos de su empresa desde el portal
-- ("Mi empresa", PATCH /api/clientes/mia).
--
-- Cada fila guarda quien cambio que: para cada campo modificado, el valor de antes y el de despues.
-- Solo se registran los cambios hechos por el propio cliente en el portal; las ediciones de la
-- oficina (PATCH /api/clientes/:id) no pasan por aqui. Es de SOLO INSERCION, con el mismo candado
-- que ordenes_eventos (migracion 020): despues de escrita, nadie la modifica ni la borra, salvo la
-- via de purga (SET LOCAL gomaq.purga = 'on') que usan las pruebas de escritura, la limpieza de
-- datos de prueba y los scripts de datos demo.
--
-- Solo agrega: no toca clientes ni ninguna otra tabla, asi que la instancia anterior sigue
-- funcionando mientras Railway reemplaza la version.

CREATE TABLE clientes_cambios (
    id BIGSERIAL PRIMARY KEY,
    -- sin ON DELETE CASCADE a proposito: borrar un cliente no debe llevarse su historial en silencio
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    rol TEXT NOT NULL,
    origen TEXT NOT NULL CHECK (origen IN ('portal')),
    -- { "campo": { "antes": ..., "despues": ... } }
    cambios JSONB NOT NULL,
    registrado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clientes_cambios_cliente ON clientes_cambios (cliente_id, registrado_en);
CREATE INDEX idx_clientes_cambios_usuario ON clientes_cambios (usuario_id);

CREATE FUNCTION clientes_cambios_solo_insercion() RETURNS trigger AS $$
BEGIN
    IF current_setting('gomaq.purga', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'clientes_cambios es de solo insercion: % no esta permitido', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clientes_cambios_sin_cambios
    BEFORE UPDATE OR DELETE ON clientes_cambios
    FOR EACH ROW EXECUTE FUNCTION clientes_cambios_solo_insercion();

CREATE TRIGGER clientes_cambios_sin_truncate
    BEFORE TRUNCATE ON clientes_cambios
    FOR EACH STATEMENT EXECUTE FUNCTION clientes_cambios_solo_insercion();

-- Igual que ordenes_eventos (migracion 041): el rol limitado de la API solo inserta y lee.
REVOKE UPDATE, DELETE ON clientes_cambios FROM gomaq_app;
