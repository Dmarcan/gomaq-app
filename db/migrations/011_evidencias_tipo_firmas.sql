-- Migracion 011: tipo de evidencia (antes/despues) + firma de recepcion al cerrar la OT
-- Rediseño de la app movil (proyecto Stitch): las fotos se separan en "antes de la
-- intervencion" y "despues", y el cierre de la OT registra quien recibio el equipo
-- con su firma digital (respalda el cobro ante disputas del cliente).

-- Las fotos historicas no distinguian momento: 'antes' es el default conservador.
ALTER TABLE evidencias_fotograficas
    ADD COLUMN tipo TEXT NOT NULL DEFAULT 'antes' CHECK (tipo IN ('antes', 'despues'));

-- Una firma por OT (UNIQUE); firma_path apunta al PNG en el bucket privado evidencias-ot.
-- sin_persona = true cuando no habia nadie disponible para recibir el trabajo.
CREATE TABLE firmas_recepcion (
    id                SERIAL PRIMARY KEY,
    orden_trabajo_id  INTEGER NOT NULL UNIQUE REFERENCES ordenes_trabajo(id),
    persona_recibe    TEXT,
    sin_persona       BOOLEAN NOT NULL DEFAULT false,
    firma_path        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
