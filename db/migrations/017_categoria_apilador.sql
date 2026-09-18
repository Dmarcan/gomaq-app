-- Migracion 017: categoria "apilador" para los apiladores electricos
--
-- La carga del inventario real (db/datos/equipos_gomaq.json) trajo un apilador electrico BT que
-- no calzaba en ninguna de las tres categorias de la migracion 007 y quedo sin categoria: se
-- veia en la lista, pero no aparecia al filtrar por categoria. Es un equipo distinto de la
-- traspaleta (levanta la carga a un nivel, no solo la traslada), asi que tiene su propia categoria.
--
-- IF NOT EXISTS: el valor de un enum no se puede quitar, y asi la migracion es repetible.

ALTER TYPE categoria_equipo ADD VALUE IF NOT EXISTS 'apilador';
