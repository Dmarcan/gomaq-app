import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../utils/formato.dart';

/// Ordenes que la oficina o un cliente crearon y todavia no tienen mecanico. El mecanico las ve y
/// puede tomar la que le toque. Solo con senal, a proposito: tomar una orden tiene que decidirse en
/// el servidor en el momento, para que dos mecanicos no queden con la misma (el segundo recibe un
/// aviso y la orden desaparece de su lista).
class OrdenesDisponiblesScreen extends StatefulWidget {
  const OrdenesDisponiblesScreen({super.key});

  /// Cuantas ordenes hay sin asignar, o null si no se pudo consultar (sin senal).
  static Future<int?> contar() async {
    try {
      final r = await ApiClient.instance.get('/api/ordenes-trabajo?sin_asignar=1&limit=1');
      return (r['total'] as num?)?.toInt() ?? (r['items'] as List?)?.length;
    } catch (_) {
      return null;
    }
  }

  @override
  State<OrdenesDisponiblesScreen> createState() => _OrdenesDisponiblesScreenState();
}

class _OrdenesDisponiblesScreenState extends State<OrdenesDisponiblesScreen> {
  List<Map<String, dynamic>> _ordenes = [];
  bool _cargando = true;
  String? _error;
  int? _tomando;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final r = await ApiClient.instance.get('/api/ordenes-trabajo?sin_asignar=1');
      final items = (r['items'] as List).cast<Map<String, dynamic>>();
      if (mounted) setState(() => _ordenes = items);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Necesitas señal para ver las órdenes disponibles.');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _tomar(Map<String, dynamic> orden) async {
    final id = orden['id'] as int;
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('¿Tomar la OT-$id?'),
        content: Text('Quedará asignada a ti y se le avisará al cliente. Equipo: ${orden['maquinaria_codigo'] ?? 'sin código'}.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Tomar')),
        ],
      ),
    );
    if (confirmado != true || !mounted) return;

    final sync = context.read<SyncService>();
    final mensajero = ScaffoldMessenger.of(context);
    setState(() => _tomando = id);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/$id/tomar', {});
      mensajero.showSnackBar(SnackBar(content: Text('OT-$id es tuya. Ya aparece en Mis órdenes.')));
      // baja la orden al telefono para trabajarla (incluso sin senal despues)
      sync.sincronizar().catchError((_) {});
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      mensajero.showSnackBar(SnackBar(content: Text(e.message)));
      // la tomo otro: sacarla de la lista
      await _cargar();
    } catch (_) {
      mensajero.showSnackBar(const SnackBar(content: Text('No hubo respuesta del servidor. Revisa si la orden quedó tuya antes de reintentar.')));
    } finally {
      if (mounted) setState(() => _tomando = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Órdenes disponibles')),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: GomaqColors.textoSecundario)),
                        const SizedBox(height: 12),
                        OutlinedButton(onPressed: _cargar, child: const Text('Reintentar')),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _cargar,
                  child: _ordenes.isEmpty
                      ? ListView(
                          children: const [
                            SizedBox(height: 120),
                            Center(
                              child: Padding(
                                padding: EdgeInsets.all(32),
                                child: Text(
                                  'No hay órdenes sin asignar por ahora.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(color: GomaqColors.textoSecundario),
                                ),
                              ),
                            ),
                          ],
                        )
                      : ListView.builder(
                          padding: const EdgeInsets.all(16),
                          itemCount: _ordenes.length,
                          itemBuilder: (context, i) {
                            final o = _ordenes[i];
                            final id = o['id'] as int;
                            return Card(
                              child: Padding(
                                padding: const EdgeInsets.all(16),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text('OT-$id',
                                        style: const TextStyle(color: GomaqColors.primario, fontSize: 18, fontWeight: FontWeight.bold)),
                                    const SizedBox(height: 8),
                                    Text('${o['maquinaria_codigo'] ?? 'Sin código'}',
                                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                                    if (o['cliente_nombre'] != null) Text('${o['cliente_nombre']}'),
                                    if (o['motivo'] != null && '${o['motivo']}'.isNotEmpty)
                                      Padding(
                                        padding: const EdgeInsets.only(top: 4),
                                        child: Text('${o['motivo']}', style: const TextStyle(color: GomaqColors.textoSecundario)),
                                      ),
                                    if (o['fecha_creacion'] != null)
                                      Padding(
                                        padding: const EdgeInsets.only(top: 4),
                                        child: Text('Creada ${Formato.fechaHora(o['fecha_creacion'])}',
                                            style: const TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
                                      ),
                                    const SizedBox(height: 12),
                                    SizedBox(
                                      width: double.infinity,
                                      child: FilledButton.icon(
                                        onPressed: _tomando != null ? null : () => _tomar(o),
                                        icon: _tomando == id
                                            ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                                            : const Icon(Icons.pan_tool_alt_outlined, size: 18),
                                        label: const Text('Tomar esta orden'),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                ),
    );
  }
}
