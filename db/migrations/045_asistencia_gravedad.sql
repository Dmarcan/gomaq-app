-- Gravedad de una asistencia pedida por el cliente y un estado intermedio del equipo.
--   * estado_maquinaria: 'parcialmente_operativa' (el equipo sigue en uso pero con una falla). Solo se agrega
--     el valor: esta migracion no lo usa (un valor nuevo de enum no se puede usar en la transaccion que lo crea).
--   * solicitudes.gravedad: lo que el cliente declara al pedir asistencia. Las anteriores quedan en 'sigue_operando'.
--   * solicitudes_detalle: detalles que el cliente agrega a una asistencia ya abierta (en vez de abrir otra).
-- Solo agrega: el worker y la API anterior siguen funcionando con este esquema.

ALTER TYPE estado_maquinaria ADD VALUE IF NOT EXISTS 'parcialmente_operativa';

ALTER TABLE solicitudes
    ADD COLUMN IF NOT EXISTS gravedad VARCHAR(20) NOT NULL DEFAULT 'sigue_operando'
    CHECK (gravedad IN ('sigue_operando', 'parcial', 'fuera_de_servicio'));

CREATE TABLE IF NOT EXISTS solicitudes_detalle (
    id SERIAL PRIMARY KEY,
    solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    gravedad VARCHAR(20) NOT NULL CHECK (gravedad IN ('sigue_operando', 'parcial', 'fuera_de_servicio')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_solicitudes_detalle_solicitud ON solicitudes_detalle (solicitud_id);
