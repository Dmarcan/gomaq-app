import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show ValueNotifier;
import 'package:geolocator/geolocator.dart';
import '../utils/envio_posicion.dart';
import '../utils/navegacion.dart';
import 'api_client.dart';

/// Posicion del mecanico mientras va en camino, para calcular la hora de llegada que ve el cliente.
///
/// - Mientras la OT esta en camino corre un servicio en primer plano (notificacion fija en Android)
///   que sigue entregando ubicacion aunque el mecanico pase a Google Maps o Waze. Se inicia con la
///   app a la vista (al tocar "Salir"), asi basta el permiso normal "mientras usas la app": no hay
///   que ir a Ajustes. Se apaga al salir del estado en camino.
/// - Las posiciones NO pasan por la cola de sincronizacion: una posicion vieja no sirve, asi que si
///   no hay senal simplemente se descarta (y no gasta reintentos ni lleva uuid).
/// - Nada de aqui puede fallar el trabajo del mecanico: sin permiso, sin GPS o sin red devuelve null
///   o no hace nada, y el viaje sigue igual.
/// Si la app puede enviar la posición del mecánico y, si no, por qué.
enum EstadoUbicacion { ok, servicioApagado, permisoDenegado, permisoBloqueado, desconocido }

/// Traduce lo que informa el teléfono al estado que ve el mecánico. Función pura para poder probarla.
EstadoUbicacion estadoDeUbicacion({required bool servicioActivo, required LocationPermission permiso}) {
  if (!servicioActivo) return EstadoUbicacion.servicioApagado;
  switch (permiso) {
    case LocationPermission.whileInUse:
    case LocationPermission.always:
      return EstadoUbicacion.ok;
    case LocationPermission.denied:
      return EstadoUbicacion.permisoDenegado;
    case LocationPermission.deniedForever:
      return EstadoUbicacion.permisoBloqueado;
    case LocationPermission.unableToDetermine:
      return EstadoUbicacion.desconocido;
  }
}

/// Que hacer despues de pedirle el permiso de ubicacion al mecanico con el boton "Dar permiso".
enum AccionTrasPermiso { iniciarSeguimiento, abrirAjustes, nada }

/// Resultado del permiso -> accion. Si sigue negado (Android deja de mostrar el dialogo tras dos
/// negativas) solo queda mandar a los ajustes de la app. Funcion pura para poder probarla.
AccionTrasPermiso accionTrasPedirPermiso(LocationPermission resultado) {
  switch (resultado) {
    case LocationPermission.whileInUse:
    case LocationPermission.always:
      return AccionTrasPermiso.iniciarSeguimiento;
    case LocationPermission.denied:
    case LocationPermission.deniedForever:
      return AccionTrasPermiso.abrirAjustes;
    case LocationPermission.unableToDetermine:
      return AccionTrasPermiso.nada;
  }
}

class PosicionService {
  PosicionService._();

  /// Boton "Dar permiso": pide el permiso y, si sigue negado, abre los ajustes de la app. Devuelve
  /// la accion tomada. Nunca lanza.
  static Future<AccionTrasPermiso> pedirPermisoOAjustes() async {
    try {
      final resultado = await Geolocator.requestPermission();
      final accion = accionTrasPedirPermiso(resultado);
      if (accion == AccionTrasPermiso.abrirAjustes) await Geolocator.openAppSettings();
      return accion;
    } catch (_) {
      return AccionTrasPermiso.nada;
    }
  }

  /// Estado actual de la ubicación del teléfono, sin pedir nada ni abrir diálogos.
  static Future<EstadoUbicacion> estadoUbicacion() async {
    try {
      return estadoDeUbicacion(
        servicioActivo: await Geolocator.isLocationServiceEnabled(),
        permiso: await Geolocator.checkPermission(),
      );
    } catch (_) {
      return EstadoUbicacion.desconocido;
    }
  }

  /// Abre la pantalla de ajustes que corresponde: el GPS del teléfono o los permisos de la app.
  static Future<void> abrirAjustes(EstadoUbicacion estado) async {
    try {
      if (estado == EstadoUbicacion.servicioApagado) {
        await Geolocator.openLocationSettings();
      } else {
        await Geolocator.openAppSettings();
      }
    } catch (_) {
      // sin ajustes que abrir: el mensaje en pantalla ya dice qué hacer
    }
  }

  static const _tiempoMaximo = Duration(seconds: 6);

  /// Posicion actual en el formato que espera el servidor, o null si no se pudo obtener.
  /// Solo [pedirPermiso] abre el dialogo de permiso (al salir al destino); el envio periodico nunca
  /// vuelve a preguntar, para no interrumpir al mecanico cada dos minutos.
  static Future<Map<String, dynamic>?> obtener({bool pedirPermiso = false}) async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return null;
      var permiso = await Geolocator.checkPermission();
      if (permiso == LocationPermission.denied && pedirPermiso) {
        permiso = await Geolocator.requestPermission();
      }
      if (permiso != LocationPermission.whileInUse && permiso != LocationPermission.always) return null;
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: _tiempoMaximo),
      );
      // la hora es la del telefono al obtener la posicion: el servidor la compara con la suya
      return cuerpoPosicion(
        latitud: p.latitude,
        longitud: p.longitude,
        precisionMetros: p.accuracy,
        capturadaEn: DateTime.now(),
      );
    } catch (_) {
      return null;
    }
  }

  /// Envia la posicion actual de la OT. No encola ni reintenta; nunca lanza.
  static Future<void> enviar(int ordenId) async {
    if (ordenId < 0) return; // una OT creada en terreno que aun no se sincroniza no existe en el servidor
    final cuerpo = await obtener();
    if (cuerpo == null) return;
    try {
      await ApiClient.instance.post('/api/ordenes-trabajo/$ordenId/posicion', cuerpo);
    } catch (_) {
      // sin senal, timeout o el servidor aun no ve la OT en camino (la tarea sigue en la cola): se descarta
    }
  }

  // ---- seguimiento en segundo plano ----

  /// Tope de seguridad: si por algun motivo nadie detiene el seguimiento, se apaga solo.
  static const _duracionMaxima = Duration(hours: 6);

  static StreamSubscription<Position>? _suscripcion;
  static Timer? _topeTimer;
  static int? _ordenSeguida;
  static DateTime? _ultimoEnvio;
  static ({double lat, double lng})? _ultimaEnviada;
  static DetectorLlegada? _detector;

  /// Id de la OT cuyo destino el mecanico ya alcanzo (se detecta en el telefono, con el destino de su
  /// propia OT: no se envia nada). Solo avisa; no cambia el estado de la OT. Una vez por OT.
  static final ValueNotifier<int?> llegada = ValueNotifier<int?>(null);

  /// Id de la OT que se esta siguiendo, o null.
  static int? get ordenSeguida => _ordenSeguida;

  /// Empieza a enviar la posicion de [ordenId] mientras va en camino. Llamarlo con la app visible
  /// (Android no deja arrancar un servicio de ubicacion desde segundo plano). Si ya se sigue esa OT
  /// no hace nada (salvo tomar el destino si antes no lo tenia); si se sigue otra, cambia. Con el
  /// destino ([destinoLat] y [destinoLng]) tambien detecta la llegada. Nunca lanza: sin permiso o sin
  /// GPS no pasa nada. Solo con [pedirPermiso] abre el dialogo de permiso; las llamadas automaticas
  /// no lo piden (al salir al destino ya se pidio una vez).
  static Future<void> iniciarSeguimiento(
    int ordenId, {
    double? destinoLat,
    double? destinoLng,
    bool pedirPermiso = false,
  }) async {
    if (ordenId < 0) return;
    if (_ordenSeguida == ordenId && _suscripcion != null) {
      _detector ??= _crearDetector(destinoLat, destinoLng);
      return;
    }
    await detenerSeguimiento();
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return;
      var permiso = await Geolocator.checkPermission();
      if (permiso == LocationPermission.denied && pedirPermiso) permiso = await Geolocator.requestPermission();
      if (permiso != LocationPermission.whileInUse && permiso != LocationPermission.always) return;

      final LocationSettings ajustes = Platform.isAndroid
          ? AndroidSettings(
              accuracy: LocationAccuracy.high,
              // sin filtro de distancia: llega una posicion por intervalo aunque este quieto, y la
              // regla de envio (utils/envio_posicion.dart) decide cuando mandarla (latido cada 5 min)
              distanceFilter: 0,
              intervalDuration: entreEnvios,
              foregroundNotificationConfig: const ForegroundNotificationConfig(
                notificationTitle: 'GOMAQ: en camino',
                notificationText: 'Enviando tu ubicacion mientras vas al destino.',
                notificationChannelName: 'Viaje en curso',
                setOngoing: true,
                enableWakeLock: true,
              ),
            )
          : const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 25);

      _ordenSeguida = ordenId;
      _detector = _crearDetector(destinoLat, destinoLng);
      _suscripcion = Geolocator.getPositionStream(locationSettings: ajustes).listen(
        (p) => _alLlegarPosicion(ordenId, p),
        onError: (_) {},
        cancelOnError: false,
      );
      _topeTimer = Timer(_duracionMaxima, detenerSeguimiento);
    } catch (_) {
      await detenerSeguimiento();
    }
  }

  /// Detector de llegada solo si el destino es una coordenada usable (una OT que ya estaba en el
  /// telefono antes de guardar el destino no lo tiene: simplemente no hay aviso).
  static DetectorLlegada? _crearDetector(double? lat, double? lng) {
    if (lat == null || lng == null || !coordenadaValida(lat, lng)) return null;
    return DetectorLlegada(destinoLat: lat, destinoLng: lng);
  }

  /// Apaga el servicio y la notificacion. Seguro de llamar aunque no haya nada corriendo.
  static Future<void> detenerSeguimiento() async {
    _topeTimer?.cancel();
    _topeTimer = null;
    final s = _suscripcion;
    _suscripcion = null;
    _ordenSeguida = null;
    _ultimoEnvio = null;
    _ultimaEnviada = null;
    _detector = null;
    llegada.value = null;
    try {
      await s?.cancel();
    } catch (_) {}
  }

  static Future<void> _alLlegarPosicion(int ordenId, Position p) async {
    final ahora = DateTime.now();
    // la llegada se evalua con cada posicion que entrega el telefono, se envie o no
    final detector = _detector;
    if (detector != null && _ordenSeguida == ordenId) {
      if (detector.evaluar(lat: p.latitude, lng: p.longitude, precisionM: p.accuracy, ahora: ahora)) {
        llegada.value = ordenId;
      }
    }
    if (!debeEnviarPosicion(
      ultimoEnvio: _ultimoEnvio,
      ultimaEnviada: _ultimaEnviada,
      lat: p.latitude,
      lng: p.longitude,
      ahora: ahora,
    )) {
      return;
    }
    _ultimoEnvio = ahora;
    _ultimaEnviada = (lat: p.latitude, lng: p.longitude);
    final cuerpo = cuerpoPosicion(
      latitud: p.latitude,
      longitud: p.longitude,
      precisionMetros: p.accuracy,
      capturadaEn: ahora,
    );
    if (cuerpo == null) return;
    try {
      final r = await ApiClient.instance.post('/api/ordenes-trabajo/$ordenId/posicion', cuerpo);
      // el servidor responde 200 con guardada:false cuando la OT ya no esta en camino (llego,
      // se finalizo o se reasigno): es la senal para apagar el servicio y la notificacion.
      if (r is Map && r['guardada'] == false && r['motivo'] == 'fuera_de_camino') {
        if (_ordenSeguida == ordenId) await detenerSeguimiento();
      }
    } catch (_) {
      // sin senal o timeout: se descarta, la siguiente posicion reemplaza a esta
    }
  }
}
