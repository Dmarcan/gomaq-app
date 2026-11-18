import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInput;
import 'package:gomaq_comun/gomaq_comun.dart' show UsuarioDemo, usuarioDemoAdministrativo, usuarioDemoCliente;
import 'package:provider/provider.dart';
import '../../services/auth_service.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import 'package:go_router/go_router.dart';

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
      await context.read<AuthService>().login(_emailCtrl.text.trim(), _passwordCtrl.text);
      // el navegador o el teléfono ofrecen guardar la contraseña solo si el ingreso salió bien
      TextInput.finishAutofillContext();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'No se pudo conectar al servidor. Revisa tu conexión.');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  // Inicio rapido de pruebas: rellena las credenciales del usuario demo y entra. Ver
  // comun/lib/usuarios_demo.dart (quitar antes de usar el sistema con datos reales).
  Future<void> _inicioRapido(UsuarioDemo usuario) {
    _emailCtrl.text = usuario.email;
    _passwordCtrl.text = usuario.clave;
    return _iniciarSesion();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: GomaqColors.fondoCalido,
      body: Center(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: SizedBox(
              width: 360,
              child: SingleChildScrollView(
                child: AutofillGroup(
                  child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Image.asset('assets/logo_gomaq_sobre_claro.png', width: 200, semanticLabel: 'GOMAQ'),
                  const SizedBox(height: 16),
                  Text('Ingreso para clientes y personal de GOMAQ', textAlign: TextAlign.center, style: TextStyle(fontSize: 14, color: Colors.grey.shade700)),
                  const SizedBox(height: 32),
                  if (context.watch<AuthService>().mensajeSesion != null)
                    Container(
                      width: double.infinity,
                      margin: const EdgeInsets.only(bottom: 16),
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: Colors.amber.shade50,
                        border: Border.all(color: Colors.amber.shade200),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        context.watch<AuthService>().mensajeSesion!,
                        style: const TextStyle(fontSize: 13),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  TextField(
                    controller: _emailCtrl,
                    decoration: const InputDecoration(labelText: 'Correo', border: OutlineInputBorder()),
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.username, AutofillHints.email],
                    textInputAction: TextInputAction.next,
                    // "Siguiente" pasa a la contrasena (Flutter ya mueve el foco con
                    // TextInputAction.next; llamar ademas a nextFocus lo moveria dos veces).
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _passwordCtrl,
                    decoration: InputDecoration(
                      labelText: 'Contraseña',
                      border: const OutlineInputBorder(),
                      suffixIcon: IconButton(
                        tooltip: _verPassword ? 'Ocultar contraseña' : 'Mostrar contraseña',
                        icon: Icon(_verPassword ? Icons.visibility_off : Icons.visibility),
                        onPressed: () => setState(() => _verPassword = !_verPassword),
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
                        child: Text(_error!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
                      ),
                    ),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _cargando ? null : _iniciarSesion,
                      child: _cargando
                          ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Ingresar'),
                    ),
                  ),
                  TextButton(
                    onPressed: () => context.go('/recuperar'),
                    child: const Text('¿Olvidaste tu contraseña?'),
                  ),
                  TextButton(
                    onPressed: () => context.go('/activar'),
                    child: const Text('Tengo un código de invitación'),
                  ),
                  TextButton(
                    onPressed: () => context.go('/registro'),
                    child: const Text('¿Eres cliente? Crea tu cuenta'),
                  ),
                  const Divider(height: 32),
                  Text('Inicio rápido (solo pruebas)', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _cargando ? null : () => _inicioRapido(usuarioDemoAdministrativo),
                          child: Text(usuarioDemoAdministrativo.rotulo),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _cargando ? null : () => _inicioRapido(usuarioDemoCliente),
                          child: Text(usuarioDemoCliente.rotulo),
                        ),
                      ),
                    ],
                  ),
                ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
