import 'package:flutter/foundation.dart';
import 'api_client.dart';

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
      throw ApiException(403, 'Esta aplicacion es solo para mecanicos. Usa el panel web.');
    }
    await ApiClient.instance.guardarToken(data['token']);
    _rol = data['usuario']['rol'];
    _nombre = data['usuario']['nombre'];
    _autenticado = true;
    notifyListeners();
  }

  Future<void> logout() async {
    await ApiClient.instance.borrarToken();
    _autenticado = false;
    _rol = null;
    _nombre = null;
    notifyListeners();
  }
}
