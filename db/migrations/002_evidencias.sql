-- Migracion 002: tabla de evidencias fotograficas subidas por el mecanico (Supabase Storage)

CREATE TABLE evidencias_fotograficas (
    id SERIAL PRIMARY KEY,
    orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
    path TEXT NOT NULL, -- ruta dentro del bucket privado de Supabase Storage (no una URL publica)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidencias_orden ON evidencias_fotograficas(orden_trabajo_id);

-- columna para backoff exponencial del worker de notificaciones (informe 6.4.3)
ALTER TABLE notificaciones_pendientes ADD COLUMN proximo_intento TIMESTAMPTZ NOT NULL DEFAULT now();
