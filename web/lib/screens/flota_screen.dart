import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';

class FlotaScreen extends StatefulWidget {
  const FlotaScreen({super.key});

  @override
  State<FlotaScreen> createState() => _FlotaScreenState();
}

class _FlotaScreenState extends State<FlotaScreen> {
  List<dynamic> _maquinarias = [];
  bool _cargando = true;
  String? _error;
  String _busqueda = '';

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
      final data = await ApiClient.instance.get('/api/maquinarias');
      if (!mounted) return;
      setState(() => _maquinarias = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear() async {
    final codigoCtrl = TextEditingController();
    final tipoCtrl = TextEditingController();
    final ubicacionCtrl = TextEditingController();

    final creado = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Nueva maquinaria'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: codigoCtrl, decoration: const InputDecoration(labelText: 'Codigo (ej. GH-204)')),
            TextField(controller: tipoCtrl, decoration: const InputDecoration(labelText: 'Tipo (ej. Grua Horquilla)')),
            TextField(controller: ubicacionCtrl, decoration: const InputDecoration(labelText: 'Ubicacion (opcional)')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Crear')),
        ],
      ),
    );

    if (creado != true) return;
    try {
      await ApiClient.instance.post('/api/maquinarias', {
        'codigo': codigoCtrl.text.trim(),
        'tipo': tipoCtrl.text.trim(),
        'ubicacion': ubicacionCtrl.text.trim().isEmpty ? null : ubicacionCtrl.text.trim(),
      });
      _cargar();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      }
    }
  }

  List<dynamic> get _maquinariasFiltradas {
    if (_busqueda.trim().isEmpty) return _maquinarias;
    final q = _busqueda.toLowerCase();
    return _maquinarias.where((m) {
      final codigo = (m['codigo'] as String? ?? '').toLowerCase();
      final tipo = (m['tipo'] as String? ?? '').toLowerCase();
      return codigo.contains(q) || tipo.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final puedeEscribir = context.watch<AuthService>().esAdministrativo;
    final maquinarias = _maquinariasFiltradas;

    return Scaffold(
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nueva maquinaria'),
            )
          : null,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(
              onChanged: (v) => setState(() => _busqueda = v),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Buscar por código o tipo...',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _cargar,
              child: _cargando
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? Center(child: Text('Error: $_error'))
                      : maquinarias.isEmpty
                          ? const Center(child: Text('Sin resultados'))
                          : ListView.builder(
                              padding: const EdgeInsets.all(16),
                              itemCount: maquinarias.length,
                              itemBuilder: (context, i) {
                                final m = maquinarias[i];
                                return Card(
                                  child: ListTile(
                                    title: Text('${m['codigo']} - ${m['tipo']}'),
                                    subtitle: Text('Cliente: ${m['cliente'] ?? '-'} | ${m['ubicacion'] ?? 'Sin ubicacion'}'),
                                    trailing: Chip(
                                      label: Text(m['estado']),
                                      backgroundColor: GomaqColors.fondoChip(m['estado']),
                                      labelStyle: TextStyle(color: GomaqColors.colorEstado(m['estado'])),
                                    ),
                                  ),
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
