import 'dart:async';
import 'package:flutter/foundation.dart';
import '../widgets/estado_vacio.dart' show mensajeErrorCarga;
import 'api_client.dart';

/// Los números de `GET /api/dashboard/pendientes`, compartidos entre el dashboard y los contadores del
/// menú lateral.
///
/// - Caché de 5 minutos: cambiar de sección no vuelve a calcularlos (el servidor recorre todas las guías
///   para contar los arriendos).
/// - [invalidar]: cualquier escritura exitosa (asignar, aprobar una cuenta, facturar, ajustar stock...)
///   deja el dato como viejo y lo vuelve a pedir, con una pequeña espera para juntar varias seguidas.
/// - [limpiar]: al cerrar sesión. Una respuesta que llegue de la sesión anterior se descarta.
/// - Un [cargar] forzado mientras hay otro en curso no se pierde: se repite al terminar.
class PendientesService extends ChangeNotifier {
  PendientesService({this.esperaInvalidar = const Duration(milliseconds: 800), Future<dynamic> Function()? pedir})
      : _pedir = pedir ?? (() => ApiClient.instance.get('/api/dashboard/pendientes'));

  static final PendientesService instance = _crear();

  static PendientesService _crear() {
    final s = PendientesService();
    s._registrarEnApi();
    return s;
  }

  /// Cuánto vale un dato antes de volver a pedirlo desde el menú.
  static const Duration vigencia = Duration(minutes: 5);

  /// Espera antes de volver a pedir tras una escritura, para juntar varias seguidas en una sola consulta.
  final Duration esperaInvalidar;
  final Future<dynamic> Function() _pedir;

  Map<String, dynamic>? datos;
  DateTime? cargadoEn;
  String? error;
  bool cargando = false;

  int _generacion = 0;
  bool _repetir = false;
  Timer? _temporizador;

  void _registrarEnApi() {
    ApiClient.alEscribir = invalidar;
  }

  /// Lo pide el servidor otra vez solo si pasó la vigencia, o siempre con [forzar].
  Future<void> cargar({bool forzar = false}) async {
    if (cargando) {
      // no se pierde: al terminar la consulta en curso se hace otra con datos más nuevos
      if (forzar) _repetir = true;
      return;
    }
    final vigente = cargadoEn != null && DateTime.now().difference(cargadoEn!) < vigencia;
    if (!forzar && vigente && error == null) return;
    final miGeneracion = _generacion;
    cargando = true;
    error = null;
    notifyListeners();
    try {
      final r = await _pedir();
      if (miGeneracion != _generacion) return; // llegó de una sesión anterior
      datos = Map<String, dynamic>.from(r as Map);
      cargadoEn = DateTime.now();
    } catch (e) {
      if (miGeneracion != _generacion) return;
      // sin red o dato inesperado: se conserva lo último que hubo y se avisa del error
      error = mensajeErrorCarga(e);
    } finally {
      if (miGeneracion == _generacion) {
        cargando = false;
        notifyListeners();
        if (_repetir) {
          _repetir = false;
          unawaited(cargar(forzar: true));
        }
      }
    }
  }

  /// Algo cambió en el servidor: el dato queda como viejo y se vuelve a pedir en un momento.
  void invalidar() {
    cargadoEn = null;
    _temporizador?.cancel();
    _temporizador = Timer(esperaInvalidar, () => unawaited(cargar(forzar: true)));
  }

  /// Fija los datos sin pasar por el servidor (pruebas, o un error simulado).
  void fijar({Map<String, dynamic>? nuevos, String? mensajeError}) {
    datos = nuevos;
    error = mensajeError;
    cargadoEn = nuevos == null ? null : DateTime.now();
    notifyListeners();
  }

  /// Cierre de sesión: olvida lo cargado y descarta lo que esté en camino.
  void limpiar() {
    _generacion++;
    _repetir = false;
    _temporizador?.cancel();
    datos = null;
    cargadoEn = null;
    error = null;
    cargando = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _temporizador?.cancel();
    super.dispose();
  }
}
