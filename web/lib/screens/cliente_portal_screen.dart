import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';

class ClientePortalScreen extends StatefulWidget {
  const ClientePortalScreen({super.key});

  @override
  State<ClientePortalScreen> createState() => _ClientePortalScreenState();
}

class _ClientePortalScreenState extends State<ClientePortalScreen> {
  List<dynamic> _maquinarias = [];
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
      final data = await ApiClient.instance.get('/api/maquinarias/mias');
      if (!mounted) return;
      setState(() => _maquinarias = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Color _colorEstado(String estado) {
    switch (estado) {
      case 'operativa':
        return Colors.green;
      case 'en_mantencion':
        return Colors.orange;
      default:
        return Colors.red;
    }
  }

  Future<void> _solicitarAsistencia(Map<String, dynamic> maquinaria) async {
    final descripcionCtrl = TextEditingController();
    final enviar = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Solicitar asistencia - ${maquinaria['codigo']}'),
        content: TextField(
          controller: descripcionCtrl,
          maxLines: 4,
          decoration: const InputDecoration(
            labelText: 'Describe el problema o la mantencion requerida',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Enviar solicitud')),
        ],
      ),
    );

    if (enviar != true || descripcionCtrl.text.trim().isEmpty) return;
    try {
      await ApiClient.instance.post('/api/solicitudes', {
        'maquinaria_id': maquinaria['id'],
        'descripcion': descripcionCtrl.text.trim(),
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Solicitud enviada. La empresa se contactara pronto.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('GOMAQ - Mi Flota'),
        actions: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Center(child: Text(auth.nombre ?? '')),
          ),
          IconButton(icon: const Icon(Icons.logout), onPressed: () => auth.logout()),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text('Error: $_error'))
                : _maquinarias.isEmpty
                    ? const Center(child: Text('No tienes maquinarias registradas'))
                    : ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _maquinarias.length,
                        itemBuilder: (context, i) {
                          final m = _maquinarias[i];
                          return Card(
                            child: ListTile(
                              title: Text('${m['codigo']} - ${m['tipo']}'),
                              subtitle: Text(m['ubicacion'] ?? 'Sin ubicacion registrada'),
                              trailing: Chip(
                                label: Text(m['estado']),
                                backgroundColor: _colorEstado(m['estado']).withValues(alpha: 0.15),
                                labelStyle: TextStyle(color: _colorEstado(m['estado'])),
                              ),
                              onTap: () => _solicitarAsistencia(m),
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}
