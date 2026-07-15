import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

class GuiasScreen extends StatefulWidget {
  const GuiasScreen({super.key});

  @override
  State<GuiasScreen> createState() => _GuiasScreenState();
}

class _GuiasScreenState extends State<GuiasScreen> {
  List<dynamic> _maquinarias = [];
  Map<String, dynamic>? _seleccionada;
  String _tipo = 'despacho';
  PlatformFile? _archivo;
  bool _subiendo = false;
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargarMaquinarias());
  }

  Future<void> _cargarMaquinarias() async {
    try {
      final data = await ApiClient.instance.get('/api/maquinarias');
      if (mounted) setState(() => _maquinarias = data);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
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

  Future<void> _guardar() async {
    if (_seleccionada == null || _archivo == null) return;
    setState(() => _subiendo = true);
    try {
      await ApiClient.instance.postMultipart(
        '/api/maquinarias/${_seleccionada!['id']}/guias',
        bytes: _archivo!.bytes!,
        filename: _archivo!.name,
        fields: {'tipo': _tipo},
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Guia guardada correctamente')));
        setState(() => _archivo = null);
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _subiendo = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());

    return Padding(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('El sistema calcula automáticamente los días de arriendo al cruzar ambos documentos',
                style: TextStyle(color: Colors.black54)),
            const SizedBox(height: 20),
            const Text('EQUIPO ASOCIADO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            DropdownButtonFormField<Map<String, dynamic>>(
              initialValue: _seleccionada,
              items: _maquinarias
                  .map<DropdownMenuItem<Map<String, dynamic>>>(
                    (m) => DropdownMenuItem(value: m, child: Text('${m['codigo']} - ${m['tipo']}')),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _seleccionada = v),
              decoration: const InputDecoration(border: OutlineInputBorder()),
            ),
            const SizedBox(height: 20),
            const Text('TIPO DE DOCUMENTO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: _botonTipo('despacho', 'Guía de Despacho'),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _botonTipo('recepcion', 'Guía de Recepción'),
                ),
              ],
            ),
            const SizedBox(height: 20),
            const Text('DOCUMENTO PDF', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            InkWell(
              onTap: _elegirArchivo,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(32),
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey.shade400, style: BorderStyle.solid),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  children: [
                    const Icon(Icons.upload_file, size: 32, color: Colors.grey),
                    const SizedBox(height: 8),
                    Text(_archivo?.name ?? 'Haz clic para buscar un archivo PDF', textAlign: TextAlign.center),
                    if (_archivo == null) const Text('Solo PDF · hasta 10 MB', style: TextStyle(fontSize: 12, color: Colors.grey)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: (_seleccionada != null && _archivo != null && !_subiendo) ? _guardar : null,
              child: _subiendo
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Guardar Guía'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _botonTipo(String valor, String etiqueta) {
    final activo = _tipo == valor;
    return OutlinedButton(
      onPressed: () => setState(() => _tipo = valor),
      style: OutlinedButton.styleFrom(
        backgroundColor: activo ? GomaqColors.primario : Colors.white,
        foregroundColor: activo ? Colors.white : GomaqColors.primario,
      ),
      child: Text(etiqueta),
    );
  }
}
