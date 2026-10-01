# panel

Panel de GOMAQ para administrativo, gerente y cliente. Es una app Flutter multiplataforma: el mismo
codigo compila a **web** (se sirve desde el backend, misma URL que la API) y a **Android**
(`cl.gomaq.gomaq_panel`). El cliente entra al portal en `/portal`; administrativo y gerente al
panel de gestion.

## Estructura
- `lib/screens/acceso/`: login, registro de clientes, rol no soportado
- `lib/screens/cliente/`: portal del cliente
- `lib/screens/panel/`: pantallas de administrativo y gerente
- `lib/services/`, `lib/widgets/`, `lib/theme/`, `lib/utils/`

## Correrlo
```bash
flutter pub get    # en la raiz del repositorio: panel/ y comun/ comparten un workspace de Dart
cd panel
flutter run -d chrome --dart-define=GOMAQ_API_URL=http://localhost:3000
flutter test && flutter analyze
flutter build apk --release    # apunta por defecto al servidor de Railway
```

El cliente HTTP y el formato de fechas y montos viven en `../comun`. Mas contexto: `../CLAUDE.md` y
`../docs/PLAN_ARQUITECTURA_FRONTEND.md`.
