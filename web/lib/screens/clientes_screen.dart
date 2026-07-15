import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';

class ClientesScreen extends StatefulWidget {
  const ClientesScreen({super.key});

  @override
  State<ClientesScreen> createState() => _ClientesScreenState();
}

class _ClientesScreenState extends State<ClientesScreen> {
  List<dynamic> _clientes = [];
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
      final data = await ApiClient.instance.get('/api/clientes');
      if (!mounted) return;
      setState(() => _clientes = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear() async {
    final nombreCtrl = TextEditingController();
    final rutCtrl = TextEditingController();
    final emailCtrl = TextEditingController();
    final telefonoCtrl = TextEditingController();

    final creado = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Nuevo cliente'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: nombreCtrl, decoration: const InputDecoration(labelText: 'Nombre / Razon social')),
            TextField(controller: rutCtrl, decoration: const InputDecoration(labelText: 'RUT (opcional)')),
            TextField(controller: emailCtrl, decoration: const InputDecoration(labelText: 'Email (opcional)')),
            TextField(controller: telefonoCtrl, decoration: const InputDecoration(labelText: 'Telefono (opcional, formato +569...)')),
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
      await ApiClient.instance.post('/api/clientes', {
        'nombre': nombreCtrl.text.trim(),
        'rut': rutCtrl.text.trim().isEmpty ? null : rutCtrl.text.trim(),
        'email': emailCtrl.text.trim().isEmpty ? null : emailCtrl.text.trim(),
        'telefono': telefonoCtrl.text.trim().isEmpty ? null : telefonoCtrl.text.trim(),
      });
      _cargar();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final puedeEscribir = context.watch<AuthService>().esAdministrativo || context.watch<AuthService>().esGerente;

    return Scaffold(
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nuevo cliente'),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text('Error: $_error'))
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _clientes.length,
                    itemBuilder: (context, i) {
                      final c = _clientes[i];
                      return Card(
                        child: ListTile(
                          title: Text(c['nombre']),
                          subtitle: Text('${c['email'] ?? 'sin email'} | ${c['telefono'] ?? 'sin telefono'}'),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
