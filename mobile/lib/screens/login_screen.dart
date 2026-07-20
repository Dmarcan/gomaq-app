import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/api_client.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';

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
      final syncService = context.read<SyncService>();
      await context.read<AuthService>().login(_emailCtrl.text.trim(), _passwordCtrl.text);
      // el aviso de "sesion expirada" ya no aplica tras un login exitoso
      syncService.reiniciarSesion();
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
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(color: GomaqColors.primario, borderRadius: BorderRadius.circular(16)),
                child: const Icon(Icons.build, color: Colors.white, size: 36),
              ),
              const SizedBox(height: 12),
              const Text(
                'ACCESO A GOMAQ',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, letterSpacing: 1),
              ),
              const SizedBox(height: 6),
              const Text(
                'Ingresa tus credenciales de mecánico',
                style: TextStyle(fontSize: 13, color: GomaqColors.textoSecundario),
              ),
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: GomaqColors.superficieElevada,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: GomaqColors.bordeSutil),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.cloud_off, size: 13, color: GomaqColors.textoSecundario),
                    SizedBox(width: 5),
                    Text('Funciona sin conexión', style: TextStyle(fontSize: 11, color: GomaqColors.textoSecundario)),
                  ],
                ),
              ),
              const SizedBox(height: 28),
              TextField(
                controller: _emailCtrl,
                decoration: const InputDecoration(labelText: 'Correo'),
                keyboardType: TextInputType.emailAddress,
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _passwordCtrl,
                decoration: const InputDecoration(labelText: 'Contraseña'),
                obscureText: true,
              ),
              const SizedBox(height: 24),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(_error!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
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
            ],
          ),
        ),
      ),
    );
  }
}
