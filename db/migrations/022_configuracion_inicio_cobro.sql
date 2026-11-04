-- Migracion 022: configuracion del cobro de arriendos e inicio de cobro en la guia de despacho.
--
-- Tabla `configuracion` (clave/valor) con tres reglas que hoy estaban fijas en el codigo:
--   dia_facturacion       dia del mes en que cierra el periodo (1 a 28), 5 por defecto
--   hora_corte_despacho   hora (0 a 23) desde la cual el dia del despacho ya no cuenta, 13 por defecto
--   incluir_dia_recepcion si el dia de la recepcion cuenta como dia de arriendo, true por defecto
--
-- `guias.inicio_cobro` guarda el primer dia que se cobra, calculado al crear el despacho con la
-- hora de corte vigente, para que cambiar la configuracion no reescriba el pasado. Lo fija un
-- trigger BEFORE INSERT: cubre la version anterior del servidor corriendo un momento durante el
-- despliegue y los INSERT directos. Las guias existentes se rellenan con la regla historica (13 h).
--
-- Solo agrega: la version anterior del servidor no lee ni escribe nada de esto.
-- Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor JSONB NOT NULL,
    actualizado_por INTEGER REFERENCES usuarios(id),
    actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT configuracion_valor_valido CHECK (CASE clave
        WHEN 'dia_facturacion' THEN CASE WHEN jsonb_typeof(valor) = 'number'
            THEN valor::numeric BETWEEN 1 AND 28 AND valor::numeric = trunc(valor::numeric) ELSE false END
        WHEN 'hora_corte_despacho' THEN CASE WHEN jsonb_typeof(valor) = 'number'
            THEN valor::numeric BETWEEN 0 AND 23 AND valor::numeric = trunc(valor::numeric) ELSE false END
        WHEN 'incluir_dia_recepcion' THEN jsonb_typeof(valor) = 'boolean'
        ELSE true END)
);

INSERT INTO configuracion (clave, valor) VALUES
    ('dia_facturacion', '5'), ('hora_corte_despacho', '13'), ('incluir_dia_recepcion', 'true')
ON CONFLICT (clave) DO NOTHING;

ALTER TABLE guias ADD COLUMN IF NOT EXISTS inicio_cobro DATE;

CREATE OR REPLACE FUNCTION gomaq_inicio_cobro(p_fecha timestamptz, p_hora_corte integer)
RETURNS date LANGUAGE sql STABLE AS $$
    SELECT (p_fecha AT TIME ZONE 'America/Santiago')::date
         + CASE WHEN extract(hour FROM p_fecha AT TIME ZONE 'America/Santiago') >= p_hora_corte THEN 1 ELSE 0 END
$$;

UPDATE guias SET inicio_cobro = gomaq_inicio_cobro(fecha, 13)
WHERE tipo = 'despacho' AND inicio_cobro IS NULL;

CREATE OR REPLACE FUNCTION guias_fijar_inicio_cobro() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE hora integer;
BEGIN
    IF NEW.tipo = 'despacho' AND NEW.inicio_cobro IS NULL THEN
        SELECT CASE WHEN jsonb_typeof(valor) = 'number' THEN valor::integer END INTO hora
        FROM configuracion WHERE clave = 'hora_corte_despacho';
        NEW.inicio_cobro := gomaq_inicio_cobro(NEW.fecha, COALESCE(hora, 13));
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guias_inicio_cobro ON guias;
CREATE TRIGGER guias_inicio_cobro BEFORE INSERT ON guias
    FOR EACH ROW EXECUTE FUNCTION guias_fijar_inicio_cobro();
