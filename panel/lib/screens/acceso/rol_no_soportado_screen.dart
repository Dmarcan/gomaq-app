import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';

/// Pantalla para roles que no tienen interfaz en la web (hoy: mecanico).
/// Antes un mecanico que entraba por navegador aterrizaba en el panel de
/// administracion con casi todas las secciones fallando por permisos.
class RolNoSoportadoScreen extends StatelessWidget {
  const RolNoSoportadoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: GomaqColors.fondoCalido,
      body: Center(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: SizedBox(
              width: 380,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.phone_android, size: 56, color: GomaqColors.primario),
                  const SizedBox(height: 16),
                  const Text('Tu cuenta es de mecánico', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  const Text(
                    'El trabajo de terreno se gestiona desde la aplicación móvil GOMAQ Mecánico, '
                    'que funciona incluso sin señal. Este panel web es para el equipo administrativo.\n\n'
                    'Si acabas de activar tu cuenta, ya está lista: en la app ingresa con este mismo correo y la contraseña que elegiste.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.black54),
                  ),
                  const SizedBox(height: 24),
                  OutlinedButton.icon(
                    onPressed: () => context.read<AuthService>().cerrarSesion(),
                    icon: const Icon(Icons.logout, size: 16),
                    label: const Text('Cerrar sesión'),
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
