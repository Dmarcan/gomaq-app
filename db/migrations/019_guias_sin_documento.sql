-- Guias sin documento: despachar un equipo antes de tener el PDF de la guia.
--
-- El equipo a veces sale antes de que la guia firmada este escaneada. Hasta ahora no se podia
-- registrar el despacho (y con el, el arriendo, los dias cobrables y el horometro) sin subir el PDF.
-- Ahora la guia puede crearse sin archivo y el PDF se adjunta despues; mientras tanto queda
-- visible como "falta el documento". La guia sigue siendo el unico evento que asigna y libera un
-- equipo, asi que las reglas de arriendo no cambian.

ALTER TABLE guias ALTER COLUMN archivo_url DROP NOT NULL;

-- quien registro la guia (en una sin documento es lo que permite pedir cuentas) y cuando se
-- adjunto el PDF
ALTER TABLE guias ADD COLUMN registrada_por INTEGER REFERENCES usuarios(id);
ALTER TABLE guias ADD COLUMN documento_adjuntado_at TIMESTAMPTZ;

CREATE INDEX idx_guias_sin_documento ON guias (id) WHERE archivo_url IS NULL;
