# panel

Panel de GOMAQ para administrativo, gerente y cliente. App Flutter con un mismo código para **web** (se sirve
desde el backend, misma URL que la API) y **Android** (`cl.gomaq.gomaq_panel`). El cliente entra al portal en
`/portal`; administrativo y gerente, al panel de gestión.

## Ejecutar y probar

Panel y `comun/` comparten un workspace de Dart: `pub get` se corre en la raíz del repositorio.

```bash
flutter pub get --enforce-lockfile
cd panel
flutter run -d chrome --dart-define=GOMAQ_API_URL=http://localhost:3000   # con la API local en marcha
flutter analyze --no-fatal-infos
flutter test
flutter build apk --release        # Android; apunta por defecto al servidor de Railway
```

Con `flutter run -d chrome` el panel corre en otro origen que la API: arrancar el backend con `CORS_ORIGENES`
apuntando a ese origen (ver `backend/.env.example`). Para ver el panel servido por el backend:
`flutter build web --release --dart-define=GOMAQ_API_URL=` y copiar `build/web/` a `backend/public/` (carpeta
fuera de git; en el despliegue lo hace el `Dockerfile`).

## Configuración de compilación (`--dart-define`)

| Variable | Uso |
|---|---|
| `GOMAQ_API_URL` | URL de la API. Por defecto: vacía en web (mismo origen) y la de Railway en Android |
| `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID` | Avisos push (FCM). Si falta alguna, no hay push y el panel funciona igual |
| `FIREBASE_VAPID_KEY` | Además, solo para la web |

La web y el APK son apps distintas en Firebase: cada build lleva sus valores. En el build web los pasa el
`Dockerfile` desde las variables de `gomaq-app`. `web/firebase-messaging-sw.js` es el service worker que
muestra el aviso con la pestaña cerrada; no lleva configuración ni carga el SDK de Firebase (ver
[../docs/ARQUITECTURA.md](../docs/ARQUITECTURA.md), sección 8).

## Estructura

```
lib/main.dart, router.dart   Arranque y rutas (go_router)
lib/screens/acceso/          Login, registro de clientes, código de cuenta, rol no soportado
lib/screens/cliente/         Portal del cliente
lib/screens/panel/           Pantallas de administrativo y gerente
lib/services/                Cliente de la API, sesión, push
lib/widgets/, theme/, utils/ Componentes, tema (paleta y tipografía) y utilidades
web/                         index.html, manifest y service worker de push
```

## Convenciones

- Estado con `provider`; lints de `flutter_lints` (`analysis_options.yaml`).
- El cliente HTTP y el formato de fechas y montos viven en `../comun`.
- Tipografías Inter y Barlow incluidas en `assets/fonts/` (licencia OFL).
- El APK release se firma con la llave de `android/key.properties` si existe (plantilla: `android/key.properties.example`;
  la llave la genera quien publica y no se sube al repo); sin ese archivo usa la clave de depuración, válida solo
  para instalar a mano. Detalle en [../docs/DESPLIEGUE.md](../docs/DESPLIEGUE.md), sección 6.
- Decisiones de arquitectura: [../docs/tecnica/PLAN_ARQUITECTURA_FRONTEND.md](../docs/tecnica/PLAN_ARQUITECTURA_FRONTEND.md).
