# Infraestructura de Railway como código

`railway.ts` define el proyecto `gomaq`: los servicios `gomaq-app` (API y panel) y `gomaq-worker` (avisos), la
base `Postgres` y su volumen. Los secretos no están en el archivo (se declaran con `preserve()`, que conserva el
valor cargado en Railway).

```bash
railway config plan     # previsualiza los cambios; no modifica nada
railway config apply    # aplica, pidiendo confirmación
```

Toda variable que exista en un servicio debe estar declarada en `railway.ts`: un `apply` borra las que falten.
Requiere el paquete npm `railway` junto al archivo.

Variables, servicios, migraciones y operación: [../docs/DESPLIEGUE.md](../docs/DESPLIEGUE.md).
