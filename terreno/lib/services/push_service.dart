import 'dart:async';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import '../db/local_database.dart';
import 'api_client.dart';
import 'push_config.dart';

/// Lo que llega en un aviso push: texto y el `data` que arma el backend (`tipo`, `orden_trabajo_id`).
class MensajePush {
  final String? titulo;
  final String? cuerpo;
  final Map<String, dynamic> data;
  const MensajePush({this.titulo, this.cuerpo, this.data = const {}});
}

/// Lo que PushService necesita de Firebase. Existe para probar el servicio sin plugin ni telefono.
abstract interface class PushPlataforma {
  Future<void> inicializar(ConfigPush config);
  Future<bool> permisoConcedido();
  Future<bool> pedirPermiso();
  Future<String?> obtenerToken();
  Stream<String> get alRenovarToken;
  Stream<MensajePush> get alRecibirEnPrimerPlano;
  Stream<MensajePush> get alAbrirDesdeNotificacion;
  Future<MensajePush?> mensajeInicial();
  Future<void> borrarToken();
}

/// Lo que PushService necesita del cliente HTTP (en linea, nunca la cola offline).
abstract interface class ApiPush {
  Future<dynamic> post(String path, Map<String, dynamic> body);
  Future<dynamic> delete(String path, Map<String, dynamic> body);
}

class _ApiPushReal implements ApiPush {
  const _ApiPushReal();
  @override
  Future<dynamic> post(String path, Map<String, dynamic> body) => ApiClient.instance.post(path, body);
  @override
  Future<dynamic> delete(String path, Map<String, dynamic> body) => ApiClient.instance.delete(path, body);
}

/// Destino al tocar un aviso: una OT concreta o la lista.
class DestinoPush {
  final int? ordenId;
  const DestinoPush.orden(int id) : ordenId = id;
  const DestinoPush.lista() : ordenId = null;
}

/// Lee `orden_trabajo_id` del data (llega como texto en FCM) y decide: abre la OT solo si esta en la
/// base local; si no, la lista.
Future<DestinoPush> destinoDeAviso(
  Map<String, dynamic> data,
  Future<bool> Function(int id) existeLocal,
) async {
  final id = int.tryParse((data['orden_trabajo_id'] ?? '').toString());
  if (id == null || id <= 0) return const DestinoPush.lista();
  return await existeLocal(id) ? DestinoPush.orden(id) : const DestinoPush.lista();
}

/// Avisos push de ordenes (FCM). Sin configuracion de Firebase queda apagado y no hace nada.
///
/// El token se registra en linea (`POST /api/dispositivos`), no por la cola offline: un token viejo no
/// sirve. Si el servidor aun no tiene la ruta (404) o no hay senal, se ignora y se reintenta la
/// proxima vez que se abre la app o cambie el token. Sin `onBackgroundMessage`: con la app cerrada o
/// en segundo plano muestra la notificacion el sistema.
class PushService {
  PushService({
    ConfigPush config = ConfigPush.desdeEntorno,
    PushPlataforma? plataforma,
    ApiPush api = const _ApiPushReal(),
    Future<String?> Function(String clave)? leerFlag,
    Future<void> Function(String clave, String valor)? guardarFlag,
  })  : _config = config,
        _plataforma = plataforma ?? _PlataformaFirebase(),
        _api = api,
        _leerFlag = leerFlag ?? ((c) => LocalDatabase.instance.leerSesion(c)),
        _guardarFlag = guardarFlag ?? ((c, v) => LocalDatabase.instance.guardarSesion(c, v));

  static final PushService instancia = PushService();

  static const claveYaPreguntado = 'push_permiso_preguntado';

  final ConfigPush _config;
  final PushPlataforma _plataforma;
  final ApiPush _api;
  final Future<String?> Function(String) _leerFlag;
  final Future<void> Function(String, String) _guardarFlag;

  bool _activo = false;
  bool _iniciado = false;
  String? _token;
  final _suscripciones = <StreamSubscription<dynamic>>[];

  ConfigPush get config => _config;
  bool get activo => _activo;
  String? get tokenActual => _token;

  /// Se llama con la sesion abierta y la pantalla principal a la vista. [explicarPermiso] muestra el
  /// dialogo previo y devuelve true si el mecanico acepta; solo se usa la primera vez (si lo
  /// niega, no se insiste en cada arranque). [sincronizar] trae lo nuevo del servidor; [alAbrir]
  /// navega; [mostrarAviso] muestra el aviso con la app abierta; [existeOrdenLocal] consulta la
  /// base local.
  Future<void> iniciar({
    required Future<bool> Function() explicarPermiso,
    required Future<void> Function() sincronizar,
    required Future<bool> Function(int id) existeOrdenLocal,
    required void Function(DestinoPush destino) alAbrir,
    required void Function(MensajePush mensaje) mostrarAviso,
  }) async {
    if (!_config.completa) return;
    try {
      if (!_iniciado) {
        await _plataforma.inicializar(_config);
        _iniciado = true;
      }
      _activo = true;

      Future<void> alTocar(MensajePush m) async {
        try {
          await sincronizar();
        } catch (_) {
          // sin senal: igual se abre lo que haya en el telefono
        }
        alAbrir(await destinoDeAviso(m.data, existeOrdenLocal));
      }

      await _cancelarSuscripciones();
      _suscripciones.add(_plataforma.alRenovarToken.listen((t) => _registrar(t)));
      _suscripciones.add(_plataforma.alRecibirEnPrimerPlano.listen((m) {
        mostrarAviso(m);
        sincronizar().catchError((_) {});
      }));
      _suscripciones.add(_plataforma.alAbrirDesdeNotificacion.listen(alTocar));

      final inicial = await _plataforma.mensajeInicial();
      if (inicial != null) unawaited(alTocar(inicial));

      if (!await _permisoListo(explicarPermiso)) return;
      final token = await _plataforma.obtenerToken();
      if (token != null && token.isNotEmpty) await _registrar(token);
    } catch (_) {
      // el push nunca debe romper la app: queda como esta y se reintenta al volver a abrirla
    }
  }

  Future<bool> _permisoListo(Future<bool> Function() explicarPermiso) async {
    if (await _plataforma.permisoConcedido()) return true;
    if (await _leerFlag(claveYaPreguntado) != null) return false;
    final acepto = await explicarPermiso();
    await _guardarFlag(claveYaPreguntado, '1');
    if (!acepto) return false;
    return _plataforma.pedirPermiso();
  }

  Future<void> _registrar(String token) async {
    try {
      await _api.post('/api/dispositivos', {'token': token, 'plataforma': 'android', 'app': 'terreno'});
      _token = token;
    } on ApiException {
      // 404: el servidor aun no tiene la ruta. Otros errores: se reintenta al reabrir la app.
    } catch (_) {
      // sin senal o tiempo agotado
    }
  }

  /// Cierre de sesion: [avisarServidor] pide `DELETE /api/dispositivos` (solo si la sesion sigue valida;
  /// con sesion vencida el servidor respondera 401 y no hace falta) y despues se borra el token de
  /// Firebase para que este telefono deje de recibir avisos de esa cuenta. Nunca lanza.
  Future<void> alCerrarSesion({required bool avisarServidor}) async {
    if (!_activo) return;
    final token = _token;
    if (avisarServidor && token != null) {
      try {
        await _api.delete('/api/dispositivos', {'token': token}).timeout(const Duration(seconds: 3));
      } catch (_) {
        // mejor esfuerzo: el servidor tambien desactiva los dispositivos al cerrar la sesion
      }
    }
    try {
      await _plataforma.borrarToken();
    } catch (_) {}
    _token = null;
    await _cancelarSuscripciones();
  }

  Future<void> _cancelarSuscripciones() async {
    for (final s in _suscripciones) {
      await s.cancel();
    }
    _suscripciones.clear();
  }
}

/// Implementacion real sobre firebase_messaging. Solo se usa con config completa.
class _PlataformaFirebase implements PushPlataforma {
  FirebaseMessaging get _fm => FirebaseMessaging.instance;

  static MensajePush _a(RemoteMessage m) => MensajePush(
        titulo: m.notification?.title,
        cuerpo: m.notification?.body,
        data: Map<String, dynamic>.from(m.data),
      );

  @override
  Future<void> inicializar(ConfigPush c) async {
    if (Firebase.apps.isNotEmpty) return;
    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: c.apiKey,
        appId: c.appId,
        messagingSenderId: c.senderId,
        projectId: c.projectId,
      ),
    );
  }

  @override
  Future<bool> permisoConcedido() async {
    final s = await _fm.getNotificationSettings();
    return s.authorizationStatus == AuthorizationStatus.authorized ||
        s.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  Future<bool> pedirPermiso() async {
    final s = await _fm.requestPermission();
    return s.authorizationStatus == AuthorizationStatus.authorized ||
        s.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  Future<String?> obtenerToken() => _fm.getToken();

  @override
  Stream<String> get alRenovarToken => _fm.onTokenRefresh;

  @override
  Stream<MensajePush> get alRecibirEnPrimerPlano => FirebaseMessaging.onMessage.map(_a);

  @override
  Stream<MensajePush> get alAbrirDesdeNotificacion => FirebaseMessaging.onMessageOpenedApp.map(_a);

  @override
  Future<MensajePush?> mensajeInicial() async {
    final m = await _fm.getInitialMessage();
    return m == null ? null : _a(m);
  }

  @override
  Future<void> borrarToken() => _fm.deleteToken();
}
