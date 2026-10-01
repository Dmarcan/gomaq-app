# comun

Paquete Dart (`gomaq_comun`) con el codigo compartido entre `panel/` y `terreno/`. Es Dart puro: no
usa plugins de Flutter, para que cualquiera de las dos apps pueda importarlo.

- `ClienteApi` y `ApiException` (`lib/cliente_api.dart`): cliente HTTP del backend. Cada app le
  entrega el token, los timeouts y que hacer ante un 401. Los errores de red salen sin envolver:
  la cola de `terreno/` los clasifica por tipo.
- `Formato` (`lib/formato.dart`): fechas y montos en es_CL.

```bash
cd comun
dart analyze && dart test
```
