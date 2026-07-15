import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

class SolicitudesScreen extends StatefulWidget {
  const SolicitudesScreen({super.key});

  @override
  State<SolicitudesScreen> createState() => _SolicitudesScreenState();
}

class _SolicitudesScreenState extends State<SolicitudesScreen> {
  List<dynamic> _solicitudes = [];
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
      final data = await ApiClient.instance.get('/api/solicitudes');
      if (!mounted) return;
      setState(() => _solicitudes = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _convertir(int id) async {
    try {
      await ApiClient.instance.patch('/api/solicitudes/$id/convertir', {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Solicitud convertida en Orden de Trabajo')));
      }
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _cargar,
      child: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text('Error: $_error'))
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _solicitudes.length,
                  itemBuilder: (context, i) {
                    final s = _solicitudes[i];
                    return Card(
                      child: ListTile(
                        title: Text('${s['cliente_nombre']} - ${s['maquinaria_codigo']}'),
                        subtitle: Text(s['descripcion']),
                        trailing: s['estado'] == 'pendiente'
                            ? FilledButton(
                                onPressed: () => _convertir(s['id']),
                                child: const Text('Convertir en OT'),
                              )
                            : Chip(
                                label: Text(s['estado']),
                                backgroundColor: GomaqColors.fondoChip(s['estado']),
                                labelStyle: TextStyle(color: GomaqColors.colorEstado(s['estado'])),
                              ),
                      ),
                    );
                  },
                ),
    );
  }
}
