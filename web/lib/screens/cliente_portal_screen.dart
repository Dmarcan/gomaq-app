import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';

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
      backgroundColor: GomaqColors.fondoCalido,
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _cargar,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(color: GomaqColors.primario, borderRadius: BorderRadius.circular(16)),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Hola,', style: TextStyle(color: Colors.white70, fontSize: 14)),
                          Text(auth.nombre ?? '', style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold)),
                        ],
                      ),
                    ),
                    CircleAvatar(
                      backgroundColor: Colors.white24,
                      child: Text((auth.nombre ?? '?').substring(0, 1).toUpperCase(), style: const TextStyle(color: Colors.white)),
                    ),
                    IconButton(icon: const Icon(Icons.logout, color: Colors.white), onPressed: () => auth.logout()),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              if (_cargando)
                const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
              else if (_error != null)
                Center(child: Text('Error: $_error'))
              else if (_maquinarias.isEmpty)
                const Center(child: Padding(padding: EdgeInsets.all(32), child: Text('No tienes maquinarias registradas')))
              else
                for (final m in _maquinarias)
                  Card(
                    child: ListTile(
                      title: Text('${m['codigo']} - ${m['tipo']}'),
                      subtitle: Text(m['ubicacion'] ?? 'Sin ubicacion registrada'),
                      trailing: Chip(
                        label: Text(m['estado']),
                        backgroundColor: GomaqColors.fondoChip(m['estado']),
                        labelStyle: TextStyle(color: GomaqColors.colorEstado(m['estado'])),
                      ),
                      onTap: () => _solicitarAsistencia(m),
                    ),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}
