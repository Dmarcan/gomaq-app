import 'notificacion_local_base.dart';
import 'push_service.dart' show PermisoAvisos;

/// Sin navegador (Android y pruebas): no hay avisos locales.
class _SinNotificacionLocal implements NotificacionLocal {
  const _SinNotificacionLocal();
  @override
  bool get soportada => false;
  @override
  PermisoAvisos get permiso => PermisoAvisos.denegado;
  @override
  Future<PermisoAvisos> pedirPermiso() async => PermisoAvisos.denegado;
  @override
  bool get pestanaEnFoco => true;
  @override
  String get userAgent => '';
  @override
  bool get esBrave => false;
  @override
  void mostrar({required String titulo, required String cuerpo, required String tag, required void Function() alTocar}) {}
}

NotificacionLocal crearNotificacionLocal() => const _SinNotificacionLocal();
