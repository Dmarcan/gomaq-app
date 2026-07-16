import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';

class OrdenesScreen extends StatefulWidget {
  const OrdenesScreen({super.key});

  @override
  State<OrdenesScreen> createState() => _OrdenesScreenState();
}

class _OrdenesScreenState extends State<OrdenesScreen> {
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
      final data = await ApiClient.instance.get('/api/ordenes-trabajo');
      if (!mounted) return;
      setState(() => _ordenes = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear() async {
    List<dynamic> maquinarias = [];
    List<dynamic> clientes = [];
    try {
      maquinarias = await ApiClient.instance.get('/api/maquinarias');
      clientes = await ApiClient.instance.get('/api/clientes');
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      return;
    }

    int? maquinariaId;
    int? clienteId;
    final motivoCtrl = TextEditingController();

    if (!mounted) return;
    final creado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Nueva Orden de Trabajo'),
          content: SizedBox(
            width: 400,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  DropdownButtonFormField<int>(
                    decoration: const InputDecoration(labelText: 'Maquinaria'),
                    items: maquinarias
                        .map<DropdownMenuItem<int>>((m) => DropdownMenuItem(value: m['id'], child: Text('${m['codigo']} - ${m['tipo']}')))
                        .toList(),
                    onChanged: (v) => setDialogState(() => maquinariaId = v),
                  ),
                  DropdownButtonFormField<int>(
                    decoration: const InputDecoration(labelText: 'Cliente'),
                    items: clientes
                        .map<DropdownMenuItem<int>>((c) => DropdownMenuItem(value: c['id'], child: Text(c['nombre'])))
                        .toList(),
                    onChanged: (v) => setDialogState(() => clienteId = v),
                  ),
                  TextField(controller: motivoCtrl, decoration: const InputDecoration(labelText: 'Motivo')),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Crear')),
          ],
        ),
      ),
    );

    if (creado != true || maquinariaId == null) return;
    try {
      await ApiClient.instance.post('/api/ordenes-trabajo', {
        'maquinaria_id': maquinariaId,
        'cliente_id': clienteId,
        'motivo': motivoCtrl.text.trim(),
      });
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Future<void> _abrirDetalle(Map<String, dynamic> orden) async {
    await showDialog(
      context: context,
      builder: (_) => _DetalleOrdenDialog(orden: orden, onCambio: _cargar),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final puedeCrear = auth.esAdministrativo || auth.esGerente;

    return Scaffold(
      floatingActionButton: puedeCrear
          ? FloatingActionButton.extended(onPressed: _abrirDialogoCrear, icon: const Icon(Icons.add), label: const Text('Nueva OT'))
          : null,
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text('Error: $_error'))
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _ordenes.length,
                    itemBuilder: (context, i) {
                      final o = _ordenes[i];
                      return Card(
                        child: ListTile(
                          title: Text('OT #${o['id']} - ${o['maquinaria_codigo'] ?? ''}'),
                          subtitle: Text('${o['motivo'] ?? ''} | Cliente: ${o['cliente_nombre'] ?? '-'}'),
                          trailing: Chip(
                            label: Text(o['estado']),
                            backgroundColor: GomaqColors.fondoChip(o['estado']),
                            labelStyle: TextStyle(color: GomaqColors.colorEstado(o['estado'])),
                          ),
                          onTap: () => _abrirDetalle(o),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}

class _DetalleOrdenDialog extends StatefulWidget {
  final Map<String, dynamic> orden;
  final VoidCallback onCambio;
  const _DetalleOrdenDialog({required this.orden, required this.onCambio});

  @override
  State<_DetalleOrdenDialog> createState() => _DetalleOrdenDialogState();
}

class _DetalleOrdenDialogState extends State<_DetalleOrdenDialog> {
  List<dynamic> _mecanicos = [];
  int? _mecanicoSeleccionado;
  final _valorizacionCtrl = TextEditingController();
  bool _cargandoAccion = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargarMecanicos());
  }

  Future<void> _cargarMecanicos() async {
    try {
      final data = await ApiClient.instance.get('/api/usuarios?rol=mecanico');
      if (mounted) setState(() => _mecanicos = data);
    } catch (_) {}
  }

  Future<void> _asignar() async {
    if (_mecanicoSeleccionado == null) return;
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/asignar', {'mecanico_id': _mecanicoSeleccionado});
      widget.onCambio();
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  Future<void> _aprobarValorizacion() async {
    final monto = double.tryParse(_valorizacionCtrl.text.trim());
    if (monto == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ingresa un monto valido')));
      return;
    }
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/valorizacion', {'valorizacion': monto});
      widget.onCambio();
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  final _folioCtrl = TextEditingController();

  Future<void> _subirFactura() async {
    if (_folioCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ingresa el numero de folio')));
      return;
    }
    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado == null || resultado.files.single.bytes == null) return;
    final archivo = resultado.files.single;

    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.postMultipart(
        '/api/ordenes-trabajo/${widget.orden['id']}/factura',
        bytes: archivo.bytes!,
        filename: archivo.name,
        fields: {'folio': _folioCtrl.text.trim()},
      );
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Factura subida correctamente')));
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final o = widget.orden;

    return AlertDialog(
      title: Text('OT #${o['id']} - ${o['maquinaria_codigo'] ?? ''}'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Estado: ${o['estado']}'),
              Text('Cliente: ${o['cliente_nombre'] ?? '-'}'),
              Text('Motivo: ${o['motivo'] ?? '-'}'),
              Text('Diagnostico: ${o['diagnostico'] ?? 'Aun sin diagnostico'}'),
              Text('Facturable: ${o['facturable'] == true ? 'Si' : 'No'}'),
              Text('Valorizacion: ${o['valorizacion'] ?? 'Sin aprobar'}'),
              const Divider(height: 32),

              if (auth.esAdministrativo && o['mecanico_id'] == null) ...[
                const Text('Asignar mecanico', style: TextStyle(fontWeight: FontWeight.bold)),
                DropdownButtonFormField<int>(
                  items: _mecanicos
                      .map<DropdownMenuItem<int>>((m) => DropdownMenuItem(value: m['id'], child: Text(m['nombre'])))
                      .toList(),
                  onChanged: (v) => setState(() => _mecanicoSeleccionado = v),
                ),
                FilledButton(
                  onPressed: _cargandoAccion ? null : _asignar,
                  child: const Text('Asignar'),
                ),
                const SizedBox(height: 16),
              ],

              if (auth.esGerente && o['facturable'] == true && o['valorizacion'] == null) ...[
                const Text('Aprobar valorizacion', style: TextStyle(fontWeight: FontWeight.bold)),
                TextField(
                  controller: _valorizacionCtrl,
                  decoration: const InputDecoration(labelText: 'Monto (CLP)'),
                  keyboardType: TextInputType.number,
                ),
                FilledButton(
                  onPressed: _cargandoAccion ? null : _aprobarValorizacion,
                  child: const Text('Aprobar'),
                ),
                const SizedBox(height: 16),
              ],

              if (auth.esAdministrativo && o['facturable'] == true) ...[
                const Text('Gestion documental - factura', style: TextStyle(fontWeight: FontWeight.bold)),
                TextField(controller: _folioCtrl, decoration: const InputDecoration(labelText: 'Numero de folio SII')),
                OutlinedButton.icon(
                  onPressed: _cargandoAccion ? null : _subirFactura,
                  icon: const Icon(Icons.upload_file),
                  label: const Text('Subir PDF de factura'),
                ),
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
