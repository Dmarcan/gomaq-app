import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';

class FlotaScreen extends StatefulWidget {
  const FlotaScreen({super.key});

  @override
  State<FlotaScreen> createState() => _FlotaScreenState();
}

class _FlotaScreenState extends State<FlotaScreen> {
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
      final data = await ApiClient.instance.get('/api/maquinarias');
      if (!mounted) return;
      setState(() => _maquinarias = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear() async {
    final codigoCtrl = TextEditingController();
    final tipoCtrl = TextEditingController();
    final ubicacionCtrl = TextEditingController();

    final creado = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Nueva maquinaria'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: codigoCtrl, decoration: const InputDecoration(labelText: 'Codigo (ej. GH-204)')),
            TextField(controller: tipoCtrl, decoration: const InputDecoration(labelText: 'Tipo (ej. Grua Horquilla)')),
            TextField(controller: ubicacionCtrl, decoration: const InputDecoration(labelText: 'Ubicacion (opcional)')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Crear')),
        ],
      ),
    );

    if (creado != true) return;
    try {
      await ApiClient.instance.post('/api/maquinarias', {
        'codigo': codigoCtrl.text.trim(),
        'tipo': tipoCtrl.text.trim(),
        'ubicacion': ubicacionCtrl.text.trim().isEmpty ? null : ubicacionCtrl.text.trim(),
      });
      _cargar();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      }
    }
  }

  Future<void> _subirGuia(int maquinariaId) async {
    final tipo = await showDialog<String>(
      context: context,
      builder: (_) => SimpleDialog(
        title: const Text('Tipo de guia'),
        children: [
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'despacho'), child: const Text('Guia de Despacho')),
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'recepcion'), child: const Text('Guia de Recepcion')),
        ],
      ),
    );
    if (tipo == null) return;

    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado == null || resultado.files.single.bytes == null) return;
    final archivo = resultado.files.single;

    try {
      await ApiClient.instance.postMultipart(
        '/api/maquinarias/$maquinariaId/guias',
        bytes: archivo.bytes!,
        filename: archivo.name,
        fields: {'tipo': tipo},
      );
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Guia subida correctamente')));
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }


  @override
  Widget build(BuildContext context) {
    final puedeEscribir = context.watch<AuthService>().esAdministrativo;

    return Scaffold(
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nueva maquinaria'),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text('Error: $_error'))
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _maquinarias.length,
                    itemBuilder: (context, i) {
                      final m = _maquinarias[i];
                      return Card(
                        child: ListTile(
                          title: Text('${m['codigo']} - ${m['tipo']}'),
                          subtitle: Text('Cliente: ${m['cliente'] ?? '-'} | ${m['ubicacion'] ?? 'Sin ubicacion'}'),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (puedeEscribir)
                                IconButton(
                                  icon: const Icon(Icons.upload_file),
                                  tooltip: 'Subir guia de despacho/recepcion',
                                  onPressed: () => _subirGuia(m['id']),
                                ),
                              Chip(
                                label: Text(m['estado']),
                                backgroundColor: GomaqColors.fondoChip(m['estado']),
                                labelStyle: TextStyle(color: GomaqColors.colorEstado(m['estado'])),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
