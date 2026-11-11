-- Migracion 034: codigos de un solo uso para la cuenta (recuperar la contrasena e invitar cuentas internas).
--
-- Un codigo de 6 digitos amarrado a un correo. Se guarda solo su HMAC (utils/codigosCuenta.js): ni la
-- base ni el administrador pueden volver a leerlo. Vence, tiene un tope de intentos y se usa una vez.
-- Al generar uno nuevo para la misma cuenta y proposito, los anteriores se revocan.
--
-- - recuperar_password: "Olvide mi contrasena" (por correo) o "Restablecer" del administrador (por correo
--   o por un mensaje que copia y manda a mano, para quien no tiene un correo real).
-- - invitacion: cuenta interna creada en estado 'pendiente' (sin clave conocida); la persona elige su clave.
-- - verificar_correo: reservado para verificar el correo del cliente al registrarse (aun sin uso).
--
-- No pasa por notificaciones_pendientes: GET /api/notificaciones muestra el payload al administrativo.
--
-- Solo AGREGA una tabla: el servidor anterior la ignora y puede correr un momento con este esquema.
-- Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS codigos_cuenta (
    id SERIAL PRIMARY KEY,
    proposito VARCHAR(30) NOT NULL
        CHECK (proposito IN ('recuperar_password', 'invitacion', 'verificar_correo')),
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    solicitud_cliente_id INTEGER REFERENCES solicitudes_cliente(id) ON DELETE CASCADE,
    -- correo al que queda amarrado (en minusculas): si la cuenta cambia de correo, el codigo deja de servir
    email VARCHAR(150) NOT NULL,
    codigo_hmac CHAR(64) NOT NULL,
    intentos SMALLINT NOT NULL DEFAULT 0,
    expira_at TIMESTAMPTZ NOT NULL,
    usado_at TIMESTAMPTZ,
    revocado_at TIMESTAMPTZ,
    canal VARCHAR(10) NOT NULL CHECK (canal IN ('correo', 'manual')),
    creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    enviado_at TIMESTAMPTZ,
    error_envio TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT codigos_cuenta_un_destino_chk CHECK ((usuario_id IS NULL) <> (solicitud_cliente_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_codigos_cuenta_vigentes
    ON codigos_cuenta (lower(email), proposito)
    WHERE usado_at IS NULL AND revocado_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_codigos_cuenta_usuario ON codigos_cuenta (usuario_id);
