import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/pendientes_service.dart';
import '../services/push_service.dart';
import 'boton_avisos.dart';

/// Envuelve la app (dentro de MaterialApp.router) y arranca los avisos push cuando hay una sesion de
/// administrativo, gerente o cliente. Sin config de Firebase no hace nada. Nunca pide permiso del
/// navegador: en la web eso lo hace el boton de avisos; en Android, un dialogo previo la primera vez.
class PushHost extends StatefulWidget {
  final Widget child;
  final GoRouter router;
  final GlobalKey<ScaffoldMessengerState> mensajesKey;
  const PushHost({super.key, required this.child, required this.router, required this.mensajesKey});

  @override
  State<PushHost> createState() => _PushHostState();
}

class _PushHostState extends State<PushHost> {
  bool _iniciado = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final auth = context.watch<AuthService>();
    final hayPanel = auth.autenticado && (auth.esCliente || auth.esAdministrativo || auth.esGerente);
    if (!hayPanel) {
      _iniciado = false; // el cierre de sesion ya soltó el token (AuthService)
    } else if (!_iniciado && PushService.instancia.configurado) {
      _iniciado = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _iniciar());
    }
  }

  void _iniciar() {
    if (!mounted) return;
    final auth = context.read<AuthService>();
    PushService.instancia.iniciar(
      explicarPermiso: () async {
        final c = widget.router.routerDelegate.navigatorKey.currentContext;
        return c != null && c.mounted ? mostrarDialogoPermisoAvisos(c) : false;
      },
      alAbrir: (m) => widget.router.go(rutaDeAviso(m.data, esCliente: auth.esCliente)),
      mostrarAviso: (m) {
        final texto = [m.titulo, m.cuerpo].whereType<String>().where((s) => s.isNotEmpty).join(': ');
        if (texto.isEmpty) return;
        widget.mensajesKey.currentState?.showSnackBar(snackBarAviso(texto));
      },
      // el cliente no tiene pendientes de gestion
      alRecibir: auth.esCliente ? null : () => PendientesService.instance.cargar(forzar: true),
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
