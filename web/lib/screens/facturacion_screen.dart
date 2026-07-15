import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

class FacturacionScreen extends StatefulWidget {
  const FacturacionScreen({super.key});

  @override
  State<FacturacionScreen> createState() => _FacturacionScreenState();
}

class _FacturacionScreenState extends State<FacturacionScreen> {
  List<dynamic> _ordenesFacturables = [];
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
      final data = await ApiClient.instance.get('/api/ordenes-trabajo');
      if (!mounted) return;
      setState(() => _ordenesFacturables = (data as List).where((o) => o['facturable'] == true).toList());
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
    if (_ordenesFacturables.isEmpty) {
      return const Center(child: Text('No hay ordenes de trabajo facturables por el momento'));
    }

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _ordenesFacturables.length,
        itemBuilder: (context, i) {
          final o = _ordenesFacturables[i];
          return Card(
            child: ListTile(
              title: Text('OT #${o['id']} - ${o['maquinaria_codigo'] ?? ''}'),
              subtitle: Text('Cliente: ${o['cliente_nombre'] ?? '-'} · Valorización: ${o['valorizacion'] ?? 'sin aprobar'}'),
              onTap: () async {
                await showDialog(context: context, builder: (_) => _FacturaDialog(orden: o));
                _cargar();
              },
            ),
          );
        },
      ),
    );
  }
}

class _FacturaDialog extends StatefulWidget {
  final Map<String, dynamic> orden;
  const _FacturaDialog({required this.orden});

  @override
  State<_FacturaDialog> createState() => _FacturaDialogState();
}

class _FacturaDialogState extends State<_FacturaDialog> {
  List<dynamic> _facturas = [];
  bool _cargando = true;
  bool _procesando = false;
  final _folioCtrl = TextEditingController();
  final _montoCtrl = TextEditingController();
  PlatformFile? _archivo;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargarFacturas());
  }

  Future<void> _cargarFacturas() async {
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/${widget.orden['id']}/factura');
      if (mounted) setState(() => _facturas = data);
    } catch (_) {
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _elegirArchivo() async {
    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado != null && resultado.files.single.bytes != null) {
      setState(() => _archivo = resultado.files.single);
    }
  }

  Future<void> _subirFactura() async {
    if (_folioCtrl.text.trim().isEmpty || _archivo == null) return;
    setState(() => _procesando = true);
    try {
      await ApiClient.instance.postMultipart(
        '/api/ordenes-trabajo/${widget.orden['id']}/factura',
        bytes: _archivo!.bytes!,
        filename: _archivo!.name,
        fields: {
          'folio': _folioCtrl.text.trim(),
          if (_montoCtrl.text.trim().isNotEmpty) 'monto': _montoCtrl.text.trim(),
        },
      );
      await _cargarFacturas();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  Future<void> _autorizarEnvio(int facturaId) async {
    setState(() => _procesando = true);
    try {
      await ApiClient.instance.post('/api/ordenes-trabajo/${widget.orden['id']}/factura/$facturaId/autorizar-envio', {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Envío autorizado. Quedó encolado (se procesará cuando el correo esté configurado).')),
        );
        Navigator.pop(context);
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.orden;
    return AlertDialog(
      title: Text('Gestión Documental — OT #${o['id']}'),
      content: SizedBox(
        width: 460,
        child: _cargando
            ? const SizedBox(height: 100, child: Center(child: CircularProgressIndicator()))
            : SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_facturas.isEmpty) ...[
                      const Text('DOCUMENTO PDF', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 8),
                      TextField(controller: _folioCtrl, decoration: const InputDecoration(labelText: 'Folio SII')),
                      TextField(
                        controller: _montoCtrl,
                        decoration: const InputDecoration(labelText: 'Monto (opcional)'),
                        keyboardType: TextInputType.number,
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton.icon(
                        onPressed: _elegirArchivo,
                        icon: const Icon(Icons.upload_file),
                        label: Text(_archivo?.name ?? 'Elegir PDF'),
                      ),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: _procesando ? null : _subirFactura,
                        child: const Text('Subir factura'),
                      ),
                    ] else ...[
                      for (final f in _facturas) ...[
                        const Text('VISTA PREVIA ESTRUCTURADA', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: GomaqColors.primario.withValues(alpha: 0.08),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Factura Electrónica — Folio ${f['folio']}',
                                  style: const TextStyle(fontWeight: FontWeight.bold, color: GomaqColors.primario)),
                              const SizedBox(height: 8),
                              Text('Cliente: ${o['cliente_nombre'] ?? '-'}'),
                              Text('Monto: ${f['monto'] ?? '-'}'),
                              Text('OT vinculada: #${o['id']}'),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                        const Text('VISTA PREVIA DEL CORREO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(border: Border.all(color: Colors.grey.shade300), borderRadius: BorderRadius.circular(8)),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Factura folio ${f['folio']} — GOMAQ Maquinarias', style: const TextStyle(fontWeight: FontWeight.bold)),
                              const SizedBox(height: 8),
                              Text(
                                'Adjuntamos la factura correspondiente a la Orden de Trabajo #${o['id']}, '
                                'asociada a su equipo ${o['maquinaria_codigo'] ?? ''}. Ante cualquier consulta, '
                                'puede responder directamente este correo.',
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: _procesando ? null : () => _autorizarEnvio(f['id']),
                          child: const Text('Autorizar Envío de Correo'),
                        ),
                      ],
                    ],
                  ],
                ),
              ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
      ],
    );
  }
}
