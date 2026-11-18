-- Fixture de datos para probar migraciones contra filas ya existentes.
--
-- VERSION BASE: 042 (la ultima migracion que existia cuando se escribio este archivo).
--
-- Lo usa backend/scripts/probar_migraciones_con_datos.js: crea una base vacia, aplica el esquema
-- y las migraciones hasta la version base (migrar.js --hasta 042), carga este archivo y despues
-- aplica las migraciones posteriores a la base. Si una de ellas rompe con filas existentes (una
-- columna NOT NULL sin default, una restriccion que las filas ya violan, un cast que falla), el
-- CI falla aca y no en el despliegue a produccion.
--
-- Este archivo es valido SOLO para el esquema de la version base. No hay que editarlo cuando se
-- agrega una migracion nueva: justamente la gracia es que la migracion nueva se aplique sobre
-- estas filas.
--
-- COMO SUBIR LA BASE: cuando se acumulen varias migraciones nuevas sobre la 042, se sube la base:
--   1. Cambiar VERSION_BASE en backend/scripts/probar_migraciones_con_datos.js a la ultima
--      migracion existente (por ejemplo 047).
--   2. Regenerar este archivo para el esquema de esa version (agregar las columnas nuevas
--      NOT NULL, quitar las que se borraron) y cambiar el numero de la linea VERSION BASE de arriba.
--   3. Correr el script en local y confirmar que pasa.
--
-- Determinista y sin datos reales: todo es inventado (dominios .test, RUT de ejemplo, hashes de
-- relleno que no corresponden a ninguna clave). No usar contra una base real.

INSERT INTO ejecutivos (nombre) VALUES ('Ejecutivo Fixture');

INSERT INTO clientes (nombre, rut, email, telefono, ejecutivo_id, direccion, latitud, longitud, giro, plazo_pago_dias) VALUES
  ('Cliente Fixture Uno', '76.000.001-1', 'uno@fixture.test', '+56900000001',
     (SELECT id FROM ejecutivos WHERE nombre = 'Ejecutivo Fixture'), 'Calle Falsa 123, Santiago', -33.448900, -70.669300, 'Construccion', 30),
  ('Cliente Fixture Dos', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta, cliente_id, rut, telefono_whatsapp) VALUES
  ('Gerente Fixture',   'gerente@fixture.test',   'hash-de-relleno-no-valido', 'gerente',        'activo', NULL, '11.111.111-1', NULL),
  ('Mecanico Fixture',  'mecanico@fixture.test',  'hash-de-relleno-no-valido', 'mecanico',       'activo', NULL, NULL, '+56900000002'),
  ('Mecanico Fixture 2','mecanico2@fixture.test', 'hash-de-relleno-no-valido', 'mecanico',       'activo', NULL, NULL, NULL),
  ('Cliente Fixture',   'cliente@fixture.test',   'hash-de-relleno-no-valido', 'cliente',        'activo',
     (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'), NULL, NULL);

INSERT INTO sesiones (usuario_id, token_hash, app, expira_at, inactividad_min) VALUES
  ((SELECT id FROM usuarios WHERE email = 'gerente@fixture.test'),  'token-hash-fixture-1', 'panel',   '2099-01-01T00:00:00Z', 60),
  ((SELECT id FROM usuarios WHERE email = 'mecanico@fixture.test'), 'token-hash-fixture-2', 'terreno', '2099-01-01T00:00:00Z', 480);

INSERT INTO vehiculos (patente, marca, modelo, anio, tipo, kilometraje, usuario_id) VALUES
  ('FX-0001', 'Marca', 'Modelo', 2020, 'camioneta', 12345, (SELECT id FROM usuarios WHERE email = 'mecanico@fixture.test'));

INSERT INTO maquinarias (codigo, tipo, cliente_id, estado, marca, modelo, anio, numero_serie, intervalo_mantencion_horas, horometro_ultima_mantencion) VALUES
  ('FX-001', 'Grua Horquilla', (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'), 'operativa', 'Marca', 'Modelo', 2019, 'SERIE-FX-001', 250, 100),
  ('FX-002', 'Grua Horquilla', NULL, 'operativa', NULL, NULL, NULL, NULL, 250, NULL);

INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, motivo, estado, facturable, valorizacion, folio_papel, uuid_cliente, destino_lat, destino_lng, destino_origen) VALUES
  ((SELECT id FROM maquinarias WHERE codigo = 'FX-001'), (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'),
     (SELECT id FROM usuarios WHERE email = 'mecanico@fixture.test'), 'Mantencion preventiva', 'asignada', false, NULL, 'FP-1', 'f1f1f1f1-0000-4000-8000-000000000001', NULL, NULL, NULL),
  ((SELECT id FROM maquinarias WHERE codigo = 'FX-001'), (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'),
     (SELECT id FROM usuarios WHERE email = 'mecanico2@fixture.test'), 'Falla hidraulica', 'finalizada', true, 150000, NULL, 'f1f1f1f1-0000-4000-8000-000000000002', -33.450000, -70.670000, 'cliente');

INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_anterior, estado_nuevo, usuario_id, rol, ocurrio_en, origen, uuid_cliente) VALUES
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000001'), 'creacion', NULL, 'pendiente',
     (SELECT id FROM usuarios WHERE email = 'gerente@fixture.test'), 'gerente', '2026-01-01T12:00:00Z', 'panel', 'f1f1f1f1-0000-4000-8000-000000000003'),
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000001'), 'asignacion', 'pendiente', 'asignada',
     (SELECT id FROM usuarios WHERE email = 'gerente@fixture.test'), 'gerente', '2026-01-01T12:05:00Z', 'panel', 'f1f1f1f1-0000-4000-8000-000000000004');

INSERT INTO tramos_trabajo (orden_trabajo_id, inicio, termino, usuario_id, uuid_cliente) VALUES
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'), '2026-01-02T09:00:00Z', '2026-01-02T11:00:00Z',
     (SELECT id FROM usuarios WHERE email = 'mecanico2@fixture.test'), 'f1f1f1f1-0000-4000-8000-000000000005');

INSERT INTO evidencias_fotograficas (orden_trabajo_id, path, tipo, uuid_cliente) VALUES
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'), 'fixture/antes.jpg',   'antes',   'f1f1f1f1-0000-4000-8000-000000000006'),
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'), 'fixture/despues.jpg', 'despues', 'f1f1f1f1-0000-4000-8000-000000000007');

INSERT INTO firmas_recepcion (orden_trabajo_id, persona_recibe, sin_persona, firma_path) VALUES
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'), 'Persona Fixture', false, 'fixture/firma.png');

INSERT INTO insumos (nombre, unidad_medida, costo_unitario, stock_actual) VALUES
  ('Aceite hidraulico fixture', 'litro', 5000, 40);

INSERT INTO movimientos_insumo (insumo_id, orden_trabajo_id, cantidad, tipo, usuario_id, facturable, precio_unitario, uuid_cliente) VALUES
  ((SELECT id FROM insumos WHERE nombre = 'Aceite hidraulico fixture'), (SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'),
     2, 'salida', (SELECT id FROM usuarios WHERE email = 'mecanico2@fixture.test'), 'si', 8000, 'f1f1f1f1-0000-4000-8000-000000000008');

INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, registrada_por, uuid_cliente) VALUES
  ((SELECT id FROM maquinarias WHERE codigo = 'FX-001'), 'despacho', 'fixture/guia_despacho.pdf', '2026-01-03',
     (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'), (SELECT id FROM usuarios WHERE email = 'gerente@fixture.test'), 'f1f1f1f1-0000-4000-8000-000000000009'),
  ((SELECT id FROM maquinarias WHERE codigo = 'FX-001'), 'recepcion', NULL, '2026-01-20',
     (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'), (SELECT id FROM usuarios WHERE email = 'gerente@fixture.test'), 'f1f1f1f1-0000-4000-8000-000000000010');

INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto, fecha_emision, maquinaria_id, cliente_id, monto_traslado, monto_neto, fecha_vencimiento) VALUES
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'), 'FX-F-1', 'fixture/factura1.pdf', 178500, '2026-01-31',
     (SELECT id FROM maquinarias WHERE codigo = 'FX-001'), (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'), 0, 150000, '2026-03-02'),
  (NULL, 'FX-F-2', 'fixture/factura2.pdf', 119000, '2026-02-28',
     (SELECT id FROM maquinarias WHERE codigo = 'FX-001'), (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'), 0, 100000, '2026-03-30');

INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, cliente_id, orden_trabajo_id, usuario_id, uuid_cliente) VALUES
  ((SELECT id FROM maquinarias WHERE codigo = 'FX-001'), 120.5, 'movil', (SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'),
     (SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'), (SELECT id FROM usuarios WHERE email = 'mecanico2@fixture.test'), 'f1f1f1f1-0000-4000-8000-000000000011');

INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion, estado, orden_trabajo_id) VALUES
  ((SELECT id FROM clientes WHERE nombre = 'Cliente Fixture Uno'), (SELECT id FROM maquinarias WHERE codigo = 'FX-001'),
     'Ruido en el motor', 'pendiente', NULL);

INSERT INTO solicitudes_cliente (nombre_contacto, email, password_hash, nombre_empresa, estado) VALUES
  ('Contacto Fixture', 'solicitud@fixture.test', 'hash-de-relleno-no-valido', 'Empresa Fixture', 'pendiente');

INSERT INTO codigos_cuenta (proposito, usuario_id, email, codigo_hmac, expira_at, canal) VALUES
  ('recuperar_password', (SELECT id FROM usuarios WHERE email = 'cliente@fixture.test'), 'cliente@fixture.test', 'hmac-de-relleno', '2099-01-01T00:00:00Z', 'correo');

INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado) VALUES
  ('correo', 'cliente@fixture.test', '{"asunto": "Fixture", "cuerpo": "Mensaje de ejemplo"}', 'pendiente'),
  ('correo', 'cliente@fixture.test', '{"asunto": "Fixture 2", "cuerpo": "Mensaje enviado"}', 'enviado');

INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ('Bodega Fixture', 'bodega');

INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES
  ((SELECT id FROM ubicaciones_stock WHERE nombre = 'Bodega Fixture'), (SELECT id FROM insumos WHERE nombre = 'Aceite hidraulico fixture'), 40);

INSERT INTO servicios_checklist (grupo, nombre, orden) VALUES ('Fixture', 'Servicio fixture', 1);

INSERT INTO ot_servicios (orden_trabajo_id, servicio_id) VALUES
  ((SELECT id FROM ordenes_trabajo WHERE uuid_cliente = 'f1f1f1f1-0000-4000-8000-000000000002'), (SELECT id FROM servicios_checklist WHERE nombre = 'Servicio fixture'));
