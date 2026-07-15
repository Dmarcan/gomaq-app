import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'api_client.dart';

class AuthService extends ChangeNotifier {
  bool _autenticado = false;
  bool _verificandoSesion = true;
  String? _rol;
  String? _nombre;
  int? _clienteId;

  bool get autenticado => _autenticado;
  bool get verificandoSesion => _verificandoSesion;
  String? get rol => _rol;
  String? get nombre => _nombre;
  int? get clienteId => _clienteId;

  bool get esGerente => _rol == 'gerente';
  bool get esAdministrativo => _rol == 'administrativo';
  bool get esCliente => _rol == 'cliente';

  Future<void> restaurarSesion() async {
    try {
      final token = await ApiClient.instance.leerToken();
      final usuarioJson = await ApiClient.instance.leerUsuario();
      if (token != null && usuarioJson != null) {
        final usuario = jsonDecode(usuarioJson);
        _rol = usuario['rol'];
        _nombre = usuario['nombre'];
        _clienteId = usuario['cliente_id'];
        _autenticado = true;
      } else {
        _autenticado = false;
      }
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
    await ApiClient.instance.guardarToken(data['token']);
    await ApiClient.instance.guardarUsuario(jsonEncode(data['usuario']));
    _rol = data['usuario']['rol'];
    _nombre = data['usuario']['nombre'];
    _clienteId = data['usuario']['cliente_id'];
    _autenticado = true;
    notifyListeners();
  }

  Future<void> logout() async {
    await ApiClient.instance.borrarToken();
    _autenticado = false;
    _rol = null;
    _nombre = null;
    _clienteId = null;
    notifyListeners();
  }
}
