import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

class NotificacionesScreen extends StatefulWidget {
  const NotificacionesScreen({super.key});

  @override
  State<NotificacionesScreen> createState() => _NotificacionesScreenState();
}

class _NotificacionesScreenState extends State<NotificacionesScreen> {
  List<dynamic> _notificaciones = [];
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
      final data = await ApiClient.instance.get('/api/notificaciones');
      if (!mounted) return;
      setState(() => _notificaciones = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
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
              : _notificaciones.isEmpty
                  ? const Center(child: Text('No hay notificaciones registradas'))
                  : ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _notificaciones.length,
                      itemBuilder: (context, i) {
                        final n = _notificaciones[i];
                        return Card(
                          child: ListTile(
                            leading: Icon(Icons.circle, size: 12, color: GomaqColors.colorEstado(n['estado'])),
                            title: Text('${n['canal']} -> ${n['destinatario']}'),
                            subtitle: Text(
                              n['estado'] == 'error'
                                  ? 'Error tras ${n['intentos']} intentos: ${n['ultimo_error'] ?? ''}'
                                  : 'Estado: ${n['estado']} (${n['intentos']} intentos)',
                            ),
                          ),
                        );
                      },
                    ),
    );
  }
}
