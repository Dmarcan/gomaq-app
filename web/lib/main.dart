import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:provider/provider.dart';
import 'router.dart';
import 'services/auth_service.dart';
import 'theme/gomaq_theme.dart';

void main() {
  // URLs limpias, sin el "#" de la estrategia por hash. El backend ya devuelve index.html
  // para cualquier ruta que no sea /api (el fallback de SPA en server.js), que es justo lo
  // que esta estrategia necesita para que un F5 en /flota no termine en un 404.
  usePathUrlStrategy();

  // Flutter Web deja apagada la capa de accesibilidad hasta que alguien encuentra un botón
  // oculto ("Enable accessibility"): un lector de pantalla no leía NADA del panel. Se enciende
  // desde el arranque para que el contenido exista en el árbol de accesibilidad del navegador.
  WidgetsFlutterBinding.ensureInitialized();
  SemanticsBinding.instance.ensureSemantics();

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
      title: 'GOMAQ - Panel de Gestión',
      theme: construirTemaGomaq(),
      routerConfig: _router,
    );
  }
}
