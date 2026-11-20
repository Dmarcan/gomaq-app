# comun

Paquete Dart (`gomaq_comun`) con el código compartido entre `panel/` y `terreno/`. Es Dart puro: no usa
plugins de Flutter, para que cualquiera de las dos apps pueda importarlo. Es miembro del workspace de Dart de la
raíz (con `panel/`); `terreno/` lo usa por `path`.

## Contenido

- `lib/cliente_api.dart`: `ClienteApi`, `ApiException` y `urlServidorProduccion`. Cliente HTTP del backend;
  cada app le entrega el token, los timeouts y qué hacer ante un 401. Los errores de red salen sin envolver:
  la cola de `terreno/` los clasifica por tipo.
- `lib/formato.dart`: `Formato`, fechas y montos en es_CL.

## Probar

```bash
flutter pub get --enforce-lockfile   # desde la raíz del repositorio
cd comun
dart analyze && dart test
```

## Convenciones

- Sin dependencias de Flutter: solo `http`, `http_parser`, `intl` y `mime`.
- Un cambio aquí afecta a las dos apps; el CI de `terreno/` corre también cuando cambia `comun/`.
