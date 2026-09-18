import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
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
  String? _error;

  Future<void> _iniciarSesion() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      await context.read<AuthService>().login(_emailCtrl.text.trim(), _passwordCtrl.text);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'No se pudo conectar al servidor. Revisa tu conexion.');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
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
                child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(color: GomaqColors.primario, borderRadius: BorderRadius.circular(14)),
                    child: const Icon(Icons.business, color: Colors.white, size: 32),
                  ),
                  const SizedBox(height: 12),
                  const Text('GOMAQ', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold)),
                  Text('Panel de Gestión', style: TextStyle(fontSize: 14, color: Colors.grey.shade700)),
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
                    onSubmitted: (_) => _iniciarSesion(),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _passwordCtrl,
                    decoration: const InputDecoration(labelText: 'Contraseña', border: OutlineInputBorder()),
                    obscureText: true,
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
                    onPressed: () => context.go('/registro'),
                    child: const Text('¿Eres cliente? Crea tu cuenta'),
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
}
