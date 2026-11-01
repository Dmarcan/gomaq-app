import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';

class AsignacionScreen extends StatefulWidget {
  const AsignacionScreen({super.key});

  @override
  State<AsignacionScreen> createState() => _AsignacionScreenState();
}

class _AsignacionScreenState extends State<AsignacionScreen> {
  List<dynamic> _ordenesSinAsignar = [];
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = (await ApiClient.instance.get('/api/ordenes-trabajo'))['items'];
      if (!mounted) return;
      setState(() => _ordenesSinAsignar = (data as List).where((o) => o['mecanico_id'] == null).toList());
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return EstadoError(titulo: 'No se pudieron cargar las órdenes', mensaje: _error!, onReintentar: _cargar);
    }
    if (_ordenesSinAsignar.isEmpty) {
      return const Center(child: Text('No hay órdenes de trabajo pendientes de asignar'));
    }

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _ordenesSinAsignar.length,
        itemBuilder: (context, i) {
          final o = _ordenesSinAsignar[i];
          return Card(
            child: ListTile(
              title: Text('OT #${o['id']} - ${o['maquinaria_codigo'] ?? ''}'),
              subtitle: Text('Cliente: ${o['cliente_nombre'] ?? '-'} · Motivo: ${o['motivo'] ?? '-'}'),
              trailing: const Icon(Icons.arrow_forward_ios, size: 14),
              onTap: () async {
                await showDialog(context: context, builder: (_) => _AsignarDialog(orden: o));
                _cargar();
              },
            ),
          );
        },
      ),
    );
  }
}

class _AsignarDialog extends StatefulWidget {
  final Map<String, dynamic> orden;
  const _AsignarDialog({required this.orden});

  @override
  State<_AsignarDialog> createState() => _AsignarDialogState();
}

class _AsignarDialogState extends State<_AsignarDialog> {
  List<dynamic> _mecanicos = [];
  bool _cargando = true;
  int? _asignando;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargarMecanicos());
  }

  Future<void> _cargarMecanicos() async {
    try {
      final data = await ApiClient.instance.get('/api/usuarios?rol=mecanico');
      if (mounted) setState(() => _mecanicos = data);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _asignar(int mecanicoId) async {
    setState(() => _asignando = mecanicoId);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/asignar', {'mecanico_id': mecanicoId});
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _asignando = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.orden;
    // se titulaba "Nueva orden de trabajo", pero no crea nada: asigna un mecánico a una orden que
    // ya existe. El nombre viejo mandaba a buscar el formulario de crear en el lugar equivocado.
    return CuadroDialogo(
      icono: Icons.engineering,
      titulo: 'Asignar mecánico',
      subtitulo: 'OT #${o['id']} · ${o['maquinaria_codigo'] ?? ''}',
      cuerpo: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: GomaqColors.primario.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('OT #${o['id']}', style: const TextStyle(fontSize: 12, color: GomaqColors.accion, fontWeight: FontWeight.bold)),
                  Text('${o['maquinaria_codigo'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.bold)),
                  Text('Cliente: ${o['cliente_nombre'] ?? '-'} · Motivo: ${o['motivo'] ?? '-'}'),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Text('MECÁNICOS DISPONIBLES', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            if (_cargando)
              const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))
            else
              for (final m in _mecanicos)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: CircleAvatar(child: Text((m['nombre'] as String).substring(0, 1))),
                  title: Text(m['nombre']),
                  subtitle: Text(
                    m['ot_abiertas'] == 0 || m['ot_abiertas'] == '0'
                        ? 'Sin OT abiertas'
                        : '${m['ot_abiertas']} OT abiertas',
                    style: TextStyle(
                      color: (m['ot_abiertas'] == 0 || m['ot_abiertas'] == '0') ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia,
                    ),
                  ),
                  // asignar es exclusivo de Administrativo (backend igual); el Gerente
                  // ve la lista como lectura con el boton deshabilitado y el motivo
                  trailing: context.watch<AuthService>().esAdministrativo
                      ? OutlinedButton(
                          onPressed: _asignando != null ? null : () => _asignar(m['id']),
                          child: _asignando == m['id']
                              ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                              : const Text('Asignar y Notificar'),
                        )
                      : const Tooltip(
                          message: 'Solo Administrativo asigna mecánicos',
                          child: OutlinedButton(onPressed: null, child: Text('Asignar y Notificar')),
                        ),
                ),
          ],
      ),
      acciones: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
      ],
    );
  }
}
