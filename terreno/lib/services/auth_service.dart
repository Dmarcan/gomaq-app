import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';
import '../db/local_database.dart';
import '../utils/cambios.dart';
import 'api_client.dart';
import 'posicion_service.dart';

class AuthService extends ChangeNotifier {
  bool _autenticado = false;
  bool _verificandoSesion = true;
  String? _rol;
  String? _nombre;

  bool get autenticado => _autenticado;
  bool get verificandoSesion => _verificandoSesion;
  String? get rol => _rol;
  String? get nombre => _nombre;

  Future<void> restaurarSesion() async {
    try {
      final token = await ApiClient.instance.leerToken();
      _autenticado = token != null;
    } catch (_) {
      _autenticado = false;
    }
    _verificandoSesion = false;
    notifyListeners();
  }

  Future<void> login(String email, String password) async {
    final data = await ApiClient.instance.post('/api/auth/login', {
      'email': email,
      'password': password,
    });
    // esta app es exclusiva del rol mecanico: cualquier otro rol veria pantallas
    // que le fallan (y podria encolar cambios que el backend siempre rechazara)
    if (data['usuario']['rol'] != 'mecanico') {
      throw ApiException(403, 'Esta aplicación es solo para mecánicos. Usa el panel web.');
    }
    await _verificarDuenoDelTelefono(data['usuario']);
    await ApiClient.instance.guardarToken(data['token']);
    _rol = data['usuario']['rol'];
    _nombre = data['usuario']['nombre'];
    _autenticado = true;
    notifyListeners();
  }

  /// El trabajo guardado en el telefono es de quien lo hizo.
  ///
  /// Si otro mecanico inicia sesion en el mismo equipo, los cambios pendientes del anterior no
  /// pueden enviarse con su cuenta: el servidor los rechazaria (las OT no son suyas) o, peor,
  /// quedarian registrados a su nombre. Con cambios pendientes se bloquea el ingreso y se
  /// explica por que; sin cambios, se limpia el telefono para que no vea las OT del anterior.
  Future<void> _verificarDuenoDelTelefono(Map<String, dynamic> usuario) async {
    final db = LocalDatabase.instance;
    final usuarioId = usuario['id'].toString();
    final dueno = await db.leerSesion('usuario_id');

    if (dueno != null && dueno != usuarioId) {
      final conexion = await db.database;
      final pendientes = Sqflite.firstIntValue(await conexion.rawQuery(
            "SELECT COUNT(*) FROM cola_sincronizacion WHERE estado IN ('pendiente', 'error')",
          )) ??
          0;
      if (pendientes > 0) {
        final nombreAnterior = await db.leerSesion('usuario_nombre') ?? 'otra cuenta';
        throw ApiException(
          409,
          'Este teléfono tiene ${textoCambios(pendientes)} sin enviar de $nombreAnterior. '
          'Esa persona debe iniciar sesión y sincronizar antes de que otra cuenta use el teléfono.',
        );
      }
      await db.limpiarDatosDeUsuario();
    }

    await db.guardarSesion('usuario_id', usuarioId);
    await db.guardarSesion('usuario_nombre', (usuario['nombre'] ?? '').toString());
  }

  Future<void> logout() async {
    await PosicionService.detenerSeguimiento();
    await ApiClient.instance.borrarToken();
    _autenticado = false;
    _rol = null;
    _nombre = null;
    notifyListeners();
  }
}
