import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../services/api_client.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_vacio.dart';

class SolicitudesScreen extends StatefulWidget {
  /// 'pendiente' llega desde el dashboard: solo las asistencias por atender, que son las que ese número cuenta.
  final String? filtroInicial;
  const SolicitudesScreen({super.key, this.filtroInicial});

  @override
  State<SolicitudesScreen> createState() => _SolicitudesScreenState();
}

class _SolicitudesScreenState extends State<SolicitudesScreen> {
  List<dynamic> _solicitudes = [];
  bool _cargando = true;
  String? _error;
  bool _soloPendientes = false;

  @override
  void initState() {
    super.initState();
    _soloPendientes = widget.filtroInicial == 'pendiente';
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get(_soloPendientes ? '/api/solicitudes?estado=pendiente' : '/api/solicitudes');
      if (!mounted) return;
      setState(() => _solicitudes = data);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _convertir(int id) async {
    try {
      await ApiClient.instance.patch('/api/solicitudes/$id/convertir', {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Asistencia convertida en orden de trabajo')));
      }
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo convertir la asistencia: ${e.message}')));
    }
  }

  Widget _encabezadoFiltro() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Expanded(child: Text('Asistencias por atender: ${_solicitudes.length}', style: const TextStyle(fontSize: 13))),
          TextButton(
            onPressed: () => context.go('/asistencias'),
            child: const Text('Ver todas'),
          ),
        ],
      ),
    );
  }

  /// Foto que adjuntó el cliente al reportar la falla. La URL viene firmada por el backend
  /// y vence en una hora, porque el bucket es privado.
  Widget _adjunto(String url) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('FOTO ADJUNTA POR EL CLIENTE',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.black54)),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: Image.network(
              url,
              height: 180,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => const Text(
                'No se pudo cargar la imagen (el enlace pudo vencer, recarga la pantalla)',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
              loadingBuilder: (context, hijo, progreso) =>
                  progreso == null ? hijo : const SizedBox(height: 180, child: Center(child: CircularProgressIndicator())),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _cargar,
      child: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? EstadoError(titulo: 'No se pudieron cargar las asistencias', mensaje: _error!, onReintentar: _cargar)
              : _solicitudes.isEmpty
                  ? EstadoVacio(
                      icono: Icons.support_agent,
                      titulo: _soloPendientes ? 'No hay asistencias por atender' : 'No hay asistencias de clientes',
                      mensaje: 'Cuando un cliente reporte una falla o pida una mantención desde su portal, '
                          'aparecerá aquí para convertirla en orden de trabajo.',
                    )
                  : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _solicitudes.length + (_soloPendientes ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (_soloPendientes) {
                      if (i == 0) return _encabezadoFiltro();
                      i -= 1;
                    }
                    final s = _solicitudes[i];
                    return Card(
                      child: Column(
                        children: [
                          ListTile(
                            title: Text('${s['cliente_nombre']} - ${s['maquinaria_codigo']}'),
                            subtitle: Text(s['descripcion']),
                            trailing: s['estado'] == 'pendiente'
                                ? FilledButton(
                                    onPressed: () => _convertir(s['id']),
                                    child: const Text('Convertir en OT'),
                                  )
                                : EstadoChip(estado: s['estado']),
                          ),
                          if (s['evidencia_url'] != null) _adjunto(s['evidencia_url']),
                        ],
                      ),
                    );
                  },
                ),
    );
  }
}
