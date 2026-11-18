import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';
import 'router.dart';
import 'services/auth_service.dart';
import 'theme/gomaq_theme.dart';

Future<void> main() async {
  // URLs limpias, sin el "#" de la estrategia por hash. El backend devuelve index.html para toda
  // ruta fuera de /api (fallback de SPA en server.js), que es lo que necesita un F5 en /flota.
  usePathUrlStrategy();

  // Flutter Web deja apagada la capa de accesibilidad hasta que alguien encuentra un botón
  // oculto ("Enable accessibility"): un lector de pantalla no leía NADA del panel. Se enciende
  // desde el arranque para que el contenido exista en el árbol de accesibilidad del navegador.
  WidgetsFlutterBinding.ensureInitialized();
  if (kIsWeb) SemanticsBinding.instance.ensureSemantics();

  // Formato.fecha usa DateFormat con locale es_CL, y intl no trae esos datos hasta que se cargan:
  // sin esta linea, cualquier pantalla que mostrara una fecha (el historial de OT de un equipo,
  // por ejemplo) fallaba con LocaleDataException y quedaba en gris.
  await initializeDateFormatting('es_CL');

  runApp(const GomaqWebApp());
}

class GomaqWebApp extends StatelessWidget {
  const GomaqWebApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => AuthService()..restaurarSesion(),
      // el router se arma con el AuthService ya creado, para que su redirect pueda
      // reaccionar al login y al cierre de sesion
      child: Consumer<AuthService>(
        builder: (context, auth, _) => _AppConRouter(auth: auth),
      ),
    );
  }
}

/// Mantiene una sola instancia del router: rearmarlo en cada notificacion de AuthService
/// perderia la pila de navegacion en cada cambio de estado.
class _AppConRouter extends StatefulWidget {
  final AuthService auth;
  const _AppConRouter({required this.auth});

  @override
  State<_AppConRouter> createState() => _AppConRouterState();
}

class _AppConRouterState extends State<_AppConRouter> {
  late final _router = construirRouter(widget.auth);

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'GOMAQ · Panel de gestión',
      theme: construirTemaGomaq(),
      routerConfig: _router,
      // Sin esto los selectores de fecha y hora salían en inglés.
      locale: const Locale('es', 'CL'),
      supportedLocales: const [Locale('es', 'CL'), Locale('es')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }
}
