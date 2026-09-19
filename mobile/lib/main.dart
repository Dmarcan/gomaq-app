import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';
import 'services/auth_service.dart';
import 'services/connectivity_service.dart';
import 'services/sync_service.dart';
import 'screens/login_screen.dart';
import 'screens/ordenes_list_screen.dart';
import 'theme/gomaq_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Formato.fecha usa DateFormat con locale es_CL, y intl no trae esos datos hasta que se cargan:
  // sin esta linea, la pantalla que muestra una fecha fallaba con LocaleDataException.
  await initializeDateFormatting('es_CL');
  runApp(const GomaqMecanicoApp());
}

class GomaqMecanicoApp extends StatelessWidget {
  const GomaqMecanicoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthService()..restaurarSesion()),
        ChangeNotifierProvider(create: (_) => ConnectivityService()..iniciar()),
        ChangeNotifierProvider(create: (_) => SyncService()),
      ],
      child: MaterialApp(
        title: 'GOMAQ Mecánico',
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
    return auth.autenticado ? const OrdenesListScreen() : const LoginScreen();
  }
}
