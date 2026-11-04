-- Migracion 026: guias idempotentes (uuid_cliente).
--
-- Una guia de despacho o de recepcion cambia el cliente del equipo y puede subir un PDF: si el
-- panel pierde la respuesta y reintenta, hoy se crearia una segunda guia. Igual que las demas
-- tablas con reintentos (migracion 015), cada envio lleva un UUID generado por el cliente; si ya
-- existe una guia con ese UUID, el envio ya se hizo y se devuelve esa fila.
--
-- Columna nulable y UNIQUE (admite varios NULL): la version anterior del servidor no la escribe
-- y sigue funcionando mientras se despliega. Se puede correr mas de una vez.

SET LOCAL lock_timeout = '5s';

ALTER TABLE guias ADD COLUMN IF NOT EXISTS uuid_cliente UUID;

CREATE UNIQUE INDEX IF NOT EXISTS guias_uuid_cliente_key ON guias (uuid_cliente);
