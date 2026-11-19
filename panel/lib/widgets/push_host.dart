import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/avisos_locales_service.dart';
import '../services/pendientes_service.dart';
import '../services/push_service.dart';
import 'boton_avisos.dart';

/// Envuelve la app (dentro de MaterialApp.router) y arranca los avisos cuando hay una sesion de
/// administrativo, gerente o cliente. Son dos capas independientes:
/// - capa 1 (siempre que el navegador tenga notificaciones): avisos locales con el panel abierto, sin Firebase;
/// - capa 2 (solo con config de Firebase): push, tambien con el navegador cerrado.
/// Nunca pide permiso del navegador por su cuenta: en la web lo hace el banner de invitacion o la campana,
/// y en Android un dialogo previo la primera vez.
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
      if (_iniciado) {
        // el cierre de sesion ya soltó el token (AuthService); aqui se apagan los avisos locales y la invitacion
        AvisosLocalesService.instancia.detener();
        widget.mensajesKey.currentState?.clearMaterialBanners();
      }
      _iniciado = false;
    } else if (!_iniciado && (PushService.instancia.configurado || AvisosLocalesService.instancia.soportado)) {
      _iniciado = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _iniciar());
    }
  }

  void _iniciar() {
    if (!mounted) return;
    final auth = context.read<AuthService>();
    final locales = AvisosLocalesService.instancia;
    final push = PushService.instancia;

    // capa 1
    if (locales.soportado) {
      locales.iniciar(
        esCliente: auth.esCliente,
        // el cliente lee sus ordenes (ya las consulta el portal); gestion lee los contadores del panel
        pedir: auth.esCliente
            ? () => ApiClient.instance.get('/api/ordenes-trabajo/mias')
            : () async {
                await PendientesService.instance.cargar(forzar: true);
                return PendientesService.instance.datos;
              },
        alAbrir: (ruta) => widget.router.go(ruta),
        // con el push activo en este equipo el service worker ya muestra el mismo aviso
        pushActivo: () => push.estado.value == EstadoAvisos.activados && push.tokenActual != null,
      );
      _invitar(auth.id);
    }

    // capa 2
    if (!push.configurado) return;
    push.iniciar(
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

  Future<void> _invitar(int? usuarioId) async {
    final locales = AvisosLocalesService.instancia;
    if (!await locales.debeInvitar(usuarioId)) return;
    final mensajes = widget.mensajesKey.currentState;
    if (!mounted || mensajes == null) return;
    mensajes.clearMaterialBanners();
    mensajes.showMaterialBanner(bannerInvitacionAvisos(
      alActivar: () async {
        mensajes.hideCurrentMaterialBanner();
        await activarAvisos(PushService.instancia, locales);
      },
      alDescartar: () async {
        mensajes.hideCurrentMaterialBanner();
        await locales.recordarAhoraNo(usuarioId);
      },
    ));
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
