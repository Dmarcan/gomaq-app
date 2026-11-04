-- Migracion 023: la factura de arriendo guarda su despacho, su periodo y su cliente.
--
-- Hasta ahora una factura de arriendo solo colgaba de la guia de recepcion: no se podia facturar
-- por periodos (corte mensual) ni saber a que cliente pertenecia sin pasar por la guia. Se agregan:
--   guia_despacho_id   el despacho (arriendo) que se factura
--   periodo_desde/hasta dias del arriendo que cubre la factura (ambos inclusive)
--   cliente_id         el cliente facturado (de la OT, o del despacho en un arriendo)
-- Todas nulables y sin CHECK estricto: las facturas de reparacion no llevan despacho ni periodo.
--
-- Relleno: cada factura de arriendo existente toma el despacho y el periodo que /pendientes ya le
-- calculaba (ultimo despacho anterior a la recepcion, desde su inicio de cobro hasta el dia de la
-- recepcion), con la zona America/Santiago explicita en la base. Si varias facturas apuntan al
-- mismo despacho (recepcion repetida), solo la primera recibe despacho y periodo; las demas quedan
-- en NULL y el indice unico no las toca.
--
-- Un trigger BEFORE INSERT completa esos campos para la version anterior del servidor, que sigue
-- insertando facturas con solo la recepcion un momento durante el despliegue.
--
-- Solo agrega, y se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE facturas
    ADD COLUMN IF NOT EXISTS guia_despacho_id INTEGER REFERENCES guias(id),
    ADD COLUMN IF NOT EXISTS periodo_desde DATE,
    ADD COLUMN IF NOT EXISTS periodo_hasta DATE,
    ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES clientes(id);

-- despacho, periodo y cliente de una recepcion, con la misma regla que /pendientes
-- p_incluir_recepcion NULL = configuracion vigente; el relleno pasa true: la 022 y /pendientes cobraban
-- el dia de la recepcion, asi que las facturas historicas se calcularon con esa regla.
CREATE OR REPLACE FUNCTION gomaq_periodo_de_recepcion(p_recepcion integer, p_incluir_recepcion boolean DEFAULT NULL)
RETURNS TABLE(despacho_id integer, desde date, hasta date, cliente_id integer)
LANGUAGE sql STABLE AS $$
    SELECT d.id,
           COALESCE(d.inicio_cobro, gomaq_inicio_cobro(d.fecha, 13)),
           (r.fecha AT TIME ZONE 'America/Santiago')::date
             - CASE WHEN COALESCE(p_incluir_recepcion,
                                  (SELECT (valor)::text::boolean FROM configuracion
                                   WHERE clave = 'incluir_dia_recepcion' AND jsonb_typeof(valor) = 'boolean'), true)
                    THEN 0 ELSE 1 END,
           COALESCE(r.cliente_id, d.cliente_id)
    FROM guias r
    JOIN LATERAL (
        SELECT * FROM guias d2
        WHERE d2.maquinaria_id = r.maquinaria_id AND d2.tipo = 'despacho'
          AND d2.fallido = false AND d2.fecha <= r.fecha
        ORDER BY d2.fecha DESC, d2.id DESC LIMIT 1
    ) d ON true
    WHERE r.id = p_recepcion AND r.tipo = 'recepcion' AND r.fallido = false
$$;

UPDATE facturas f SET cliente_id = ot.cliente_id
FROM ordenes_trabajo ot
WHERE f.cliente_id IS NULL AND ot.id = f.orden_trabajo_id AND ot.cliente_id IS NOT NULL;

WITH candidatas AS (
    SELECT f.id, p.despacho_id, p.desde, p.hasta, p.cliente_id AS cliente_guia,
           row_number() OVER (PARTITION BY p.despacho_id ORDER BY r.fecha, r.id, f.id) AS n
    FROM facturas f
    JOIN guias r ON r.id = f.guia_recepcion_id
    CROSS JOIN LATERAL gomaq_periodo_de_recepcion(f.guia_recepcion_id, true) p
    WHERE f.guia_recepcion_id IS NOT NULL AND f.guia_despacho_id IS NULL
)
UPDATE facturas f SET
    guia_despacho_id = c.despacho_id,
    -- un arriendo de 0 dias (recepcion el mismo dia que el despacho, ya pasado el corte) no tiene periodo
    periodo_desde = CASE WHEN c.hasta >= c.desde THEN c.desde END,
    periodo_hasta = CASE WHEN c.hasta >= c.desde THEN c.hasta END,
    cliente_id = COALESCE(f.cliente_id, c.cliente_guia)
FROM candidatas c
WHERE f.id = c.id AND c.n = 1
  AND NOT EXISTS (SELECT 1 FROM facturas o WHERE o.guia_despacho_id = c.despacho_id AND o.id <> f.id);

-- facturas de arriendo sin despacho (recepcion sin despacho anterior): al menos el cliente
UPDATE facturas f SET cliente_id = g.cliente_id
FROM guias g
WHERE f.cliente_id IS NULL AND g.id = f.guia_recepcion_id AND g.cliente_id IS NOT NULL;

DO $$
DECLARE sin_despacho integer;
BEGIN
    SELECT count(*) INTO sin_despacho FROM facturas
    WHERE guia_recepcion_id IS NOT NULL AND guia_despacho_id IS NULL;
    IF sin_despacho > 0 THEN
        RAISE NOTICE 'Migracion 023: % factura(s) de arriendo quedaron sin despacho (recepcion repetida o sin despacho anterior)', sin_despacho;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_facturas_guia_despacho ON facturas (guia_despacho_id);

CREATE UNIQUE INDEX IF NOT EXISTS facturas_despacho_periodo_unico
    ON facturas (guia_despacho_id, periodo_desde)
    WHERE guia_despacho_id IS NOT NULL AND periodo_desde IS NOT NULL;

-- Completa los campos nuevos al insertar sin ellos (version anterior del servidor)
CREATE OR REPLACE FUNCTION facturas_completar_arriendo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
    IF NEW.cliente_id IS NULL AND NEW.orden_trabajo_id IS NOT NULL THEN
        SELECT ot.cliente_id INTO NEW.cliente_id FROM ordenes_trabajo ot WHERE ot.id = NEW.orden_trabajo_id;
    END IF;
    IF NEW.guia_recepcion_id IS NOT NULL AND NEW.guia_despacho_id IS NULL THEN
        SELECT * INTO p FROM gomaq_periodo_de_recepcion(NEW.guia_recepcion_id);
        IF FOUND THEN
            IF NEW.cliente_id IS NULL THEN NEW.cliente_id := p.cliente_id; END IF;
            -- candado por despacho: dos facturas simultaneas del mismo despacho no deben verse como
            -- inexistentes una a la otra (el segundo INSERT veria 23505 sin merecerlo)
            PERFORM pg_advisory_xact_lock(70215, p.despacho_id);
            -- solo si ese despacho no tiene ya otra factura: el indice unico no debe frenar al servidor antiguo
            IF NOT EXISTS (SELECT 1 FROM facturas o WHERE o.guia_despacho_id = p.despacho_id) THEN
                NEW.guia_despacho_id := p.despacho_id;
                IF p.hasta >= p.desde THEN
                    NEW.periodo_desde := p.desde;
                    NEW.periodo_hasta := p.hasta;
                END IF;
            END IF;
        ELSIF NEW.cliente_id IS NULL THEN
            -- recepcion sin despacho anterior: al menos el cliente de la propia guia
            SELECT g.cliente_id INTO NEW.cliente_id FROM guias g WHERE g.id = NEW.guia_recepcion_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS facturas_completar ON facturas;
CREATE TRIGGER facturas_completar BEFORE INSERT ON facturas
    FOR EACH ROW EXECUTE FUNCTION facturas_completar_arriendo();
