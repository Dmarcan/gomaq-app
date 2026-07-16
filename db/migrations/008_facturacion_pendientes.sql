-- Migracion 008: facturas de arriendo (no ligadas a una orden de trabajo)
-- Una factura hoy solo podia venir de una reparacion (orden_trabajo_id). Para que un
-- arriendo (ciclo guia de despacho + guia de recepcion) tambien se pueda facturar sin
-- inventar una tabla paralela, se le agregan estas dos columnas: una factura de arriendo
-- las usa en vez de orden_trabajo_id (que ya era nullable).

ALTER TABLE facturas ADD COLUMN maquinaria_id INTEGER REFERENCES maquinarias(id);
ALTER TABLE facturas ADD COLUMN guia_recepcion_id INTEGER REFERENCES guias(id);

CREATE INDEX idx_facturas_guia_recepcion ON facturas(guia_recepcion_id);
