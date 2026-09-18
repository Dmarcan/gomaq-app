import 'dart:html' as html;
import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../utils/formato.dart';
import '../widgets/estado_vacio.dart';

/// Trabajos terminados sobre los equipos del cliente. Los que siguen en curso están en
/// Seguimiento: antes aparecían acá también, sin estado, y no se distinguían de los cerrados.
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
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/mias') as List;
      if (!mounted) return;
      setState(() => _ordenes = data.where((o) => o['estado'] == 'finalizada').toList());
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text('No se pudo cargar el historial: $_error'));
    if (_ordenes.isEmpty) {
      return const EstadoVacio(
        icono: Icons.history,
        titulo: 'Aún no hay trabajos terminados',
        mensaje: 'Cuando GOMAQ cierre un trabajo sobre tus equipos, aparecerá aquí con su factura.',
      );
    }

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _ordenes.length,
        itemBuilder: (context, i) {
          final o = _ordenes[i];
          final facturaUrl = o['factura_url'] as String?;
          return Card(
            child: ListTile(
              title: Text(o['motivo'] ?? o['maquinaria_tipo'] ?? 'Orden de trabajo'),
              subtitle: Text('${o['maquinaria_codigo']} · Terminado el ${Formato.fecha(o['fecha_cierre'] ?? o['fecha_creacion'])}'),
              trailing: facturaUrl != null
                  ? TextButton.icon(
                      // la API ya entrega una URL firmada completa; antes se le anteponía la
                      // dirección del servidor y el enlace quedaba roto fuera del mismo origen
                      onPressed: () => html.window.open(facturaUrl, '_blank'),
                      icon: const Icon(Icons.picture_as_pdf, size: 18),
                      label: const Text('Factura'),
                    )
                  : null,
            ),
          );
        },
      ),
    );
  }
}
