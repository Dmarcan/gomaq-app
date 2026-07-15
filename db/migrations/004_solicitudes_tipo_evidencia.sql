-- Migracion 004: tipo de solicitud (falla | mantencion preventiva) y evidencia fotografica opcional

CREATE TYPE tipo_solicitud AS ENUM ('falla', 'mantencion_preventiva');

ALTER TABLE solicitudes ADD COLUMN tipo tipo_solicitud NOT NULL DEFAULT 'falla';
ALTER TABLE solicitudes ADD COLUMN evidencia_url TEXT;
