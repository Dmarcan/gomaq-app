-- Migracion 036: sesiones revocables guardadas en la base.
--
-- El login entrega un token opaco ("gs1_" + 32 bytes aleatorios). La base guarda solo su SHA-256: el
-- token tiene entropia de sobra, no hace falta un HMAC. Una sesion deja de valer al revocarla (cerrar
-- sesion, cambiar o restablecer la clave, desactivar la cuenta), al cumplirse su vencimiento absoluto o
-- tras un tiempo sin usarse (inactividad_min).
--
-- Los tokens firmados (JWT de 12 h) que ya estan en los telefonos y navegadores siguen funcionando hasta
-- que venzan: verifyToken acepta ambos. Los clientes antiguos guardan y reenvian el token como un texto
-- opaco, asi que no hace falta cambiarlos.
--
-- Solo AGREGA una tabla: el servidor anterior la ignora. Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS sesiones (
    id BIGSERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    app VARCHAR(10) NOT NULL DEFAULT 'otro' CHECK (app IN ('panel', 'terreno', 'otro')),
    creada_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ultimo_uso_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expira_at TIMESTAMPTZ NOT NULL,
    inactividad_min INTEGER NOT NULL,
    revocada_at TIMESTAMPTZ,
    motivo VARCHAR(30),
    user_agent VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_sesiones_usuario_activas ON sesiones (usuario_id) WHERE revocada_at IS NULL;
