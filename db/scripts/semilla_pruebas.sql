-- Semilla minima para el entorno local de pruebas.
--
-- Crea lo que la bateria extremo a extremo necesita y nada mas: las cuentas de los cuatro
-- perfiles, un cliente, dos equipos y una orden de trabajo por cada mecanico. El caso que
-- verifica la pertenencia del recurso exige que el segundo mecanico tenga al menos una orden
-- asignada; sin eso, ese caso se omite.
--
-- Es idempotente: puede ejecutarse varias veces sobre la misma base sin duplicar nada.
--
-- La contrasena de todas las cuentas es la documentada en el README para el entorno de
-- desarrollo. Este archivo NO debe usarse contra una base de produccion.

INSERT INTO clientes (nombre, rut, email, telefono)
SELECT 'Acsa International', '76.123.456-7', 'contacto@acsa.test', '+56911111111'
WHERE NOT EXISTS (SELECT 1 FROM clientes WHERE nombre = 'Acsa International');

INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta, cliente_id) VALUES
  ('Admin Prueba',          'admin@gomaq.test',          '$2a$10$VXEk0pRcT/GPNFOujJkWF.mXJS/bPTml1pki3T0EhFAGogj0Hf1g2', 'gerente',        'activo', NULL),
  ('Administrativo Prueba', 'administrativo@gomaq.test', '$2a$10$VXEk0pRcT/GPNFOujJkWF.mXJS/bPTml1pki3T0EhFAGogj0Hf1g2', 'administrativo', 'activo', NULL),
  ('Mecanico Prueba',       'mecanico@gomaq.test',       '$2a$10$VXEk0pRcT/GPNFOujJkWF.mXJS/bPTml1pki3T0EhFAGogj0Hf1g2', 'mecanico',       'activo', NULL),
  ('Mecanico Dos',          'mecanico2@gomaq.test',      '$2a$10$VXEk0pRcT/GPNFOujJkWF.mXJS/bPTml1pki3T0EhFAGogj0Hf1g2', 'mecanico',       'activo', NULL),
  ('Cliente Prueba',        'cliente@gomaq.test',        '$2a$10$VXEk0pRcT/GPNFOujJkWF.mXJS/bPTml1pki3T0EhFAGogj0Hf1g2', 'cliente',        'activo',
     (SELECT id FROM clientes WHERE nombre = 'Acsa International'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO maquinarias (codigo, tipo, cliente_id, estado) VALUES
  ('GH-999', 'Grua Horquilla',        (SELECT id FROM clientes WHERE nombre = 'Acsa International'), 'operativa'),
  ('GH-204', 'Grua Horquilla Toyota', (SELECT id FROM clientes WHERE nombre = 'Acsa International'), 'operativa')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, motivo, estado)
SELECT (SELECT id FROM maquinarias WHERE codigo = 'GH-999'),
       (SELECT id FROM clientes WHERE nombre = 'Acsa International'),
       (SELECT id FROM usuarios WHERE email = 'mecanico@gomaq.test'),
       'Mantencion preventiva programada', 'asignada'
WHERE NOT EXISTS (
    SELECT 1 FROM ordenes_trabajo
    WHERE mecanico_id = (SELECT id FROM usuarios WHERE email = 'mecanico@gomaq.test'));

INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, motivo, estado)
SELECT (SELECT id FROM maquinarias WHERE codigo = 'GH-204'),
       (SELECT id FROM clientes WHERE nombre = 'Acsa International'),
       (SELECT id FROM usuarios WHERE email = 'mecanico2@gomaq.test'),
       'Falla hidraulica reportada por el cliente', 'asignada'
WHERE NOT EXISTS (
    SELECT 1 FROM ordenes_trabajo
    WHERE mecanico_id = (SELECT id FROM usuarios WHERE email = 'mecanico2@gomaq.test'));
