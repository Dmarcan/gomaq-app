/// Tipos de los avisos push que comparten el panel y la app del mecanico. Lo especifico de cada
/// plataforma (Firebase, permisos, rutas) queda en el `PushService` de cada app.
library;

/// Lo que llega en un aviso push: texto y el `data` que arma el backend (`tipo`, `orden_trabajo_id`).
class MensajePush {
  final String? titulo;
  final String? cuerpo;
  final Map<String, dynamic> data;
  const MensajePush({this.titulo, this.cuerpo, this.data = const {}});
}

/// Lo que PushService necesita del cliente HTTP (en linea, nunca la cola offline).
abstract interface class ApiPush {
  Future<dynamic> post(String path, Map<String, dynamic> body);
  Future<dynamic> delete(String path, Map<String, dynamic> body);
}
