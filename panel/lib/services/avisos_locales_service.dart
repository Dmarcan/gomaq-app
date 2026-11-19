import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../utils/avisos_locales.dart';
import 'notificacion_local.dart';
import 'push_service.dart' show PermisoAvisos;

/// Estado de los avisos locales (capa 1) en este navegador.
enum EstadoLocal { noSoportado, porActivar, activados, bloqueados }

/// Avisos con el panel abierto, sin Firebase (capa 1). Cada [cada] pide lo pendiente al servidor y, si algo
/// subió, muestra una notificación del navegador. Es lo que hacen WhatsApp Web o Meet: funciona aunque el
/// navegador no tenga el servicio de push de Google (Brave lo trae apagado).
///
/// - Solo consulta si la persona ya dio el permiso. NUNCA lo pide por su cuenta: solo [activar], desde un
///   toque ("Activar" del banner o de la campana).
/// - La primera lectura solo fija la base: no avisa de lo que ya estaba pendiente.
/// - No avisa con la pestaña a la vista y con foco (la persona ya mira el panel) ni cuando el push de
///   Firebase está activo en este equipo (el service worker ya muestra el mismo aviso).
class AvisosLocalesService {
  AvisosLocalesService({
    NotificacionLocal? plataforma,
    Future<String?> Function(String clave)? leerFlag,
    Future<void> Function(String clave, String valor)? guardarFlag,
  })  : _plataforma = plataforma ?? crearNotificacionLocal(),
        _leerFlag = leerFlag ?? ((c) => const FlutterSecureStorage().read(key: c)),
        _guardarFlag = guardarFlag ?? ((c, v) => const FlutterSecureStorage().write(key: c, value: v)) {
    estado = ValueNotifier(_calcularEstado());
  }

  static final AvisosLocalesService instancia = AvisosLocalesService();

  static const intervaloPorDefecto = Duration(seconds: 60);

  final NotificacionLocal _plataforma;
  final Future<String?> Function(String) _leerFlag;
  final Future<void> Function(String, String) _guardarFlag;

  late final ValueNotifier<EstadoLocal> estado;

  Timer? _temporizador;
  bool _revisando = false;
  int _generacion = 0;
  Object? _anterior;
  bool _esCliente = false;
  Future<Object?> Function()? _pedir;
  void Function(String ruta)? _alAbrir;
  bool Function()? _pushActivo;

  NotificacionLocal get plataforma => _plataforma;
  bool get soportado => _plataforma.soportada;

  EstadoLocal _calcularEstado() {
    if (!_plataforma.soportada) return EstadoLocal.noSoportado;
    return switch (_plataforma.permiso) {
      PermisoAvisos.concedido => EstadoLocal.activados,
      PermisoAvisos.denegado => EstadoLocal.bloqueados,
      PermisoAvisos.pendiente => EstadoLocal.porActivar,
    };
  }

  /// Se llama con la sesión abierta. [pedir] devuelve la lectura de lo pendiente (un mapa de contadores
  /// para administrativo y gerente, la lista de órdenes para el cliente); [alAbrir] navega a la ruta del
  /// aviso; [pushActivo] dice si el push de Firebase ya avisa en este equipo.
  void iniciar({
    required bool esCliente,
    required Future<Object?> Function() pedir,
    required void Function(String ruta) alAbrir,
    bool Function()? pushActivo,
    Duration cada = intervaloPorDefecto,
  }) {
    detener();
    _esCliente = esCliente;
    _pedir = pedir;
    _alAbrir = alAbrir;
    _pushActivo = pushActivo;
    _cada = cada;
    estado.value = _calcularEstado();
    if (estado.value == EstadoLocal.activados) _arrancar(cada);
  }

  Duration _cada = intervaloPorDefecto;

  void _arrancar(Duration cada) {
    _temporizador?.cancel();
    _anterior = null;
    unawaited(revisar()); // la primera lectura fija la base
    _temporizador = Timer.periodic(cada, (_) => unawaited(revisar()));
  }

  /// Toque de la persona: pide el permiso al navegador y, si lo da, empieza a vigilar.
  Future<void> activar() async {
    if (!_plataforma.soportada) return;
    try {
      await _plataforma.pedirPermiso();
    } catch (_) {}
    estado.value = _calcularEstado();
    if (estado.value == EstadoLocal.activados && _pedir != null) _arrancar(_cada);
  }

  /// Una lectura: compara con la anterior y avisa de lo que subió. Pública para las pruebas.
  Future<void> revisar() async {
    final pedir = _pedir;
    if (pedir == null || _revisando) return;
    if (_plataforma.permiso != PermisoAvisos.concedido) return;
    _revisando = true;
    final miGeneracion = _generacion;
    try {
      final lectura = await pedir();
      if (miGeneracion != _generacion) return; // llegó de una sesión anterior
      final antes = _anterior;
      _anterior = lectura;
      final avisos = _esCliente
          ? avisosDeOrdenesCliente(antes as List<dynamic>?, lectura as List<dynamic>?)
          : avisosDePendientes(antes as Map<String, dynamic>?, lectura as Map<String, dynamic>?);
      if (avisos.isEmpty) return;
      if (_plataforma.pestanaEnFoco || (_pushActivo?.call() ?? false)) return;
      for (final a in avisos.take(3)) {
        _plataforma.mostrar(titulo: a.titulo, cuerpo: a.cuerpo, tag: a.tag, alTocar: () => _alAbrir?.call(a.ruta));
      }
    } catch (_) {
      // sin red o dato inesperado: se conserva la base y se reintenta en el próximo ciclo
    } finally {
      _revisando = false;
    }
  }

  /// Cierre de sesión: deja de vigilar y olvida todo lo de la sesión anterior.
  void detener() {
    _generacion++;
    _temporizador?.cancel();
    _temporizador = null;
    _anterior = null;
    _pedir = null;
    _alAbrir = null;
    _pushActivo = null;
  }

  static String _claveAhoraNo(int? usuarioId) => 'avisos_ahora_no_${usuarioId ?? 0}';

  /// La invitación se ofrece si el navegador la admite, no se decidió todavía y la persona no dijo
  /// "Ahora no" en este navegador.
  Future<bool> debeInvitar(int? usuarioId) async {
    if (_calcularEstado() != EstadoLocal.porActivar) return false;
    try {
      return await _leerFlag(_claveAhoraNo(usuarioId)) == null;
    } catch (_) {
      return true;
    }
  }

  Future<void> recordarAhoraNo(int? usuarioId) async {
    try {
      await _guardarFlag(_claveAhoraNo(usuarioId), '1');
    } catch (_) {}
  }
}
