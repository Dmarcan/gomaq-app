-- Migracion 028: el ultimo dia de un arriendo se decide con la hora de corte, guardado en la guia.
--
-- Regla (del dueño del proyecto, 5 de noviembre de 2026): el equipo que sale del cliente (recepcion, o despacho del
-- mismo equipo a otro cliente) cobra ese dia solo si sale desde la hora de corte (hora_corte_despacho,
-- 13 por defecto); si sale antes, el ultimo dia cobrado es el anterior. Es la contraparte de la regla
-- del despacho, de modo que el dia de un cambio de cliente se cobra a uno solo. La opcion
-- `incluir_dia_recepcion` queda obsoleta: el codigo ya no la lee.
--
-- Igual que guias.inicio_cobro (migracion 022), el ultimo dia se GUARDA al registrar la guia con la hora
-- de corte vigente en ese momento, para que cambiar la configuracion no reescriba el pasado ni deje
-- huecos o dias cobrados dos veces:
--   guias.fin_cobro  ultimo dia que se cobra al cliente de la recepcion (solo en tipo 'recepcion')
-- El cierre de un arriendo por un despacho siguiente (cambio de cliente) no necesita columna: su
-- ultimo dia es el dia anterior al inicio_cobro guardado del despacho siguiente.
--
-- Relleno: las recepciones EXISTENTES reciben el fin con la regla con la que se facturaron (el dia de
-- la recepcion en Santiago, menos uno si configuracion.incluir_dia_recepcion estaba en false; true por
-- defecto). Asi la regla nueva rige solo hacia adelante y ninguna factura ya emitida cambia.
--
-- Un trigger BEFORE INSERT fija fin_cobro de las recepciones nuevas, tambien las que inserte la version
-- anterior del servidor durante el despliegue.
--
-- gomaq_periodo_de_recepcion (migracion 023, la usa el trigger facturas_completar) pasa a leer
-- guias.fin_cobro. Misma firma y retorno. Con el segundo argumento explicito (el relleno de la 023,
-- que pasa true) conserva la regla historica, para que volver a correrla no cambie lo ya rellenado.
-- NO reescribe facturas existentes. Solo agrega; se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE guias ADD COLUMN IF NOT EXISTS fin_cobro DATE;

-- ultimo dia que se cobra para una salida del equipo en `p_fecha`, con la hora de corte dada
CREATE OR REPLACE FUNCTION gomaq_fin_cobro(p_fecha timestamptz, p_hora_corte integer)
RETURNS date LANGUAGE sql STABLE AS $$
    SELECT (p_fecha AT TIME ZONE 'America/Santiago')::date
         - CASE WHEN extract(hour FROM p_fecha AT TIME ZONE 'America/Santiago') >= p_hora_corte THEN 0 ELSE 1 END
$$;

-- relleno con la regla historica (incluir_dia_recepcion, true por defecto)
UPDATE guias g SET fin_cobro =
    (g.fecha AT TIME ZONE 'America/Santiago')::date
    - CASE WHEN COALESCE((SELECT (valor)::text::boolean FROM configuracion
                          WHERE clave = 'incluir_dia_recepcion' AND jsonb_typeof(valor) = 'boolean'), true)
           THEN 0 ELSE 1 END
WHERE g.tipo = 'recepcion' AND g.fin_cobro IS NULL;

CREATE OR REPLACE FUNCTION guias_fijar_fin_cobro() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE hora integer;
BEGIN
    IF NEW.tipo = 'recepcion' AND NEW.fin_cobro IS NULL THEN
        SELECT CASE WHEN jsonb_typeof(valor) = 'number' THEN valor::integer END INTO hora
        FROM configuracion WHERE clave = 'hora_corte_despacho';
        NEW.fin_cobro := gomaq_fin_cobro(NEW.fecha, COALESCE(hora, 13));
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guias_fin_cobro ON guias;
CREATE TRIGGER guias_fin_cobro BEFORE INSERT ON guias
    FOR EACH ROW EXECUTE FUNCTION guias_fijar_fin_cobro();

CREATE OR REPLACE FUNCTION gomaq_periodo_de_recepcion(p_recepcion integer, p_incluir_recepcion boolean DEFAULT NULL)
RETURNS TABLE(despacho_id integer, desde date, hasta date, cliente_id integer)
LANGUAGE sql STABLE AS $$
    SELECT d.id,
           COALESCE(d.inicio_cobro, gomaq_inicio_cobro(d.fecha, 13)),
           CASE
             WHEN p_incluir_recepcion IS NOT NULL
                 THEN (r.fecha AT TIME ZONE 'America/Santiago')::date - CASE WHEN p_incluir_recepcion THEN 0 ELSE 1 END
             ELSE COALESCE(r.fin_cobro, gomaq_fin_cobro(r.fecha, COALESCE(
                      (SELECT (valor)::text::integer FROM configuracion
                       WHERE clave = 'hora_corte_despacho' AND jsonb_typeof(valor) = 'number'), 13)))
           END,
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
