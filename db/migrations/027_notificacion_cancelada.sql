-- Migracion 027: estado 'cancelado' para las notificaciones pendientes.
--
-- Anular una factura debe cancelar el correo `factura_emitida` que ya estaba encolado y todavia no
-- salio; sin un estado propio habria que usar 'error' con un texto, lo que infla el contador de
-- fallas del dashboard y deja el correo reintentable desde el panel.
--
-- Solo agrega un valor al enum, y es segura con la version anterior del servidor corriendo: esa
-- version nunca toma filas 'cancelado' (el worker solo toma 'pendiente'), el dashboard no las
-- cuenta como error y /notificaciones/:id/reintentar solo revive las que estan en 'error'.
-- ALTER TYPE ... ADD VALUE funciona dentro de la transaccion de migrar.js desde Postgres 12 (el valor
-- no se usa en esta misma migracion). Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TYPE estado_notificacion ADD VALUE IF NOT EXISTS 'cancelado';
