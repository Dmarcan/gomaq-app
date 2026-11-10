-- Migracion 032: cuando se cambio la contrasena de una cuenta.
--
-- Al restablecer la contrasena de otra cuenta (POST /api/usuarios/:id/password), las sesiones que
-- ya tenia abiertas deben dejar de valer: verifyToken rechaza un token emitido antes de esta hora.
-- Sin esto, quien tuviera la sesion de una cuenta comprometida la conservaria hasta 12 h despues del
-- cambio de clave.
--
-- Solo AGREGA una columna NULL-able: el servidor anterior la ignora y puede correr un momento con
-- este esquema. Se puede correr mas de una vez. NULL significa que la clave nunca se cambio.

SET LOCAL lock_timeout = '5s';

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_cambiada_at TIMESTAMPTZ;
