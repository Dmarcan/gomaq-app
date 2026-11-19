# db

Esquema de PostgreSQL de GOMAQ.

- `schema.sql`: esquema base.
- `migrations/NNN_nombre.sql`: cambios numerados (002 a 049 hoy), aplicados por
  `backend/scripts/migrar.js` en orden y una sola vez cada uno; el registro queda en `schema_migraciones`.
- `scripts/`: `semilla_pruebas.sql` (cuentas y datos ficticios para el entorno local; no usar en producción),
  `fixture_migraciones_base.sql` (filas para probar migraciones, ver su encabezado) y
  `limpiar_datos_prueba.sql` (borra datos de prueba por identificadores fijos: leerlo antes de correrlo).
- `datos/`: `equipos_gomaq.json` alimenta `backend/scripts/cargar_equipos.js`; `clientes_gomaq.ejemplo.json`
  muestra el formato de `cargar_clientes.js` (el archivo real `clientes_gomaq.json` está en `.gitignore`: lleva
  datos personales); `casos_corte_cobro.json` lo usan pruebas del cálculo de días de arriendo.

## Aplicar

```bash
cd backend && npm run migrar      # usa DATABASE_URL (o DATABASE_URL_MIGRACION)
```

En producción corre sola al arrancar `gomaq-app` (ver [../docs/DESPLIEGUE.md](../docs/DESPLIEGUE.md)).

## Convenciones para una migración nueva

- Archivo siguiente en la numeración: `db/migrations/050_descripcion_corta.sql` (tres dígitos, minúsculas,
  guiones bajos). Una migración aplicada no se edita: se agrega otra.
- Cada migración corre en su propia transacción: no incluir `BEGIN` ni `COMMIT`.
- Debe aplicar sobre una base con filas y ser compatible con la versión anterior de la API durante el
  despliegue (columnas nuevas con valor por defecto o nulas, sin quitar lo que la versión anterior usa).
  El CI lo comprueba con `backend/scripts/probar_migraciones_con_datos.js`.
- Comentar en el encabezado qué cambia y por qué.
- `ordenes_eventos` es de solo inserción (migración 020); el rol `gomaq_app` (migración 041) no tiene DDL.
