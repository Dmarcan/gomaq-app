-- Migracion 003: solicitudes de asistencia generadas por el cliente desde el portal.
-- El administrativo las revisa y, si corresponde, crea la Orden de Trabajo real
-- (informe seccion 6.2, flujo: "Cliente reporta falla -> Administrativo crea la OT").

CREATE TYPE estado_solicitud AS ENUM ('pendiente', 'convertida', 'rechazada');

CREATE TABLE solicitudes (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    maquinaria_id INTEGER NOT NULL REFERENCES maquinarias(id),
    descripcion TEXT NOT NULL,
    estado estado_solicitud NOT NULL DEFAULT 'pendiente',
    orden_trabajo_id INTEGER REFERENCES ordenes_trabajo(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_solicitudes_estado ON solicitudes(estado);

-- vincula un usuario con rol 'cliente' a la empresa (tabla clientes) que representa,
-- para poder filtrar "su" flota y sus solicitudes en el portal
ALTER TABLE usuarios ADD COLUMN cliente_id INTEGER REFERENCES clientes(id);
