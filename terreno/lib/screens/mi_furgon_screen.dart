import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../services/api_client.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';

/// Stock del furgon del mecanico (patron "van stock").
///
/// Ver lo que lleva funciona sin señal, porque es lo que necesita en terreno. Cargar desde
/// bodega es solo online a proposito: se hace en el taller, y validar contra la bodega en el
/// momento evita que dos mecanicos reclamen sin saberlo la misma pieza.
class MiFurgonScreen extends StatefulWidget {
  const MiFurgonScreen({super.key});

  @override
  State<MiFurgonScreen> createState() => _MiFurgonScreenState();
}

class _MiFurgonScreenState extends State<MiFurgonScreen> {
  List<Map<String, dynamic>> _items = [];
  Map<String, dynamic>? _vehiculo;
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final db = await LocalDatabase.instance.database;
    final items = await db.query('furgon_stock_local', orderBy: 'nombre ASC');
    final vehiculo = await db.query('mi_vehiculo_local', limit: 1);
    if (!mounted) return;
    setState(() {
      _items = items;
      _vehiculo = vehiculo.isEmpty ? null : vehiculo.first;
      _cargando = false;
    });
  }

  Future<void> _cargarDesdeBodega() async {
    final db = await LocalDatabase.instance.database;
    final catalogo = await db.query('insumos_catalogo_local', orderBy: 'nombre ASC');
    if (!mounted) return;
    if (catalogo.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Sin catálogo de repuestos descargado todavía')),
      );
      return;
    }

    final cantidadCtrl = TextEditingController();
    int? insumoId = catalogo.first['id'] as int;
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Cargar desde bodega'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<int>(
                initialValue: insumoId,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Repuesto'),
                items: [
                  for (final i in catalogo)
                    DropdownMenuItem(
                      value: i['id'] as int,
                      child: Text('${i['nombre']} (${i['unidad_medida']})', overflow: TextOverflow.ellipsis),
                    ),
                ],
                onChanged: (v) => setDialogState(() => insumoId = v),
              ),
              TextField(
                controller: cantidadCtrl,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Cantidad'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Cargar')),
          ],
        ),
      ),
    );
    final cantidad = double.tryParse(cantidadCtrl.text.trim().replaceAll(',', '.'));
    cantidadCtrl.dispose();
    if (confirmado != true || insumoId == null || cantidad == null || cantidad <= 0 || !mounted) return;

    // se toma antes del await: despues del envio el context pudo quedar desmontado
    final sync = context.read<SyncService>();
    try {
      await ApiClient.instance.post('/api/insumos/transferencia', {
        'insumo_id': insumoId,
        'cantidad': cantidad,
      });
      // el stock local se refresca desde el servidor, que es la fuente de verdad de bodega
      await sync.sincronizar();
      await _cargar();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cargado al furgón')));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final online = context.watch<ConnectivityService>().online;
    return Scaffold(
      appBar: AppBar(
        title: Text(_vehiculo == null ? 'Mi furgón' : 'Furgón ${_vehiculo!['patente']}'),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!online)
                const Padding(
                  padding: EdgeInsets.only(bottom: 8),
                  child: Text(
                    'Necesitas señal para cargar repuestos: hay que descontarlos de bodega en el momento.',
                    style: TextStyle(fontSize: 12, color: GomaqColors.estadoAdvertencia),
                    textAlign: TextAlign.center,
                  ),
                ),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: online ? _cargarDesdeBodega : null,
                  icon: const Icon(Icons.add_box_outlined),
                  label: const Text('CARGAR DESDE BODEGA'),
                ),
              ),
            ],
          ),
        ),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _cargar,
              child: _items.isEmpty
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(32),
                    child: Text(
                      'Tu furgón no tiene repuestos registrados todavía.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: GomaqColors.textoSecundario),
                    ),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _items.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final item = _items[i];
                    final cantidad = (item['cantidad'] as num?) ?? 0;
                    final descuadre = cantidad < 0;
                    return ListTile(
                      leading: Icon(
                        descuadre ? Icons.error_outline : Icons.inventory_2_outlined,
                        color: descuadre ? GomaqColors.estadoNegativo : null,
                      ),
                      title: Text(item['nombre']?.toString() ?? ''),
                      subtitle: descuadre
                          // pasa cuando registro un consumo que el sistema no tenia en el furgon:
                          // el trabajo queda anotado y bodega cuadra la diferencia despues
                          ? const Text('Descuadre: bodega tiene que revisarlo',
                              style: TextStyle(fontSize: 12, color: GomaqColors.estadoNegativo))
                          : null,
                      trailing: Text(
                        '$cantidad ${item['unidad_medida'] ?? ''}',
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          color: descuadre ? GomaqColors.estadoNegativo : null,
                        ),
                      ),
                    );
                  },
                ),
            ),
    );
  }
}
