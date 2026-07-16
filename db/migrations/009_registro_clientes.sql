-- Migracion 009: registro propio de clientes con aprobacion de Administrativo/Gerente
-- El cliente se registra solo (email + contrasena) y queda "pendiente" hasta que un
-- admin lo revise, lo vincule a un cliente existente o cree uno nuevo, y lo active.

CREATE TYPE estado_cuenta_usuario AS ENUM ('pendiente', 'activo', 'rechazado');

-- default 'activo' para no afectar las cuentas ya existentes; las nuevas de
-- auto-registro se crean explicitamente en 'pendiente' cuando se aprueban
ALTER TABLE usuarios ADD COLUMN estado_cuenta estado_cuenta_usuario NOT NULL DEFAULT 'activo';

ALTER TABLE clientes ADD COLUMN horario_trabajo VARCHAR(100);
ALTER TABLE clientes ADD COLUMN horario_colacion VARCHAR(100);
ALTER TABLE clientes ADD COLUMN direccion TEXT;

-- postulacion de cuenta enviada por el cliente, separada de "solicitudes" (que es para
-- pedir servicio a un equipo, un concepto distinto) - nunca crea usuarios/clientes
-- directamente, solo queda disponible para que un admin la revise y decida
CREATE TABLE solicitudes_cliente (
    id SERIAL PRIMARY KEY,
    nombre_contacto VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    rut_empresa VARCHAR(20),
    telefono_whatsapp VARCHAR(30),
    horario_trabajo VARCHAR(100),
    horario_colacion VARCHAR(100),
    direccion TEXT,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    cliente_id INTEGER REFERENCES clientes(id),
    usuario_id INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_solicitudes_cliente_estado ON solicitudes_cliente(estado);
