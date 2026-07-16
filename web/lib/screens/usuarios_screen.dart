import 'package:flutter/material.dart';
import '../services/api_client.dart';

class UsuariosScreen extends StatefulWidget {
  const UsuariosScreen({super.key});

  @override
  State<UsuariosScreen> createState() => _UsuariosScreenState();
}

class _UsuariosScreenState extends State<UsuariosScreen> {
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
      final data = await ApiClient.instance.get('/api/usuarios/solicitudes');
      if (!mounted) return;
      setState(() => _solicitudes = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _vincularExistente(Map<String, dynamic> solicitud) async {
    List<dynamic> clientes = [];
    try {
      clientes = await ApiClient.instance.get('/api/clientes');
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      return;
    }

    int? clienteId;
    if (!mounted) return;
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Vincular a cliente existente'),
          content: DropdownButtonFormField<int>(
            decoration: const InputDecoration(labelText: 'Cliente'),
            items: clientes.map<DropdownMenuItem<int>>((c) => DropdownMenuItem(value: c['id'], child: Text(c['nombre']))).toList(),
            onChanged: (v) => setDialogState(() => clienteId = v),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Vincular y activar')),
          ],
        ),
      ),
    );

    if (confirmado != true || clienteId == null) return;
    await _aprobar(solicitud['id'], clienteId: clienteId);
  }

  Future<void> _aprobar(int solicitudId, {int? clienteId}) async {
    try {
      await ApiClient.instance.post('/api/usuarios/solicitudes/$solicitudId/aprobar', {
        if (clienteId != null) 'cliente_id': clienteId,
      });
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cuenta activada')));
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Future<void> _rechazar(int solicitudId) async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Rechazar solicitud'),
        content: const Text('¿Confirmas que quieres rechazar esta solicitud de cuenta?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Rechazar')),
        ],
      ),
    );
    if (confirmado != true) return;
    try {
      await ApiClient.instance.post('/api/usuarios/solicitudes/$solicitudId/rechazar', {});
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Widget _dato(String etiqueta, String? valor) {
    if (valor == null || valor.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: RichText(
        text: TextSpan(
          style: const TextStyle(fontSize: 13, color: Colors.black87),
          children: [
            TextSpan(text: '$etiqueta: ', style: const TextStyle(fontWeight: FontWeight.w600)),
            TextSpan(text: valor),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text('Error: $_error'));
    if (_solicitudes.isEmpty) {
      return const Center(child: Text('No hay solicitudes de cuenta pendientes'));
    }

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _solicitudes.length,
        itemBuilder: (context, i) {
          final s = _solicitudes[i];
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(s['nombre_contacto'], style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  _dato('Correo', s['email']),
                  _dato('RUT empresa', s['rut_empresa']),
                  _dato('WhatsApp', s['telefono_whatsapp']),
                  _dato('Horario de trabajo', s['horario_trabajo']),
                  _dato('Horario de colación', s['horario_colacion']),
                  _dato('Dirección', s['direccion']),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      FilledButton.icon(
                        onPressed: () => _aprobar(s['id']),
                        icon: const Icon(Icons.add_business, size: 16),
                        label: const Text('Crear cliente nuevo'),
                      ),
                      OutlinedButton.icon(
                        onPressed: () => _vincularExistente(s),
                        icon: const Icon(Icons.link, size: 16),
                        label: const Text('Vincular a cliente existente'),
                      ),
                      TextButton.icon(
                        onPressed: () => _rechazar(s['id']),
                        icon: const Icon(Icons.close, size: 16, color: Colors.red),
                        label: const Text('Rechazar', style: TextStyle(color: Colors.red)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
