-- Migracion 015: reintentos sin duplicados desde la cola offline, y anulacion de lineas de repuesto
--
-- 1) Idempotencia. La app del mecanico reintenta una tarea cuando no recibe respuesta a tiempo,
-- pero "no hubo respuesta" no significa "no se guardo": con la señal inestable de terreno el
-- servidor puede haber confirmado la transaccion y perdido solo la respuesta. Al reintentar se
-- duplicaba la linea de repuesto (y el descuento del furgon, y el costo del equipo), el tramo,
-- la lectura de horometro, la evidencia o la OT creada en terreno.
--
-- Cada tarea de la cola lleva ahora un UUID generado en el telefono. El servidor lo guarda en la
-- fila que crea, y si llega de nuevo devuelve la fila existente en vez de crear otra. UNIQUE
-- admite varios NULL, asi que las filas anteriores y las creadas desde el panel no se afectan.
--
-- 2) Anulacion. Una linea mal ingresada (10 filtros en vez de 1) quedaba para siempre: nadie podia
-- corregirla y ya habia descontado el stock. Como en el talonario, la linea no se borra: se tacha.
-- Queda quien la anulo y cuando, el stock vuelve a su ubicacion y deja de contar como gasto.

ALTER TABLE movimientos_insumo ADD COLUMN uuid_cliente UUID UNIQUE;
ALTER TABLE tramos_trabajo ADD COLUMN uuid_cliente UUID UNIQUE;
ALTER TABLE lecturas_horometro ADD COLUMN uuid_cliente UUID UNIQUE;
ALTER TABLE evidencias_fotograficas ADD COLUMN uuid_cliente UUID UNIQUE;
ALTER TABLE ordenes_trabajo ADD COLUMN uuid_cliente UUID UNIQUE;

ALTER TABLE movimientos_insumo ADD COLUMN anulada_at TIMESTAMPTZ;
ALTER TABLE movimientos_insumo ADD COLUMN anulada_por INTEGER REFERENCES usuarios(id);
