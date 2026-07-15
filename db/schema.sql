-- GOMAQ: Sistema de Gestión y Comunicación Centralizado
-- Esquema inicial de base de datos (PostgreSQL)

CREATE TYPE rol_usuario AS ENUM ('gerente', 'administrativo', 'mecanico', 'cliente');
CREATE TYPE estado_maquinaria AS ENUM ('operativa', 'en_mantencion', 'fuera_de_servicio');
CREATE TYPE estado_orden AS ENUM ('pendiente', 'asignada', 'en_terreno', 'en_reparacion', 'finalizada');
CREATE TYPE origen_orden AS ENUM ('directo', 'externo');
CREATE TYPE tipo_guia AS ENUM ('despacho', 'recepcion');
CREATE TYPE estado_notificacion AS ENUM ('pendiente', 'enviado', 'error');

CREATE TABLE usuarios (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    rol rol_usuario NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clientes (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    rut VARCHAR(20),
    email VARCHAR(150),
    telefono VARCHAR(30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maquinarias (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(20) UNIQUE NOT NULL,
    tipo VARCHAR(100) NOT NULL,
    cliente_id INTEGER REFERENCES clientes(id),
    estado estado_maquinaria NOT NULL DEFAULT 'operativa',
    ubicacion VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ordenes_trabajo (
    id SERIAL PRIMARY KEY,
    maquinaria_id INTEGER NOT NULL REFERENCES maquinarias(id),
    cliente_id INTEGER REFERENCES clientes(id),
    mecanico_id INTEGER REFERENCES usuarios(id),
    origen origen_orden NOT NULL DEFAULT 'directo',
    motivo TEXT,
    diagnostico TEXT,
    estado estado_orden NOT NULL DEFAULT 'pendiente',
    facturable BOOLEAN NOT NULL DEFAULT false,
    valorizacion NUMERIC(12,2),
    valorizacion_aprobada_por INTEGER REFERENCES usuarios(id),
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_cierre TIMESTAMPTZ
);

CREATE TABLE guias (
    id SERIAL PRIMARY KEY,
    maquinaria_id INTEGER NOT NULL REFERENCES maquinarias(id),
    tipo tipo_guia NOT NULL,
    archivo_url TEXT NOT NULL,
    fecha DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE facturas (
    id SERIAL PRIMARY KEY,
    orden_trabajo_id INTEGER REFERENCES ordenes_trabajo(id),
    folio VARCHAR(50) NOT NULL,
    archivo_url TEXT NOT NULL,
    monto NUMERIC(12,2),
    fecha_emision DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Patron Outbox para notificaciones (WhatsApp / correo) desacopladas de la transaccion principal
CREATE TABLE notificaciones_pendientes (
    id SERIAL PRIMARY KEY,
    canal VARCHAR(20) NOT NULL, -- whatsapp | email
    destinatario VARCHAR(150) NOT NULL,
    payload JSONB NOT NULL,
    estado estado_notificacion NOT NULL DEFAULT 'pendiente',
    intentos INTEGER NOT NULL DEFAULT 0,
    ultimo_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    enviado_at TIMESTAMPTZ
);

CREATE INDEX idx_ordenes_estado ON ordenes_trabajo(estado);
CREATE INDEX idx_maquinarias_estado ON maquinarias(estado);
CREATE INDEX idx_notificaciones_estado ON notificaciones_pendientes(estado);
