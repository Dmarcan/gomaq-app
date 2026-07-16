import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'services/auth_service.dart';
import 'screens/login_screen.dart';
import 'screens/admin_dashboard_screen.dart';
import 'screens/cliente_portal_screen.dart';
import 'screens/rol_no_soportado_screen.dart';
import 'theme/gomaq_theme.dart';

void main() {
  runApp(const GomaqWebApp());
}

class GomaqWebApp extends StatelessWidget {
  const GomaqWebApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => AuthService()..restaurarSesion(),
      child: MaterialApp(
        title: 'GOMAQ - Panel de Gestion',
        theme: construirTemaGomaq(),
        home: const _Raiz(),
      ),
    );
  }
}

class _Raiz extends StatelessWidget {
  const _Raiz();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    if (auth.verificandoSesion) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!auth.autenticado) {
      return const LoginScreen();
    }
    // enrutado explicito por rol: solo los roles con interfaz web entran a sus
    // pantallas; el resto (mecanico) recibe una explicacion en vez de un panel roto
    if (auth.esCliente) return const ClientePortalScreen();
    if (auth.esAdministrativo || auth.esGerente) return const AdminDashboardScreen();
    return const RolNoSoportadoScreen();
  }
}
