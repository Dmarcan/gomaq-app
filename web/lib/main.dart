import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'services/auth_service.dart';
import 'screens/login_screen.dart';
import 'screens/admin_dashboard_screen.dart';
import 'screens/cliente_portal_screen.dart';

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
        theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepOrange), useMaterial3: true),
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
    return auth.esCliente ? const ClientePortalScreen() : const AdminDashboardScreen();
  }
}
