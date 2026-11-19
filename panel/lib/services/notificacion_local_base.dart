import 'push_service.dart' show PermisoAvisos;

/// La API local de notificaciones del navegador (`Notification`): muestra avisos con el panel abierto sin
/// pasar por Firebase ni por el servicio de push de Google. Existe como interfaz para probar el servicio
/// sin navegador; en Android no hay implementación (los avisos van por push).
abstract interface class NotificacionLocal {
  bool get soportada;
  PermisoAvisos get permiso;

  /// Pide el permiso al navegador. Solo debe llamarse desde un toque de la persona.
  Future<PermisoAvisos> pedirPermiso();

  /// true si la pestaña está visible y con foco: ahí el aviso sobra, la persona ya está mirando el panel.
  bool get pestanaEnFoco;
  String get userAgent;
  bool get esBrave;

  /// Muestra el aviso. [alTocar] se llama al tocarlo (con la pestaña ya enfocada). Nunca lanza.
  void mostrar({required String titulo, required String cuerpo, required String tag, required void Function() alTocar});
}
