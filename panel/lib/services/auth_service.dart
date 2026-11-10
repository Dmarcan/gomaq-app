import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'api_client.dart';

class AuthService extends ChangeNotifier {
  AuthService() {
    // interceptor central: si el backend responde 401 estando logueado (token
    // expirado tras 12h), se cierra la sesion y el login muestra el motivo.
    // El guard de _autenticado evita que un intento de login fallido (tambien 401)
    // dispare el mensaje de "sesion expirada".
    ApiClient.onSesionExpirada = () {
      if (!_autenticado) return;
      _mensajeSesion = 'Tu sesión expiró, vuelve a iniciar sesión';
      logout();
    };
  }

  bool _autenticado = false;
  bool _verificandoSesion = true;
  int? _id;
  String? _rol;
  String? _nombre;
  int? _clienteId;
  String? _mensajeSesion;

  bool get autenticado => _autenticado;
  bool get verificandoSesion => _verificandoSesion;
  /// Id de la cuenta que inició sesión (se restaura con la sesión guardada).
  int? get id => _id;
  String? get rol => _rol;
  String? get nombre => _nombre;
  int? get clienteId => _clienteId;
  String? get mensajeSesion => _mensajeSesion;

  bool get esGerente => _rol == 'gerente';
  bool get esAdministrativo => _rol == 'administrativo';
  bool get esCliente => _rol == 'cliente';

  Future<void> restaurarSesion() async {
    try {
      final token = await ApiClient.instance.leerToken();
      final usuarioJson = await ApiClient.instance.leerUsuario();
      if (token != null && usuarioJson != null) {
        final usuario = jsonDecode(usuarioJson);
        _id = usuario['id'] is num ? (usuario['id'] as num).toInt() : null;
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
    _id = data['usuario']['id'] is num ? (data['usuario']['id'] as num).toInt() : null;
    _rol = data['usuario']['rol'];
    _nombre = data['usuario']['nombre'];
    _clienteId = data['usuario']['cliente_id'];
    _autenticado = true;
    _mensajeSesion = null;
    notifyListeners();
  }

  Future<void> logout() async {
    await ApiClient.instance.borrarToken();
    _autenticado = false;
    _id = null;
    _rol = null;
    _nombre = null;
    _clienteId = null;
    notifyListeners();
  }
}
