-- Migracion 007: ficha tecnica de maquinarias (foto, marca/modelo, numeros de identificacion, categoria)
-- GOMAQ maneja hoy 3 categorias de equipo: grua horquilla, alzahombre y transpaleta electrica,
-- cada una con distintos datos de identificacion relevantes (entrevista con la empresa + practica de la industria:
-- la factura de compra siempre trae marca/modelo/anio/combustible/N. chasis/N. motor para sacar la patente;
-- el mastil de una grua horquilla se cambia aparte y tiene su propio N. de serie; las plataformas se
-- identifican por altura maxima de trabajo, no por capacidad de carga)

CREATE TYPE categoria_equipo AS ENUM ('grua_horquilla', 'alzahombre', 'transpaleta');
CREATE TYPE tipo_combustible_maquinaria AS ENUM ('electrica', 'gas', 'gasolina', 'diesel');

ALTER TABLE maquinarias ADD COLUMN categoria_equipo categoria_equipo;
ALTER TABLE maquinarias ADD COLUMN marca VARCHAR(100);
ALTER TABLE maquinarias ADD COLUMN modelo VARCHAR(100);
ALTER TABLE maquinarias ADD COLUMN anio INTEGER;
ALTER TABLE maquinarias ADD COLUMN descripcion TEXT;
ALTER TABLE maquinarias ADD COLUMN foto_url TEXT; -- ruta en el bucket privado equipos-gomaq, no una URL directa
ALTER TABLE maquinarias ADD COLUMN numero_serie VARCHAR(100);
ALTER TABLE maquinarias ADD COLUMN numero_motor VARCHAR(100);
ALTER TABLE maquinarias ADD COLUMN numero_chasis VARCHAR(100);
ALTER TABLE maquinarias ADD COLUMN numero_mastil VARCHAR(100); -- solo grua horquilla
ALTER TABLE maquinarias ADD COLUMN capacidad_carga NUMERIC(10,2); -- kg - grua horquilla y transpaleta
ALTER TABLE maquinarias ADD COLUMN altura_trabajo NUMERIC(10,2); -- metros - solo alzahombre
ALTER TABLE maquinarias ADD COLUMN tipo_combustible tipo_combustible_maquinaria; -- grua horquilla y alzahombre
