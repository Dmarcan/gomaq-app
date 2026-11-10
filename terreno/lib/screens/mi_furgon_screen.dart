import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../services/api_client.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../utils/cantidad_unidad.dart';
import '../utils/hoja_inferior.dart';
import '../utils/uuid.dart';

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
  // evita cargar dos veces lo mismo si se toca el boton de nuevo mientras responde el servidor
  bool _enviando = false;

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

  /// Carga repuestos de la bodega al furgon. Solo con senal: se descuenta de la bodega en el momento.
  Future<void> _cargarDesdeBodega() async {
    // el catalogo se pide al servidor para ver el stock de bodega y del furgon antes de elegir; si
    // no responde se usa el del telefono (sin stock, y el servidor igual valida al cargar)
    List<Map<String, dynamic>> catalogo;
    try {
      final respuesta = await ApiClient.instance.get('/api/insumos');
      catalogo = (respuesta as List).cast<Map<String, dynamic>>();
    } catch (_) {
      final db = await LocalDatabase.instance.database;
      catalogo = await db.query('insumos_catalogo_local', orderBy: 'nombre ASC');
    }
    if (!mounted) return;
    if (catalogo.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Sin catálogo de repuestos descargado todavía')),
      );
      return;
    }

    final paddingSuperior = MediaQuery.paddingOf(context).top;
    final eleccion = await showModalBottomSheet<_EleccionCarga>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _HojaCargaBodega(catalogo: catalogo, paddingSuperior: paddingSuperior),
    );
    if (eleccion == null || !mounted) return;
    await _enviarCarga(eleccion);
  }

  /// Envia la transferencia. Lleva un uuid generado una sola vez: si no hay respuesta (senal que
  /// se corta) el reintento viaja con el mismo uuid y el servidor no descuenta la bodega dos
  /// veces, asi que reintentar es seguro.
  Future<void> _enviarCarga(_EleccionCarga eleccion) async {
    final sync = context.read<SyncService>();
    final uuid = generarUuid();
    setState(() => _enviando = true);
    try {
      while (true) {
        try {
          await ApiClient.instance.post('/api/insumos/transferencia', {
            'insumo_id': eleccion.insumoId,
            'cantidad': eleccion.cantidad,
            'uuid_cliente': uuid,
          });
          break;
        } on ApiException {
          rethrow;
        } catch (_) {
          // sin respuesta (timeout o senal): la carga pudo haberse hecho igual
          if (!mounted) return;
          final reintentar = await showDialog<bool>(
            context: context,
            builder: (dialogContext) => AlertDialog(
              title: const Text('No hubo respuesta del servidor'),
              content: const Text('La carga pudo haberse hecho. Reintentar es seguro: no se cargará dos veces.'),
              actions: [
                TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
                FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Reintentar')),
              ],
            ),
          );
          if (reintentar != true) {
            // se actualiza el stock para que vea si la carga alcanzo a hacerse
            try {
              await sync.actualizarFurgon();
              await _cargar();
            } catch (_) {}
            return;
          }
        }
      }
      // el stock local se refresca desde el servidor, que es la fuente de verdad de bodega. Solo el
      // furgon: bajar de nuevo las OT, catalogos y flota hacia esperar al mecanico decenas de segundos.
      await sync.actualizarFurgon();
      await _cargar();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Cargado al furgón: ${eleccion.nombre}')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo cargar al furgón: ${e.message}')));
    } catch (_) {
      // el stock se pudo cargar pero no refrescar: se avisa sin culpar a la carga
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Cargado, pero no se pudo actualizar el stock. Desliza para actualizar.')),
        );
      }
    } finally {
      if (mounted) setState(() => _enviando = false);
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
                  onPressed: online && !_enviando ? _cargarDesdeBodega : null,
                  icon: _enviando
                      ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.add_box_outlined),
                  label: Text(_enviando ? 'CARGANDO…' : 'CARGAR DESDE BODEGA'),
                ),
              ),
            ],
          ),
        ),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () async {
                try {
                  await context.read<SyncService>().actualizarFurgon();
                } catch (_) {
                  // sin señal: se muestra lo que ya hay en el telefono
                }
                await _cargar();
              },
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
                        cantidadConUnidad(cantidad, '${item['unidad_medida'] ?? ''}'),
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

class _EleccionCarga {
  final int insumoId;
  final String nombre;
  final double cantidad;
  const _EleccionCarga(this.insumoId, this.nombre, this.cantidad);
}

/// Hoja para elegir el repuesto (con buscador) y la cantidad. Muestra cuanto hay en la bodega y en
/// el furgon de quien carga, y no deja pedir mas de lo que hay en bodega.
class _HojaCargaBodega extends StatefulWidget {
  final List<Map<String, dynamic>> catalogo;
  // barra de estado medida fuera de la hoja (useSafeArea la descuenta dentro)
  final double paddingSuperior;
  const _HojaCargaBodega({required this.catalogo, required this.paddingSuperior});

  @override
  State<_HojaCargaBodega> createState() => _HojaCargaBodegaState();
}

class _HojaCargaBodegaState extends State<_HojaCargaBodega> {
  String _filtro = '';
  Map<String, dynamic>? _elegido;
  final _cantidadCtrl = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _cantidadCtrl.dispose();
    super.dispose();
  }

  static double? _num(dynamic v) => v == null ? null : (v as num).toDouble();
  static String _fmt(double v) => v.toStringAsFixed(v % 1 == 0 ? 0 : 1);

  void _confirmar() {
    final item = _elegido!;
    final cantidad = double.tryParse(_cantidadCtrl.text.trim().replaceAll(',', '.'));
    final bodega = _num(item['stock_bodega']);
    if (cantidad == null || cantidad <= 0) {
      setState(() => _error = 'Ingresa una cantidad válida');
      return;
    }
    if (bodega != null && cantidad > bodega) {
      setState(() => _error = 'En bodega solo hay ${_fmt(bodega)}');
      return;
    }
    Navigator.pop(context, _EleccionCarga(item['id'] as int, '${item['nombre']}', cantidad));
  }

  @override
  Widget build(BuildContext context) {
    final filtro = _filtro.trim().toLowerCase();
    final visibles = filtro.isEmpty
        ? widget.catalogo
        : widget.catalogo.where((i) => '${i['nombre']}'.toLowerCase().contains(filtro)).toList();

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SizedBox(
          height: alturaHojaInferior(
            altoPantalla: MediaQuery.of(context).size.height,
            alturaTeclado: MediaQuery.of(context).viewInsets.bottom,
            paddingSuperior: widget.paddingSuperior,
            fraccion: 0.8,
          ),
          child: _elegido == null ? _lista(visibles) : _cantidad(_elegido!),
        ),
      ),
    );
  }

  Widget _lista(List<Map<String, dynamic>> visibles) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: TextField(
            autofocus: true,
            decoration: const InputDecoration(labelText: 'Buscar repuesto', prefixIcon: Icon(Icons.search)),
            onChanged: (v) => setState(() => _filtro = v),
          ),
        ),
        Expanded(
          child: visibles.isEmpty
              ? const Center(child: Text('Ningún repuesto coincide', style: TextStyle(color: GomaqColors.textoSecundario)))
              : ListView.builder(
                  itemCount: visibles.length,
                  itemBuilder: (context, i) {
                    final item = visibles[i];
                    final bodega = _num(item['stock_bodega']);
                    final furgon = _num(item['stock_furgon']);
                    final sinStock = bodega != null && bodega <= 0;
                    return ListTile(
                      enabled: !sinStock,
                      title: Text('${item['nombre']}'),
                      subtitle: Text(
                        bodega == null
                            ? 'Unidad: ${item['unidad_medida']}'
                            : sinStock
                                ? 'Sin stock en bodega'
                                : textoStockBodegaFurgon(bodega, furgon ?? 0, '${item['unidad_medida'] ?? ''}'),
                      ),
                      onTap: () => setState(() {
                        _elegido = item;
                        _error = null;
                      }),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _cantidad(Map<String, dynamic> item) {
    final bodega = _num(item['stock_bodega']);
    final furgon = _num(item['stock_furgon']);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconButton(onPressed: () => setState(() => _elegido = null), icon: const Icon(Icons.arrow_back)),
              Expanded(child: Text('${item['nombre']}', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold))),
            ],
          ),
          if (bodega != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
              child: Text(textoStockBodegaFurgon(bodega, furgon ?? 0, '${item['unidad_medida'] ?? ''}', detalle: true)),
            ),
          TextField(
            controller: _cantidadCtrl,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(
              labelText: 'Cantidad a cargar',
              suffixText: '${item['unidad_medida'] ?? ''}',
              errorText: _error,
            ),
            onSubmitted: (_) => _confirmar(),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: FilledButton(onPressed: _confirmar, child: const Text('Cargar al furgón')),
          ),
        ],
      ),
    );
  }
}
