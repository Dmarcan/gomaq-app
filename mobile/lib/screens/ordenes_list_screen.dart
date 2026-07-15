import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/auth_service.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import 'orden_detail_screen.dart';

class OrdenesListScreen extends StatefulWidget {
  const OrdenesListScreen({super.key});

  @override
  State<OrdenesListScreen> createState() => _OrdenesListScreenState();
}

class _OrdenesListScreenState extends State<OrdenesListScreen> {
  List<OrdenTrabajo> _ordenes = [];
  int _pendientes = 0;

  @override
  void initState() {
    super.initState();
    _cargarLocal();
    _sincronizarSiHayConexion();
  }

  Future<void> _cargarLocal() async {
    final db = await LocalDatabase.instance.database;
    final rows = await db.query('ordenes_locales', orderBy: 'fecha_creacion DESC');
    if (!mounted) return;
    final pendientes = await context.read<SyncService>().contarPendientes();
    if (!mounted) return;
    setState(() {
      _ordenes = rows.map(OrdenTrabajo.fromLocalMap).toList();
      _pendientes = pendientes;
    });
  }

  Future<void> _sincronizarSiHayConexion() async {
    if (!context.read<ConnectivityService>().online) return;
    try {
      await context.read<SyncService>().sincronizar();
    } catch (_) {
      // sin conexion real o backend no disponible: se reintenta despues, no rompe la UI
    }
    await _cargarLocal();
  }

  @override
  Widget build(BuildContext context) {
    final online = context.watch<ConnectivityService>().online;
    final sincronizando = context.watch<SyncService>().sincronizando;

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
          Container(
            width: double.infinity,
            color: online ? Colors.green.shade50 : Colors.orange.shade50,
            padding: const EdgeInsets.all(8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(online ? Icons.cloud_done : Icons.cloud_off,
                    size: 18, color: online ? Colors.green : Colors.orange),
                const SizedBox(width: 6),
                Text(
                  sincronizando
                      ? 'Sincronizando...'
                      : online
                          ? (_pendientes > 0 ? '$_pendientes cambios pendientes de sincronizar' : 'Todo sincronizado')
                          : 'Sin conexion - los cambios se guardan localmente',
                  style: const TextStyle(fontSize: 12),
                ),
              ],
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
                          trailing: Chip(label: Text(orden.estado)),
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
