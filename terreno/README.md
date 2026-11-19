# terreno

App del mecánico de GOMAQ. Flutter, **solo Android** (`cl.gomaq.gomaq_mecanico`), offline-first: guarda todo
en SQLite en el teléfono y lo envía al backend con una cola de sincronización
(`lib/services/sync_service.dart`). Cada tarea lleva un `uuid_cliente` para que un reintento no duplique datos en
el servidor. Reglas de la cola: [../docs/ARQUITECTURA.md](../docs/ARQUITECTURA.md), sección 7.

Es un proyecto aparte del panel a propósito: el APK se instala a mano en cada teléfono y conviven versiones
antiguas con tareas por sincronizar. No es miembro del workspace de Dart de la raíz: depende de `../comun` por
`path` y tiene su propio `pubspec.lock`.

## Ejecutar y probar

```bash
cd terreno
flutter pub get --enforce-lockfile
flutter run --dart-define=GOMAQ_API_URL=http://10.0.2.2:3000   # emulador contra el backend local
flutter analyze --no-fatal-infos
flutter test
flutter build apk --release        # apunta por defecto al servidor de Railway
```

Las pruebas de la cola usan una base SQLite real (`sqflite_common_ffi`), sin teléfono ni emulador.

## Configuración de compilación (`--dart-define`)

| Variable | Uso |
|---|---|
| `GOMAQ_API_URL` | URL de la API. Por defecto, la de Railway |
| `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID` | Avisos push (FCM). Si falta alguna, no se inicializa Firebase y la app funciona igual |

La configuración de Firebase llega solo por `--dart-define` (no se usa `google-services.json`).

## Estructura

```
lib/main.dart
lib/config/     Reglas de negocio de la app
lib/db/         Base SQLite local (local_database.dart)
lib/models/     Modelos
lib/screens/    Pantallas: login, lista y detalle de OT, cierre, órdenes disponibles, flota, furgón, mi cuenta
lib/services/   API, sesión, conectividad, cola de sincronización, posición, push
lib/theme/, utils/, widgets/
```

## Convenciones

- Lo que el usuario registra se guarda primero en SQLite y se encola; la pantalla no depende de la red.
- Cada tarea de la cola lleva `uuid_cliente`; un 401 pausa la cola y un 403 marca solo esa tarea con error.
- Antes de actualizar el APK en un teléfono, sincronizar hasta ver "Todo enviado": desinstalar la app borra la
  cola pendiente.
- Un cambio que toca la cola se despliega con el backend primero y el APK después.
- El APK release se firma con la llave de `android/key.properties` si existe (plantilla: `android/key.properties.example`;
  la llave la genera quien publica y no se sube al repo); sin ese archivo usa la clave de depuración, válida solo
  para instalar a mano. Detalle en [../docs/DESPLIEGUE.md](../docs/DESPLIEGUE.md), sección 6.
