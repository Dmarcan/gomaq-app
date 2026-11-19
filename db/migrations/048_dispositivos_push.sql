-- Dispositivos registrados para recibir avisos push (FCM). Un dispositivo es un token de Firebase de una
-- app (terreno o panel) ligado al usuario y a la sesion con que se registro.
--
-- * token UNIQUE: si el mismo telefono cambia de usuario, el registro se reasigna (upsert por token).
-- * sesion_id puede ser NULL: las sesiones antiguas (JWT firmado de 12 h) no tienen fila en sesiones.
--   Con sesion, al cerrar sesion (o borrar la sesion) el dispositivo deja de recibir avisos.
-- * Sin ON DELETE CASCADE hacia notificaciones_pendientes: esa tabla guarda el id del dispositivo como texto
--   en `destinatario`; el worker cancela el aviso si el dispositivo ya no esta activo.
--
-- Solo agrega una tabla: la instancia anterior la ignora. El rol gomaq_app recibe los permisos por los
-- privilegios por defecto de la migracion 041 (necesita UPDATE y DELETE, no se revoca nada).

CREATE TABLE dispositivos_push (
    id BIGSERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    sesion_id BIGINT REFERENCES sesiones(id) ON DELETE CASCADE,
    plataforma VARCHAR(10) NOT NULL CHECK (plataforma IN ('android', 'web')),
    app VARCHAR(10) NOT NULL CHECK (app IN ('terreno', 'panel')),
    token TEXT NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 20 AND 4096),
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ultimo_uso_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dispositivos_push_usuario ON dispositivos_push (usuario_id) WHERE activo;
CREATE INDEX idx_dispositivos_push_sesion ON dispositivos_push (sesion_id) WHERE sesion_id IS NOT NULL;
