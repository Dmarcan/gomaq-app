import 'dart:html' as html;
import 'package:flutter/material.dart';
import '../services/api_client.dart';

class ClienteHistorialScreen extends StatefulWidget {
  const ClienteHistorialScreen({super.key});

  @override
  State<ClienteHistorialScreen> createState() => _ClienteHistorialScreenState();
}

class _ClienteHistorialScreenState extends State<ClienteHistorialScreen> {
  List<dynamic> _ordenes = [];
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
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/mias');
      if (!mounted) return;
      setState(() => _ordenes = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text('Error: $_error'));
    if (_ordenes.isEmpty) return const Center(child: Text('Aun no tienes historial de ordenes de trabajo'));

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _ordenes.length,
        itemBuilder: (context, i) {
          final o = _ordenes[i];
          final tieneFactura = o['factura_url'] != null;
          return Card(
            child: ListTile(
              title: Text(o['motivo'] ?? o['maquinaria_tipo'] ?? 'Orden de trabajo'),
              subtitle: Text('${o['maquinaria_codigo']} · ${_formatearFecha(o['fecha_creacion'])}'),
              trailing: tieneFactura
                  ? TextButton.icon(
                      onPressed: () => html.window.open('${ApiClient.baseUrl}${o['factura_url']}', '_blank'),
                      icon: const Icon(Icons.picture_as_pdf, size: 18),
                      label: const Text('PDF'),
                    )
                  : null,
            ),
          );
        },
      ),
    );
  }

  String _formatearFecha(String? iso) {
    if (iso == null) return '';
    final fecha = DateTime.tryParse(iso);
    if (fecha == null) return '';
    return '${fecha.day.toString().padLeft(2, '0')}/${fecha.month.toString().padLeft(2, '0')}/${fecha.year}';
  }
}
