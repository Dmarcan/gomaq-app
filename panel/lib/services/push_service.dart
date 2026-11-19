// getToken, onTokenRefresh y deleteToken estan marcados como obsoletos en firebase_messaging 17: migrar a
// register()/onRegistered/unregister() cuando se pruebe con Firebase real (igual que terreno).
// ignore_for_file: deprecated_member_use
import 'dart:async';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:gomaq_comun/push.dart';
import 'api_client.dart';
import 'push_config.dart';

// MensajePush y ApiPush viven en gomaq_comun; se reexportan para quien ya los importaba desde aqui.
export 'package:gomaq_comun/push.dart';

/// Estado del permiso de notificaciones del navegador o del telefono.
enum PermisoAvisos { concedido, denegado, pendiente }

/// Lo que ve la persona en el boton de avisos.
/// [soloPanelAbierto] no lo emite PushService: lo arma el boton cuando solo anda la capa local (ver estadoCombinado).
enum EstadoAvisos { noDisponible, porActivar, activados, soloPanelAbierto, bloqueados }

/// Lo que PushService necesita de Firebase. Existe para probar el servicio sin plugin ni navegador.
abstract interface class PushPlataforma {
  Future<void> inicializar(ConfigPush config);

  /// false en navegadores sin notificaciones push (p. ej. Safari de iPhone sin instalar la PWA).
  Future<bool> soportado();
  Future<PermisoAvisos> estadoPermiso();
  Future<PermisoAvisos> pedirPermiso();
  Future<String?> obtenerToken(ConfigPush config);
  Stream<String> get alRenovarToken;
  Stream<MensajePush> get alRecibirEnPrimerPlano;
  Stream<MensajePush> get alAbrirDesdeNotificacion;
  Future<MensajePush?> mensajeInicial();
  Future<void> borrarToken();
}

class _ApiPushReal implements ApiPush {
  const _ApiPushReal();
  @override
  Future<dynamic> post(String path, Map<String, dynamic> body) => ApiClient.instance.post(path, body);
  @override
  Future<dynamic> delete(String path, Map<String, dynamic> body) => ApiClient.instance.delete(path, body);
}

/// Ruta del panel que se abre al tocar un aviso. El cliente siempre queda en el portal (el router
/// ademas lo redirige); el resto va a la OT si el aviso trae una, o al inicio, donde estan los pendientes.
String rutaDeAviso(Map<String, dynamic> data, {required bool esCliente}) {
  if (esCliente) return '/portal';
  final id = int.tryParse((data['orden_trabajo_id'] ?? '').toString());
  if (id != null && id > 0) return '/ordenes/$id';
  return '/';
}

/// Avisos push (FCM) del panel, en la web y en Android. Sin configuracion de Firebase queda apagado y
/// no hace nada.
///
/// El token se registra en linea (`POST /api/dispositivos`, `app: 'panel'`). Si el servidor aun no tiene
/// la ruta (404) o no hay senal, se ignora y se reintenta al volver a abrir el panel o cambiar el token.
/// En la web NUNCA se pide permiso al cargar: solo cuando la persona toca "Activar avisos"; si el
/// navegador ya lo tenia concedido, se registra el token en silencio. En Android se pregunta una vez con
/// un dialogo previo (despues queda el boton).
class PushService {
  PushService({
    ConfigPush config = ConfigPush.desdeEntorno,
    PushPlataforma? plataforma,
    ApiPush api = const _ApiPushReal(),
    bool? web,
    Future<String?> Function(String clave)? leerFlag,
    Future<void> Function(String clave, String valor)? guardarFlag,
  })  : _config = config,
        _web = web ?? kIsWeb,
        _plataforma = plataforma ?? _PlataformaFirebase(),
        _api = api,
        _leerFlag = leerFlag ?? ((c) => const FlutterSecureStorage().read(key: c)),
        _guardarFlag = guardarFlag ?? ((c, v) => const FlutterSecureStorage().write(key: c, value: v));

  static final PushService instancia = PushService();

  static const claveYaPreguntado = 'push_permiso_preguntado';

  final ConfigPush _config;
  final bool _web;
  final PushPlataforma _plataforma;
  final ApiPush _api;
  final Future<String?> Function(String) _leerFlag;
  final Future<void> Function(String, String) _guardarFlag;

  final ValueNotifier<EstadoAvisos> estado = ValueNotifier(EstadoAvisos.noDisponible);

  /// Por que el push no esta disponible, en una frase corta y tecnica ("el navegador no soporta push",
  /// "fallo al iniciar: ..."). Null si no hay fallo o si el push no esta configurado. Sirve para decirle
  /// a la persona (y a quien da soporte) que paso, en vez de un "no disponible" sin explicacion.
  String? motivoNoDisponible;

  bool _activo = false;
  bool _iniciado = false;
  String? _token;
  final _suscripciones = <StreamSubscription<dynamic>>[];

  ConfigPush get config => _config;
  bool get configurado => _config.completaPara(web: _web);
  bool get activo => _activo;
  String? get tokenActual => _token;

  /// Se llama con la sesion abierta. [explicarPermiso] (solo Android) muestra el dialogo previo y devuelve
  /// true si la persona acepta; solo se usa la primera vez. [alAbrir] navega a la ruta del aviso;
  /// [mostrarAviso] muestra el aviso con el panel abierto; [alRecibir] refresca lo pendiente.
  Future<void> iniciar({
    required Future<bool> Function() explicarPermiso,
    required void Function(MensajePush mensaje) alAbrir,
    required void Function(MensajePush mensaje) mostrarAviso,
    void Function()? alRecibir,
  }) async {
    if (!configurado) return;
    try {
      if (!_iniciado) {
        await _plataforma.inicializar(_config);
        _iniciado = true;
      }
      if (!await _plataforma.soportado()) {
        motivoNoDisponible = 'el navegador no soporta push';
        estado.value = EstadoAvisos.noDisponible;
        return;
      }
      motivoNoDisponible = null;
      _activo = true;

      await _cancelarSuscripciones();
      _suscripciones.add(_plataforma.alRenovarToken.listen((t) => _registrar(t)));
      _suscripciones.add(_plataforma.alRecibirEnPrimerPlano.listen((m) {
        mostrarAviso(m);
        alRecibir?.call();
      }));
      _suscripciones.add(_plataforma.alAbrirDesdeNotificacion.listen(alAbrir));
      final inicial = await _plataforma.mensajeInicial();
      if (inicial != null) alAbrir(inicial);

      var permiso = await _plataforma.estadoPermiso();
      if (permiso == PermisoAvisos.pendiente && !_web && await _leerFlag(claveYaPreguntado) == null) {
        final acepto = await explicarPermiso();
        await _guardarFlag(claveYaPreguntado, '1');
        if (acepto) permiso = await _plataforma.pedirPermiso();
      }
      await _aplicarPermiso(permiso);
    } catch (e) {
      // el push nunca debe romper el panel: queda como esta y se reintenta al volver a abrirlo
      _fallo('fallo al iniciar', e);
    }
  }

  /// Accion de la persona (boton "Activar avisos"): pide el permiso al navegador o al sistema.
  Future<void> activar() async {
    if (!_activo) return;
    try {
      await _aplicarPermiso(await _plataforma.pedirPermiso());
    } catch (e) {
      _fallo('fallo al activar', e);
    }
  }

  /// Guarda el motivo (una linea, sin saltos ni textos largos) y deja el push como no disponible.
  void _fallo(String prefijo, Object error) {
    final detalle = error.toString().replaceAll(RegExp(r'\s+'), ' ').trim();
    motivoNoDisponible = detalle.isEmpty
        ? prefijo
        : '$prefijo: ${detalle.length > 140 ? '${detalle.substring(0, 140)}...' : detalle}';
    estado.value = EstadoAvisos.noDisponible;
  }

  Future<void> _aplicarPermiso(PermisoAvisos permiso) async {
    switch (permiso) {
      case PermisoAvisos.concedido:
        // si Firebase no entrega el token (en Brave sin los servicios de Google de push, por ejemplo)
        // el error sube a iniciar()/activar(), que guardan el motivo
        final token = await _plataforma.obtenerToken(_config);
        motivoNoDisponible = null;
        estado.value = EstadoAvisos.activados;
        if (token != null && token.isNotEmpty) await _registrar(token);
      case PermisoAvisos.denegado:
        estado.value = EstadoAvisos.bloqueados;
      case PermisoAvisos.pendiente:
        estado.value = EstadoAvisos.porActivar;
    }
  }

  Future<void> _registrar(String token) async {
    try {
      await _api.post('/api/dispositivos', {'token': token, 'plataforma': _web ? 'web' : 'android', 'app': 'panel'});
      _token = token;
    } on ApiException {
      // 404: el servidor aun no tiene la ruta. Otros errores: se reintenta al reabrir el panel.
    } catch (_) {
      // sin senal o tiempo agotado
    }
  }

  /// Cierre de sesion: [avisarServidor] pide `DELETE /api/dispositivos` (solo si la sesion sigue valida)
  /// y despues se borra el token de Firebase para que este equipo deje de recibir avisos de esa cuenta.
  /// Nunca lanza.
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
    _activo = false;
    estado.value = EstadoAvisos.noDisponible;
    await _cancelarSuscripciones();
  }

  Future<void> _cancelarSuscripciones() async {
    for (final s in _suscripciones) {
      await s.cancel();
    }
    _suscripciones.clear();
  }
}

/// Implementacion real sobre firebase_messaging (web y Android). Solo se usa con config completa.
class _PlataformaFirebase implements PushPlataforma {
  FirebaseMessaging get _fm => FirebaseMessaging.instance;

  static MensajePush _a(RemoteMessage m) => MensajePush(
        titulo: m.notification?.title,
        cuerpo: m.notification?.body,
        data: Map<String, dynamic>.from(m.data),
      );

  static PermisoAvisos _p(AuthorizationStatus s) => switch (s) {
        AuthorizationStatus.authorized || AuthorizationStatus.provisional => PermisoAvisos.concedido,
        AuthorizationStatus.denied || AuthorizationStatus.deniedPermanently => PermisoAvisos.denegado,
        AuthorizationStatus.notDetermined => PermisoAvisos.pendiente,
      };

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
  Future<bool> soportado() => _fm.isSupported();

  @override
  Future<PermisoAvisos> estadoPermiso() async => _p((await _fm.getNotificationSettings()).authorizationStatus);

  @override
  Future<PermisoAvisos> pedirPermiso() async => _p((await _fm.requestPermission()).authorizationStatus);

  @override
  Future<String?> obtenerToken(ConfigPush c) => kIsWeb
      // el plugin registra el service worker (sin config dentro: ver web/firebase-messaging-sw.js)
      ? _fm.getToken(vapidKey: c.vapidKey, serviceWorkerScriptPath: '/firebase-messaging-sw.js')
      : _fm.getToken();

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
