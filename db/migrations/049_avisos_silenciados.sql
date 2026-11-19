-- Migracion 049: avisos push que cada usuario apago (RF-06, "configurar que alertas recibe cada usuario").
--
-- * avisos_silenciados: tipos de aviso push (los de backend/src/utils/push.js, DESTINOS_PUSH) que el usuario
--   decidio no recibir. Vacio = recibe todos los que le corresponden por su rol, como hasta ahora.
-- * El aviso de mantencion proxima sigue gobernado por recibe_alertas_mantencion (migracion 012); la pantalla
--   "Mi perfil y mis avisos" lo muestra como un interruptor mas.
-- * El correo de la factura al cliente no se configura aqui: no es un aviso push.
--
-- Solo agrega una columna con valor por defecto: la instancia anterior la ignora y nada cambia para quien no
-- toque la pantalla. El rol gomaq_app ya puede leer y escribir `usuarios` (migracion 041).

ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS avisos_silenciados TEXT[] NOT NULL DEFAULT '{}';
