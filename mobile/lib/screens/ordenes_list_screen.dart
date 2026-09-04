import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/auth_service.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/orden_card.dart';
import '../widgets/sync_banner.dart';
import 'mi_cuenta_screen.dart';
import 'mi_furgon_screen.dart';
import 'orden_detail_screen.dart';

class OrdenesListScreen extends StatefulWidget {
  const OrdenesListScreen({super.key});

  @override
  State<OrdenesListScreen> createState() => _OrdenesListScreenState();
}

class _OrdenesListScreenState extends State<OrdenesListScreen> {
  List<OrdenTrabajo> _ordenes = [];
  int _pendientes = 0;
  int _enError = 0;
  StreamSubscription<bool>? _conexionSub;

  @override
  void initState() {
    super.initState();
    _cargarLocal();

    // SyncService.notifyListeners() no puede dispararse de forma sincronica
    // durante initState (todavia en fase de build) - se difiere al primer frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _sincronizarSiHayConexion();
      _conexionSub = context.read<ConnectivityService>().onCambioConexion.listen((online) {
        if (online) _sincronizarConReintentos();
      });
    });
  }

  @override
  void dispose() {
    _conexionSub?.cancel();
    super.dispose();
  }

  Future<void> _cargarLocal() async {
    final db = await LocalDatabase.instance.database;
    final rows = await db.query('ordenes_locales', orderBy: 'fecha_creacion DESC');
    if (!mounted) return;
    final syncService = context.read<SyncService>();
    final pendientes = await syncService.contarPendientes();
    final enError = await syncService.contarEnError();
    if (!mounted) return;
    setState(() {
      _ordenes = rows.map(OrdenTrabajo.fromLocalMap).toList();
      _pendientes = pendientes;
      _enError = enError;
    });
  }

  Future<void> _mostrarErroresDeSync() async {
    final syncService = context.read<SyncService>();
    final tareas = await syncService.tareasEnError();
    if (!mounted) return;
    await showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Cambios que no se pudieron sincronizar'),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final t in tareas)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    leading: const Icon(Icons.error_outline, color: GomaqColors.estadoNegativo),
                    title: Text('${t['tipo']} · OT #${t['orden_trabajo_id']}'),
                    subtitle: Text('${t['ultimo_error'] ?? 'Error desconocido'}', maxLines: 3, overflow: TextOverflow.ellipsis),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cerrar')),
          FilledButton(
            onPressed: () async {
              Navigator.pop(dialogContext);
              await syncService.reintentarErrores();
              _cargarLocal();
            },
            child: const Text('Reintentar todo'),
          ),
        ],
      ),
    );
  }

  // El sistema operativo suele avisar "conectado" un par de segundos antes
  // de que la red realmente tenga salida a internet. Reintenta un par de
  // veces con espera creciente para no depender de que el mecanico refresque a mano.
  Future<void> _sincronizarConReintentos() async {
    const esperas = [Duration(seconds: 2), Duration(seconds: 5), Duration(seconds: 10)];
    for (final espera in esperas) {
      await Future.delayed(espera);
      if (!mounted) return;
      final huboExito = await _sincronizarSiHayConexion();
      if (huboExito) return;
    }
  }

  Future<bool> _sincronizarSiHayConexion() async {
    if (!context.read<ConnectivityService>().online) return false;
    var exito = true;
    try {
      await context.read<SyncService>().sincronizar();
    } catch (_) {
      exito = false;
      // sin conexion real o backend no disponible: se reintenta despues, no rompe la UI
    }
    await _cargarLocal();
    return exito;
  }

  @override
  Widget build(BuildContext context) {
    final online = context.watch<ConnectivityService>().online;
    final syncService = context.watch<SyncService>();
    final sincronizando = syncService.sincronizando;
    final sesionExpirada = syncService.sesionExpirada;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Mis Ordenes de Trabajo'),
        actions: [
          IconButton(
            tooltip: 'Cerrar sesión',
            icon: const Icon(Icons.logout),
            onPressed: () => context.read<AuthService>().logout(),
          ),
        ],
      ),
      drawer: Drawer(
        backgroundColor: GomaqColors.fondoOscuro,
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.all(20),
                child: Text('GOMAQ',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: GomaqColors.primario)),
              ),
              ListTile(
                leading: const Icon(Icons.assignment_outlined),
                title: const Text('Mis órdenes'),
                onTap: () => Navigator.pop(context),
              ),
              ListTile(
                leading: const Icon(Icons.person_outline),
                title: const Text('Mi cuenta'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(builder: (_) => const MiCuentaScreen()));
                },
              ),
              ListTile(
                leading: const Icon(Icons.local_shipping_outlined),
                title: const Text('Mi furgón'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(builder: (_) => const MiFurgonScreen()));
                },
              ),
            ],
          ),
        ),
      ),
      body: Column(
        children: [
          if (sesionExpirada)
            SesionExpiradaBanner(onIniciarSesion: () => context.read<AuthService>().logout()),
          SyncBanner(
            online: online,
            sincronizando: sincronizando,
            pendientes: _pendientes,
            enError: _enError,
            onTapErrores: _mostrarErroresDeSync,
          ),
          Expanded(
            child: _ordenes.isEmpty
                ? const Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.assignment_outlined, size: 56, color: GomaqColors.textoSecundario),
                        SizedBox(height: 12),
                        Text(
                          'No tienes ordenes de trabajo asignadas',
                          style: TextStyle(color: GomaqColors.textoSecundario),
                        ),
                      ],
                    ),
                  )
                : RefreshIndicator(
                    onRefresh: _sincronizarSiHayConexion,
                    child: ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _ordenes.length,
                      itemBuilder: (context, i) {
                        final orden = _ordenes[i];
                        return OrdenCard(
                          orden: orden,
                          onAbrir: () async {
                            await Navigator.push(
                              context,
                              MaterialPageRoute(builder: (_) => OrdenDetailScreen(ordenId: orden.id)),
                            );
                            _cargarLocal();
                          },
                        );
                      },
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
