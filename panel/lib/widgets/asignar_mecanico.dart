import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';
import 'dialogos.dart';

/// Abre el cuadro para asignar un mecánico a una orden. Devuelve `true` si se asignó.
Future<bool> abrirAsignarMecanico(BuildContext context, Map<String, dynamic> orden) async {
  final asignada = await showDialog<bool>(context: context, builder: (_) => AsignarMecanicoDialog(orden: orden));
  if (asignada == true && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('OT #${orden['id']} asignada')));
  }
  return asignada == true;
}

class AsignarMecanicoDialog extends StatefulWidget {
  final Map<String, dynamic> orden;
  const AsignarMecanicoDialog({super.key, required this.orden});

  @override
  State<AsignarMecanicoDialog> createState() => AsignarMecanicoState();
}

class AsignarMecanicoState extends State<AsignarMecanicoDialog> {
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
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No se pudo cargar la lista de mecánicos. Intenta de nuevo.')));
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _asignar(int mecanicoId) async {
    setState(() => _asignando = mecanicoId);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/asignar', {'mecanico_id': mecanicoId});
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } catch (_) {
      // sin red o plazo vencido: el cuadro sigue abierto y se puede reintentar
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No hubo respuesta del servidor. Revisa tu conexión e intenta de nuevo.')));
      }
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
                        : (m['ot_abiertas'].toString() == '1' ? '1 OT abierta' : '${m['ot_abiertas']} OT abiertas'),
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
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cerrar')),
      ],
    );
  }
}
