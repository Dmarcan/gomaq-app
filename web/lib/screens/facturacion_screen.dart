import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';

class FacturacionScreen extends StatefulWidget {
  const FacturacionScreen({super.key});

  @override
  State<FacturacionScreen> createState() => _FacturacionScreenState();
}

class _FacturacionScreenState extends State<FacturacionScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<dynamic> _arriendos = [];
  List<dynamic> _pendientesValorizar = [];
  List<dynamic> _listas = [];
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/facturacion/pendientes');
      if (!mounted) return;
      setState(() {
        _arriendos = data['arriendos'] ?? [];
        _pendientesValorizar = data['reparaciones_pendientes_valorizar'] ?? [];
        _listas = data['reparaciones_listas'] ?? [];
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogo(Map<String, dynamic> item) async {
    await showDialog(context: context, builder: (_) => _FacturaPendienteDialog(item: item));
    _cargar();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: const Text('Facturación'),
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(text: 'Por facturar (${_arriendos.length + _listas.length})'),
            Tab(text: 'Pendiente de valorizar (${_pendientesValorizar.length})'),
          ],
        ),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text('Error: $_error'))
              : TabBarView(
                  controller: _tabController,
                  children: [_construirPorFacturar(), _construirPendienteValorizar()],
                ),
    );
  }

  Widget _construirPorFacturar() {
    final items = [
      for (final a in _arriendos)
        {
          'tipo': 'arriendo',
          'id': a['guia_recepcion_id'],
          'titulo': '${a['maquinaria_codigo']} · Arriendo',
          'cliente_nombre': a['cliente_nombre'],
          'subtitulo': '${a['dias']} día(s) de arriendo · Cliente: ${a['cliente_nombre'] ?? '-'}',
        },
      for (final r in _listas)
        {
          'tipo': 'reparacion',
          'id': r['id'],
          'titulo': 'OT #${r['id']} · ${r['maquinaria_codigo']} · Reparación',
          'cliente_nombre': r['cliente_nombre'],
          'monto_sugerido': r['valorizacion'],
          'subtitulo': 'Valorización aprobada: \$${r['valorizacion']} · Cliente: ${r['cliente_nombre'] ?? '-'}',
        },
    ];

    if (items.isEmpty) {
      return const Center(child: Text('No hay nada listo para facturar por el momento'));
    }
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: items.length,
        itemBuilder: (context, i) {
          final item = items[i];
          final esArriendo = item['tipo'] == 'arriendo';
          // emitir la factura es exclusivo de Administrativo (backend igual);
          // el Gerente ve la lista de pendientes como lectura
          final puedeFacturar = context.watch<AuthService>().esAdministrativo;
          return Card(
            child: ListTile(
              leading: Icon(esArriendo ? Icons.local_shipping : Icons.build, color: GomaqColors.primario),
              title: Text(item['titulo'] as String),
              subtitle: Text(
                puedeFacturar
                    ? item['subtitulo'] as String
                    : '${item['subtitulo']} · Administrativo emite la factura',
              ),
              onTap: puedeFacturar ? () => _abrirDialogo(item) : null,
            ),
          );
        },
      ),
    );
  }

  Widget _construirPendienteValorizar() {
    if (_pendientesValorizar.isEmpty) {
      return const Center(child: Text('No hay reparaciones esperando valorización'));
    }
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _pendientesValorizar.length,
        itemBuilder: (context, i) {
          final ot = _pendientesValorizar[i];
          return Card(
            child: ListTile(
              leading: const Icon(Icons.hourglass_empty, color: Colors.grey),
              title: Text('OT #${ot['id']} · ${ot['maquinaria_codigo']}'),
              subtitle: Text(
                'Cliente: ${ot['cliente_nombre'] ?? '-'} · El mecánico ya la marcó facturable, '
                'falta que el Gerente le ponga el monto en Órdenes de Trabajo',
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Dialogo unico para ambos tipos de pendiente (arriendo/reparacion): subir PDF, detectar
/// datos (mejor esfuerzo), confirmar/editar, crear la factura, y armar la vista previa
/// del correo antes de autorizar el envio.
class _FacturaPendienteDialog extends StatefulWidget {
  final Map<String, dynamic> item;
  const _FacturaPendienteDialog({required this.item});

  @override
  State<_FacturaPendienteDialog> createState() => _FacturaPendienteDialogState();
}

class _FacturaPendienteDialogState extends State<_FacturaPendienteDialog> {
  final _folioCtrl = TextEditingController();
  final _montoCtrl = TextEditingController();
  PlatformFile? _archivo;
  bool _detectando = false;
  bool _procesando = false;
  bool _guardandoEdicion = false;
  Map<String, dynamic>? _facturaCreada;
  final _folioEditCtrl = TextEditingController();
  final _montoEditCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    if (widget.item['monto_sugerido'] != null) {
      _montoCtrl.text = widget.item['monto_sugerido'].toString();
    }
  }

  Future<void> _elegirArchivo() async {
    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado == null || resultado.files.single.bytes == null) return;
    setState(() => _archivo = resultado.files.single);

    setState(() => _detectando = true);
    try {
      final deteccion = await ApiClient.instance.postMultipart(
        '/api/facturacion/detectar',
        bytes: _archivo!.bytes,
        filename: _archivo!.name,
      );
      if (!mounted) return;
      setState(() {
        if (deteccion['monto_detectado'] != null) _montoCtrl.text = deteccion['monto_detectado'].toString();
        if (deteccion['folio_detectado'] != null) _folioCtrl.text = deteccion['folio_detectado'].toString();
      });
    } on ApiException catch (_) {
      // deteccion best-effort: si falla, el usuario sigue llenando a mano
    } finally {
      if (mounted) setState(() => _detectando = false);
    }
  }

  Future<void> _subirFactura() async {
    if (_folioCtrl.text.trim().isEmpty || _archivo == null) return;
    setState(() => _procesando = true);
    try {
      final esArriendo = widget.item['tipo'] == 'arriendo';
      final path = esArriendo ? '/api/facturacion/arriendo' : '/api/ordenes-trabajo/${widget.item['id']}/factura';
      final resultado = await ApiClient.instance.postMultipart(
        path,
        bytes: _archivo!.bytes!,
        filename: _archivo!.name,
        fields: {
          if (esArriendo) 'guia_recepcion_id': widget.item['id'].toString(),
          'folio': _folioCtrl.text.trim(),
          if (_montoCtrl.text.trim().isNotEmpty) 'monto': _montoCtrl.text.trim(),
        },
      );
      if (mounted) {
        setState(() {
          _facturaCreada = resultado;
          _folioEditCtrl.text = resultado['folio']?.toString() ?? '';
          _montoEditCtrl.text = resultado['monto']?.toString() ?? '';
        });
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  Future<void> _guardarCambios() async {
    if (_facturaCreada == null) return;
    setState(() => _guardandoEdicion = true);
    try {
      final actualizada = await ApiClient.instance.patch('/api/facturacion/${_facturaCreada!['id']}', {
        'folio': _folioEditCtrl.text.trim().isEmpty ? null : _folioEditCtrl.text.trim(),
        'monto': _montoEditCtrl.text.trim().isEmpty ? null : _montoEditCtrl.text.trim(),
      });
      if (mounted) {
        setState(() => _facturaCreada = actualizada);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Datos actualizados')));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _guardandoEdicion = false);
    }
  }

  Future<void> _autorizarEnvio() async {
    if (_facturaCreada == null) return;
    setState(() => _procesando = true);
    try {
      await ApiClient.instance.post('/api/facturacion/${_facturaCreada!['id']}/autorizar-envio', {});
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
    return AlertDialog(
      title: Text(widget.item['titulo'] as String),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: _facturaCreada == null ? _construirFormulario() : _construirVistaPrevia(),
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
      ],
    );
  }

  List<Widget> _construirFormulario() {
    return [
      const Text('DOCUMENTO PDF DE LA FACTURA', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: _elegirArchivo,
        icon: const Icon(Icons.upload_file),
        label: Text(_archivo?.name ?? 'Elegir PDF'),
      ),
      if (_detectando) ...[
        const SizedBox(height: 8),
        const Row(
          children: [
            SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2)),
            SizedBox(width: 8),
            Text('Buscando monto en el PDF...', style: TextStyle(fontSize: 12, color: Colors.black54)),
          ],
        ),
      ],
      const SizedBox(height: 12),
      TextField(controller: _folioCtrl, decoration: const InputDecoration(labelText: 'Folio SII')),
      TextField(
        controller: _montoCtrl,
        decoration: const InputDecoration(labelText: 'Monto (CLP)'),
        keyboardType: TextInputType.number,
      ),
      const SizedBox(height: 16),
      FilledButton(
        onPressed: (_procesando || _detectando) ? null : _subirFactura,
        child: const Text('Subir factura'),
      ),
    ];
  }

  List<Widget> _construirVistaPrevia() {
    final f = _facturaCreada!;
    final cliente = widget.item['cliente_nombre'] ?? '-';
    return [
      const Text('VISTA PREVIA ESTRUCTURADA', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
      const SizedBox(height: 4),
      const Text(
        'Si algo no se detectó bien, corrígelo aquí y guarda antes de enviar el correo',
        style: TextStyle(fontSize: 12, color: Colors.black54, fontStyle: FontStyle.italic),
      ),
      const SizedBox(height: 8),
      Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: GomaqColors.primario.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(8)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Factura Electrónica', style: const TextStyle(fontWeight: FontWeight.bold, color: GomaqColors.primario)),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(child: TextField(controller: _folioEditCtrl, decoration: const InputDecoration(labelText: 'Folio'))),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _montoEditCtrl,
                    decoration: const InputDecoration(labelText: 'Monto (CLP)'),
                    keyboardType: TextInputType.number,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: OutlinedButton(
                onPressed: _guardandoEdicion ? null : _guardarCambios,
                child: _guardandoEdicion
                    ? const SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Guardar cambios'),
              ),
            ),
            const SizedBox(height: 8),
            Text('Cliente: $cliente'),
            Text(widget.item['titulo'] as String),
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
            Text('Adjuntamos la factura correspondiente a ${widget.item['titulo']}. Ante cualquier consulta, puede responder directamente este correo.'),
          ],
        ),
      ),
      const SizedBox(height: 16),
      FilledButton(
        onPressed: _procesando ? null : _autorizarEnvio,
        child: const Text('Autorizar Envío de Correo'),
      ),
    ];
  }
}
