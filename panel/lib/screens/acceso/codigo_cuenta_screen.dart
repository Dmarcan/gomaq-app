import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInput;
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/validadores_acceso.dart';

/// Para qué se usa el código de 6 dígitos.
enum ModoCodigo {
  /// Cuenta interna invitada: la persona elige su contraseña y la cuenta queda activa (`/activar`).
  activar,

  /// "Olvidé mi contraseña" (`/recuperar`): primero se pide el código y después se canjea. También sirve
  /// el código que genera el administrador con "Contraseña" en la lista de cuentas.
  recuperar,
}

/// Canje de un código de la cuenta. Es pública: se llega desde el ingreso o desde el enlace del mensaje
/// (el enlace nunca lleva el código: la persona lo escribe).
class CodigoCuentaScreen extends StatefulWidget {
  final ModoCodigo modo;
  const CodigoCuentaScreen({super.key, required this.modo});

  @override
  State<CodigoCuentaScreen> createState() => _CodigoCuentaScreenState();
}

class _CodigoCuentaScreenState extends State<CodigoCuentaScreen> {
  final _formPedir = GlobalKey<FormState>();
  final _formCanje = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _codigoCtrl = TextEditingController();
  final _claveCtrl = TextEditingController();
  final _repetirCtrl = TextEditingController();

  late bool _pidiendoCodigo = widget.modo == ModoCodigo.recuperar;
  bool _cargando = false;
  bool _verClave = false;
  String? _aviso;
  String? _error;

  bool get _activar => widget.modo == ModoCodigo.activar;

  @override
  void dispose() {
    _emailCtrl.dispose();
    _codigoCtrl.dispose();
    _claveCtrl.dispose();
    _repetirCtrl.dispose();
    super.dispose();
  }

  Future<void> _ejecutar(Future<void> Function() accion) async {
    if (_cargando) return;
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      await accion();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'No se pudo conectar al servidor. Revisa tu conexión.');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _pedirCodigo() async {
    if (!(_formPedir.currentState?.validate() ?? false)) return;
    final auth = context.read<AuthService>();
    await _ejecutar(() async {
      final mensaje = await auth.pedirCodigoRecuperar(_emailCtrl.text.trim());
      if (!mounted) return;
      setState(() {
        _aviso = mensaje;
        _pidiendoCodigo = false;
      });
    });
  }

  Future<void> _canjear() async {
    if (!(_formCanje.currentState?.validate() ?? false)) return;
    final auth = context.read<AuthService>();
    await _ejecutar(() async {
      await auth.canjearCodigo(
        _emailCtrl.text.trim(),
        _codigoCtrl.text.replaceAll(RegExp(r'[\s-]'), ''),
        _claveCtrl.text,
      );
      // con la sesión iniciada el router lleva a cada rol a su pantalla
      TextInput.finishAutofillContext();
    });
  }

  @override
  Widget build(BuildContext context) {
    final titulo = _activar ? 'Activar mi cuenta' : 'Recuperar contraseña';
    return Scaffold(
      backgroundColor: GomaqColors.fondoCalido,
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 380),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Image.asset('assets/logo_gomaq_sobre_claro.png', height: 44, semanticLabel: 'GOMAQ'),
                    const SizedBox(height: 16),
                    Semantics(
                      header: true,
                      child: Text(titulo, textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _explicacion(),
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 13, color: Colors.grey.shade700, height: 1.4),
                    ),
                    const SizedBox(height: 20),
                    if (_aviso != null) _cajaAviso(_aviso!),
                    if (_pidiendoCodigo) _formularioPedir() else _formularioCanje(),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Semantics(
                          liveRegion: true,
                          child: Text(_error!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
                        ),
                      ),
                    const SizedBox(height: 12),
                    if (!_activar && _pidiendoCodigo)
                      TextButton(
                        onPressed: _cargando ? null : () => setState(() => _pidiendoCodigo = false),
                        child: const Text('Ya tengo un código'),
                      ),
                    TextButton(
                      onPressed: () => context.go('/login'),
                      child: const Text('Volver al ingreso'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _explicacion() {
    if (_activar) {
      return 'Escribe el correo con que GOMAQ creó tu cuenta y el código de 6 dígitos que te enviaron. '
          'Después elige tu contraseña.';
    }
    if (_pidiendoCodigo) {
      return 'Te enviaremos un código a tu correo. Si tu cuenta no tiene un correo real (algunos mecánicos), '
          'pide el código en la oficina de GOMAQ y toca "Ya tengo un código".';
    }
    return 'Escribe tu correo de acceso, el código de 6 dígitos y tu contraseña nueva.';
  }

  Widget _cajaAviso(String texto) => Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: Colors.green.shade50,
          border: Border.all(color: Colors.green.shade300),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Semantics(liveRegion: true, child: Text(texto, style: const TextStyle(fontSize: 13))),
      );

  Widget _campoCorreo({bool autofocus = false, TextInputAction accion = TextInputAction.next, VoidCallback? alEnviar}) =>
      TextFormField(
        controller: _emailCtrl,
        autofocus: autofocus,
        decoration: const InputDecoration(labelText: 'Correo de acceso', border: OutlineInputBorder()),
        keyboardType: TextInputType.emailAddress,
        autofillHints: const [AutofillHints.username, AutofillHints.email],
        textInputAction: accion,
        validator: validarCorreo,
        onFieldSubmitted: alEnviar == null ? null : (_) => alEnviar(),
      );

  Widget _formularioPedir() => Form(
        key: _formPedir,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _campoCorreo(autofocus: true, accion: TextInputAction.done, alEnviar: _pedirCodigo),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _cargando ? null : _pedirCodigo,
              child: _cargando ? _girando() : const Text('Enviar código'),
            ),
          ],
        ),
      );

  Widget _formularioCanje() => Form(
        key: _formCanje,
        child: AutofillGroup(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _campoCorreo(autofocus: _emailCtrl.text.isEmpty),
              const SizedBox(height: 14),
              TextFormField(
                controller: _codigoCtrl,
                autofocus: _emailCtrl.text.isNotEmpty,
                decoration: const InputDecoration(labelText: 'Código de 6 dígitos', border: OutlineInputBorder()),
                keyboardType: TextInputType.number,
                autofillHints: const [AutofillHints.oneTimeCode],
                textInputAction: TextInputAction.next,
                validator: validarCodigo,
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _claveCtrl,
                obscureText: !_verClave,
                decoration: InputDecoration(
                  labelText: 'Contraseña nueva',
                  helperText: 'Mínimo $largoMinimoPassword caracteres.',
                  border: const OutlineInputBorder(),
                  suffixIcon: IconButton(
                    tooltip: _verClave ? 'Ocultar contraseña' : 'Mostrar contraseña',
                    icon: Icon(_verClave ? Icons.visibility_off : Icons.visibility),
                    onPressed: () => setState(() => _verClave = !_verClave),
                  ),
                ),
                autofillHints: const [AutofillHints.newPassword],
                textInputAction: TextInputAction.next,
                validator: validarPasswordNueva,
              ),
              const SizedBox(height: 14),
              TextFormField(
                controller: _repetirCtrl,
                obscureText: !_verClave,
                decoration: const InputDecoration(labelText: 'Repetir contraseña', border: OutlineInputBorder()),
                autofillHints: const [AutofillHints.newPassword],
                validator: (v) => validarConfirmacion(v, _claveCtrl.text),
                onFieldSubmitted: (_) => _canjear(),
              ),
              const SizedBox(height: 18),
              FilledButton(
                onPressed: _cargando ? null : _canjear,
                child: _cargando ? _girando() : Text(_activar ? 'Activar mi cuenta' : 'Cambiar contraseña'),
              ),
            ],
          ),
        ),
      );

  Widget _girando() => const SizedBox(
        height: 20,
        width: 20,
        child: CircularProgressIndicator(strokeWidth: 2, semanticsLabel: 'Enviando'),
      );
}
