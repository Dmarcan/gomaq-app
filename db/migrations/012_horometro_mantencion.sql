-- Migracion 012: horometro por equipo y mantencion preventiva
-- (entrevista el jefe de taller/la administrativa del 20-21 julio 2026, punto 6: hoy el horometro se lleva a mano
-- en Excel por grua, cliente y mes, para calcular cuando toca la preventiva de las 350 h)

CREATE TYPE origen_lectura_horometro AS ENUM ('movil', 'panel', 'guia');

CREATE TABLE lecturas_horometro (
    id SERIAL PRIMARY KEY,
    maquinaria_id INTEGER NOT NULL REFERENCES maquinarias(id),
    valor NUMERIC(10,1) NOT NULL CHECK (valor >= 0),
    -- de donde vino la lectura: la app del mecanico en terreno, el panel del administrativo,
    -- o la deteccion automatica del PDF de la guia de entrega (trae "HOROMETRO: 1156")
    origen origen_lectura_horometro NOT NULL,
    -- snapshot del cliente que tenia el equipo cuando se tomo la lectura. Permite el historial
    -- "donde estuvo y cuanto se uso en cada lugar" que pidio el jefe de taller, sin depender de
    -- maquinarias.cliente_id, que se pone en NULL al recibir el equipo de vuelta
    cliente_id INTEGER REFERENCES clientes(id),
    orden_trabajo_id INTEGER REFERENCES ordenes_trabajo(id),
    guia_id INTEGER REFERENCES guias(id),
    usuario_id INTEGER REFERENCES usuarios(id),
    observacion TEXT,
    fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lecturas_horometro_maquinaria ON lecturas_horometro(maquinaria_id, fecha DESC);

-- 350 h es el intervalo que GOMAQ usa hoy para toda la flota (entrevista el jefe de taller, punto 4).
-- Se guarda por equipo y no como constante para poder ajustarlo a uno solo sin migrar.
ALTER TABLE maquinarias ADD COLUMN intervalo_mantencion_horas NUMERIC(10,1) NOT NULL DEFAULT 350;

-- horometro en que se hizo la ultima preventiva: la base desde la que se cuenta el intervalo
-- siguiente. NULL = nunca se registro una, se cuenta desde 0.
ALTER TABLE maquinarias ADD COLUMN horometro_ultima_mantencion NUMERIC(10,1);

-- el aviso de mantencion se manda una sola vez por ciclo: esta marca se enciende al encolarlo
-- y se apaga al reiniciar el contador. Sin esto, cada lectura nueva sobre el umbral volveria
-- a encolar el mismo mensaje.
ALTER TABLE maquinarias ADD COLUMN alerta_mantencion_enviada BOOLEAN NOT NULL DEFAULT false;

-- destinatarios del aviso de mantencion, configurables desde el panel (no por .env, para que
-- no haya que entrar por SSH cuando cambie quien lo recibe)
ALTER TABLE usuarios ADD COLUMN recibe_alertas_mantencion BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN telefono_whatsapp VARCHAR(30);
