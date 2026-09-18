import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../widgets/estado_chip.dart';

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

  /// Foto que adjuntó el cliente al reportar la falla. La URL viene firmada por el backend
  /// y vence en una hora, porque el bucket es privado.
  Widget _adjunto(String url) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('FOTO ADJUNTA POR EL CLIENTE',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.black54)),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: Image.network(
              url,
              height: 180,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => const Text(
                'No se pudo cargar la imagen (el enlace pudo vencer, recarga la pantalla)',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
              loadingBuilder: (context, hijo, progreso) =>
                  progreso == null ? hijo : const SizedBox(height: 180, child: Center(child: CircularProgressIndicator())),
            ),
          ),
        ],
      ),
    );
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
                      child: Column(
                        children: [
                          ListTile(
                            title: Text('${s['cliente_nombre']} - ${s['maquinaria_codigo']}'),
                            subtitle: Text(s['descripcion']),
                            trailing: s['estado'] == 'pendiente'
                                ? FilledButton(
                                    onPressed: () => _convertir(s['id']),
                                    child: const Text('Convertir en OT'),
                                  )
                                : EstadoChip(estado: s['estado']),
                          ),
                          // El cliente podía adjuntar una foto de la falla desde el portal, pero
                          // no se mostraba en ninguna pantalla: se guardaba y nadie la veía.
                          if (s['evidencia_url'] != null) _adjunto(s['evidencia_url']),
                        ],
                      ),
                    );
                  },
                ),
    );
  }
}
