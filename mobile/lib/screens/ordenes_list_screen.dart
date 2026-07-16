import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/auth_service.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
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
                    leading: const Icon(Icons.error_outline, color: Colors.red),
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
            icon: const Icon(Icons.logout),
            onPressed: () => context.read<AuthService>().logout(),
          ),
        ],
      ),
      body: Column(
        children: [
          if (sesionExpirada)
            Container(
              width: double.infinity,
              color: Colors.red.shade50,
              padding: const EdgeInsets.all(8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.lock_outline, size: 18, color: Colors.red),
                  const SizedBox(width: 6),
                  const Flexible(
                    child: Text(
                      'Tu sesion expiro - vuelve a iniciar sesion para sincronizar (tu trabajo esta guardado)',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                  TextButton(
                    onPressed: () => context.read<AuthService>().logout(),
                    child: const Text('Iniciar sesion', style: TextStyle(fontSize: 12)),
                  ),
                ],
              ),
            ),
          InkWell(
            onTap: _enError > 0 ? _mostrarErroresDeSync : null,
            child: Container(
              width: double.infinity,
              color: _enError > 0
                  ? Colors.red.shade50
                  : online
                      ? Colors.green.shade50
                      : Colors.orange.shade50,
              padding: const EdgeInsets.all(8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    _enError > 0
                        ? Icons.sync_problem
                        : online
                            ? Icons.cloud_done
                            : Icons.cloud_off,
                    size: 18,
                    color: _enError > 0
                        ? Colors.red
                        : online
                            ? Colors.green
                            : Colors.orange,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    sincronizando
                        ? 'Sincronizando...'
                        : _enError > 0
                            ? '$_enError cambios no se pudieron sincronizar - toca para reintentar'
                            : online
                                ? (_pendientes > 0 ? '$_pendientes cambios pendientes de sincronizar' : 'Todo sincronizado')
                                : 'Sin conexion - los cambios se guardan localmente',
                    style: const TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
          ),
          Expanded(
            child: _ordenes.isEmpty
                ? const Center(child: Text('No tienes ordenes de trabajo asignadas'))
                : RefreshIndicator(
                    onRefresh: _sincronizarSiHayConexion,
                    child: ListView.builder(
                      itemCount: _ordenes.length,
                      itemBuilder: (context, i) {
                        final orden = _ordenes[i];
                        return ListTile(
                          title: Text(orden.maquinariaCodigo ?? 'OT #${orden.id}'),
                          subtitle: Text(orden.motivo ?? ''),
                          trailing: Chip(
                            label: Text(orden.estado),
                            backgroundColor: GomaqColors.fondoChip(orden.estado),
                            labelStyle: TextStyle(color: GomaqColors.colorEstado(orden.estado)),
                          ),
                          onTap: () async {
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
