import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'api_client.dart';
import 'push_service.dart';

class AuthService extends ChangeNotifier {
  AuthService() {
    // interceptor central: si el backend responde 401 estando logueado (token
    // expirado tras 12h), se cierra la sesion y el login muestra el motivo.
    // El guard de _autenticado evita que un intento de login fallido (tambien 401)
    // dispare el mensaje de "sesion expirada".
    ApiClient.onSesionExpirada = () {
      if (!_autenticado || _cerrando) return;
      _mensajeSesion = 'Tu sesión expiró, vuelve a iniciar sesión';
      logout();
    };
  }

  bool _autenticado = false;
  // true mientras se avisa al servidor del cierre de sesión: un 401 en ese aviso no es una sesión vencida
  bool _cerrando = false;
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

  /// El nombre cambió desde "Mi perfil y mis avisos": se actualiza aquí al instante y, en segundo plano, en el usuario
  /// guardado, para que el menú lo muestre ya y no recién al volver a entrar. No espera al almacenamiento: si falla,
  /// el nombre queda cambiado en esta sesión.
  void actualizarNombre(String nombre) {
    _nombre = nombre;
    notifyListeners();
    unawaited(_guardarNombre(nombre));
  }

  Future<void> _guardarNombre(String nombre) async {
    try {
      final guardado = await ApiClient.instance.leerUsuario();
      if (guardado == null) return;
      final usuario = jsonDecode(guardado);
      if (usuario is Map) {
        usuario['nombre'] = nombre;
        await ApiClient.instance.guardarUsuario(jsonEncode(usuario));
      }
    } catch (_) {
      // sin almacenamiento
    }
  }

  Future<void> login(String email, String password) async {
    final data = await ApiClient.instance.post('/api/auth/login', {
      'email': email,
      'password': password,
      'app': 'panel',
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

  /// "Olvidé mi contraseña": el servidor responde lo mismo exista o no la cuenta. Devuelve su mensaje.
  Future<String> pedirCodigoRecuperar(String email) async {
    final data = await ApiClient.instance.post('/api/auth/recuperar', {'email': email});
    return (data is Map && data['mensaje'] is String) ? data['mensaje'] as String : 'Si el correo es de una cuenta activa, te llegará un código.';
  }

  /// Canjea un código (invitación o recuperar) con la contraseña elegida y entra con ella.
  Future<void> canjearCodigo(String email, String codigo, String password) async {
    await ApiClient.instance.post('/api/auth/codigo/confirmar', {
      'email': email,
      'codigo': codigo,
      'password': password,
    });
    await login(email, password);
  }

  /// Cambia la contraseña propia. El servidor corta las otras sesiones y entrega un token nuevo para
  /// esta, así que no hay que volver a entrar.
  Future<void> cambiarPassword(String actual, String nueva) async {
    final data = await ApiClient.instance.post('/api/auth/cambiar-password', {'actual': actual, 'nueva': nueva});
    if (data is Map && data['token'] is String) {
      await ApiClient.instance.guardarToken(data['token'] as String);
    }
  }

  /// Cierre de sesión pedido por la persona: avisa al servidor para que la sesión deje de valer (con el
  /// token guardado todavía) y después borra lo local. Si no hay red, igual se cierra aquí; el servidor la
  /// vence por inactividad.
  Future<void> cerrarSesion({bool todosLosDispositivos = false}) async {
    _cerrando = true;
    // primero el aviso push (necesita la sesion vigente), despues el cierre en el servidor
    await PushService.instancia.alCerrarSesion(avisarServidor: true);
    try {
      await ApiClient.instance
          .post(todosLosDispositivos ? '/api/auth/logout-todas' : '/api/auth/logout', {})
          .timeout(const Duration(seconds: 3));
    } catch (_) {
      // sin red, sesión ya vencida o el servidor lento: se cierra igual
    } finally {
      _cerrando = false;
    }
    await logout();
  }

  Future<void> logout() async {
    // sesion vencida o cierre ya avisado: solo se suelta el token de Firebase de este equipo
    await PushService.instancia.alCerrarSesion(avisarServidor: false);
    await ApiClient.instance.borrarToken();
    _autenticado = false;
    _id = null;
    _rol = null;
    _nombre = null;
    _clienteId = null;
    notifyListeners();
  }
}
