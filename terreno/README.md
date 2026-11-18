# terreno

App del mecanico de GOMAQ. Flutter, **solo Android** (`cl.gomaq.gomaq_mecanico`), offline-first:
guarda todo en SQLite en el telefono y lo envia al backend con una cola de sincronizacion
(`lib/services/sync_service.dart`). Cada tarea lleva un `uuid_cliente` para que un reintento no
duplique datos en el servidor.

Es un proyecto aparte del panel a proposito: el APK se instala a mano en cada telefono y conviven
versiones antiguas con tareas por sincronizar. No es miembro del workspace de Dart de la raiz:
depende de `../comun` por `path` y tiene su propio `pubspec.lock`.

## Correrlo
```bash
cd terreno
flutter pub get
flutter run --dart-define=GOMAQ_API_URL=http://10.0.2.2:3000   # emulador contra el backend local
flutter test && flutter analyze
flutter build apk --release    # apunta por defecto al servidor de Railway
```

Antes de actualizar el APK en un telefono, sincronizar hasta ver "Todo enviado": desinstalar la
app borra la cola pendiente.
