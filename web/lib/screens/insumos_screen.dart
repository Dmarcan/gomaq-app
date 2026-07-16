import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';

class InsumosScreen extends StatefulWidget {
  const InsumosScreen({super.key});

  @override
  State<InsumosScreen> createState() => _InsumosScreenState();
}

class _InsumosScreenState extends State<InsumosScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<dynamic> _catalogo = [];
  List<dynamic> _movimientos = [];
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final catalogo = await ApiClient.instance.get('/api/insumos');
      final movimientos = await ApiClient.instance.get('/api/insumos/movimientos');
      if (!mounted) return;
      setState(() {
        _catalogo = catalogo;
        _movimientos = movimientos;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear() async {
    final nombreCtrl = TextEditingController();
    final unidadCtrl = TextEditingController();
    final costoCtrl = TextEditingController();

    final creado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Nuevo insumo'),
        content: SizedBox(
          width: 360,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: nombreCtrl, decoration: const InputDecoration(labelText: 'Nombre')),
                TextField(controller: unidadCtrl, decoration: const InputDecoration(labelText: 'Unidad de medida (ej. litro, unidad)')),
                TextField(
                  controller: costoCtrl,
                  decoration: const InputDecoration(labelText: 'Costo unitario (CLP)'),
                  keyboardType: TextInputType.number,
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Crear')),
        ],
      ),
    );

    if (creado != true || nombreCtrl.text.trim().isEmpty || unidadCtrl.text.trim().isEmpty) return;
    try {
      await ApiClient.instance.post('/api/insumos', {
        'nombre': nombreCtrl.text.trim(),
        'unidad_medida': unidadCtrl.text.trim(),
        'costo_unitario': double.tryParse(costoCtrl.text.trim()),
      });
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Future<void> _abrirDialogoIngreso(Map<String, dynamic> insumo) async {
    final cantidadCtrl = TextEditingController();

    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Ingreso de stock - ${insumo['nombre']}'),
        content: TextField(
          controller: cantidadCtrl,
          autofocus: true,
          decoration: InputDecoration(labelText: 'Cantidad a sumar (${insumo['unidad_medida']})'),
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Registrar')),
        ],
      ),
    );

    final cantidad = double.tryParse(cantidadCtrl.text.trim());
    if (confirmado != true || cantidad == null || cantidad <= 0) return;
    try {
      await ApiClient.instance.post('/api/insumos/${insumo['id']}/ingreso', {'cantidad': cantidad});
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    // crear insumos e ingresar stock es exclusivo de Administrativo (backend igual);
    // el Gerente conserva la lectura del catalogo y de los consumos
    final puedeEscribir = context.watch<AuthService>().esAdministrativo;
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: const Text('Insumos'),
        bottom: TabBar(
          controller: _tabController,
          tabs: const [Tab(text: 'Catalogo'), Tab(text: 'Consumos recientes')],
        ),
      ),
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nuevo insumo'),
            )
          : null,
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text('Error: $_error'))
              : TabBarView(
                  controller: _tabController,
                  children: [
                    RefreshIndicator(
                      onRefresh: _cargar,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _catalogo.length,
                        itemBuilder: (context, i) {
                          final insumo = _catalogo[i];
                          return Card(
                            child: ListTile(
                              title: Text(insumo['nombre']),
                              subtitle: Text(
                                'Stock: ${insumo['stock_actual']} ${insumo['unidad_medida']} · Costo unitario: ${insumo['costo_unitario'] ?? '-'}',
                              ),
                              trailing: !puedeEscribir
                                  ? null
                                  : OutlinedButton.icon(
                                onPressed: () => _abrirDialogoIngreso(insumo),
                                icon: const Icon(Icons.add_box_outlined),
                                label: const Text('Ingreso'),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                    RefreshIndicator(
                      onRefresh: _cargar,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _movimientos.length,
                        itemBuilder: (context, i) {
                          final mov = _movimientos[i];
                          return Card(
                            child: ListTile(
                              title: Text('${mov['insumo_nombre']} · ${mov['cantidad']} ${mov['unidad_medida']}'),
                              subtitle: Text(
                                '${mov['maquinaria_codigo'] != null ? 'OT maquinaria ${mov['maquinaria_codigo']} · ' : ''}'
                                '${mov['usuario_nombre'] ?? '-'} · ${mov['created_at']}',
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                  ],
                ),
    );
  }
}
