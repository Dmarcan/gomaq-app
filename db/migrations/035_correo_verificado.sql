-- Migracion 035: marca de correo verificado en las solicitudes de cliente.
--
-- Al registrarse, el cliente recibe un codigo de 6 digitos en su correo (codigos_cuenta, proposito
-- 'verificar_correo', migracion 034) y lo escribe en la pantalla de registro. Cuando coincide se guarda
-- la hora aqui; el administrativo la ve al aprobar la solicitud. Nulo = sin verificar.
--
-- Solo AGREGA una columna: el servidor anterior la ignora. Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE solicitudes_cliente ADD COLUMN IF NOT EXISTS correo_verificado_at TIMESTAMPTZ;
