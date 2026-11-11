import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInput;
import 'package:gomaq_comun/gomaq_comun.dart'
    show UsuarioDemo, usuarioDemoMecanico;
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/api_client.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/logo_gomaq.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _cargando = false;
  bool _verPassword = false;
  String? _error;

  Future<void> _iniciarSesion() async {
    if (_cargando) return;
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final syncService = context.read<SyncService>();
      await context.read<AuthService>().login(
        _emailCtrl.text.trim(),
        _passwordCtrl.text,
      );
      // el aviso de "sesion expirada" ya no aplica tras un login exitoso
      syncService.reiniciarSesion();
      // el teléfono ofrece guardar la contraseña solo si el ingreso salió bien
      TextInput.finishAutofillContext();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(
        () => _error = 'No se pudo conectar al servidor. Revisa tu conexión.',
      );
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  // Inicio rapido de pruebas: rellena las credenciales del mecanico demo y entra. Ver
  // comun/lib/usuarios_demo.dart (quitar antes de usar el sistema con datos reales).
  Future<void> _inicioRapido(UsuarioDemo usuario) {
    _emailCtrl.text = usuario.email;
    _passwordCtrl.text = usuario.clave;
    return _iniciarSesion();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: AutofillGroup(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const LogoGomaq(),
                  const SizedBox(height: 16),
                  Semantics(
                    header: true,
                    child: const Text(
                      'ACCESO A GOMAQ',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 1,
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Ingresa tus credenciales de mecánico',
                    style: TextStyle(
                      fontSize: 13,
                      color: GomaqColors.textoSecundario,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: GomaqColors.superficieElevada,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: GomaqColors.bordeSutil),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.cloud_off,
                          size: 13,
                          color: GomaqColors.textoSecundario,
                        ),
                        SizedBox(width: 5),
                        Text(
                          'Funciona sin conexión',
                          style: TextStyle(
                            fontSize: 12,
                            color: GomaqColors.textoSecundario,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 28),
                  TextField(
                    controller: _emailCtrl,
                    decoration: const InputDecoration(labelText: 'Correo'),
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [
                      AutofillHints.username,
                      AutofillHints.email,
                    ],
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _passwordCtrl,
                    decoration: InputDecoration(
                      labelText: 'Contraseña',
                      suffixIcon: IconButton(
                        tooltip: _verPassword
                            ? 'Ocultar contraseña'
                            : 'Mostrar contraseña',
                        icon: Icon(
                          _verPassword
                              ? Icons.visibility_off
                              : Icons.visibility,
                        ),
                        onPressed: () =>
                            setState(() => _verPassword = !_verPassword),
                      ),
                    ),
                    obscureText: !_verPassword,
                    autofillHints: const [AutofillHints.password],
                    onSubmitted: (_) => _iniciarSesion(),
                  ),
                  const SizedBox(height: 24),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      // liveRegion: el lector de pantalla anuncia el error apenas aparece
                      child: Semantics(
                        liveRegion: true,
                        child: Text(
                          _error!,
                          style: const TextStyle(
                            color: GomaqColors.estadoNegativo,
                          ),
                        ),
                      ),
                    ),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _cargando ? null : _iniciarSesion,
                      child: _cargando
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                semanticsLabel: 'Ingresando',
                              ),
                            )
                          : const Text('Ingresar'),
                    ),
                  ),
                  const Divider(height: 32),
                  Text(
                    'Inicio rápido (solo pruebas)',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      onPressed: _cargando
                          ? null
                          : () => _inicioRapido(usuarioDemoMecanico),
                      child: Text(usuarioDemoMecanico.rotulo),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
