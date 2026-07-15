import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/ficha_tecnica_campos.dart';

class MaquinariaPerfilScreen extends StatefulWidget {
  final int maquinariaId;
  const MaquinariaPerfilScreen({super.key, required this.maquinariaId});

  @override
  State<MaquinariaPerfilScreen> createState() => _MaquinariaPerfilScreenState();
}

class _MaquinariaPerfilScreenState extends State<MaquinariaPerfilScreen> {
  Map<String, dynamic>? _maquinaria;
  List<dynamic> _historial = [];
  bool _cargando = true;
  String? _error;
  bool _subiendoFoto = false;

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
      final maquinaria = await ApiClient.instance.get('/api/maquinarias/${widget.maquinariaId}');
      final historial = await ApiClient.instance.get('/api/maquinarias/${widget.maquinariaId}/ordenes-trabajo');
      if (!mounted) return;
      setState(() {
        _maquinaria = maquinaria;
        _historial = historial;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _cambiarFoto() async {
    final resultado = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['jpg', 'jpeg', 'png'],
      withData: true,
    );
    if (resultado == null || resultado.files.single.bytes == null) return;

    setState(() => _subiendoFoto = true);
    try {
      await ApiClient.instance.patchMultipart(
        '/api/maquinarias/${widget.maquinariaId}/foto',
        bytes: resultado.files.single.bytes,
        filename: resultado.files.single.name,
      );
      await _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _subiendoFoto = false);
    }
  }

  Future<void> _editarFichaTecnica() async {
    final m = _maquinaria!;
    final tipoCtrl = TextEditingController(text: m['tipo'] ?? '');
    final ubicacionCtrl = TextEditingController(text: m['ubicacion'] ?? '');
    final marcaCtrl = TextEditingController(text: m['marca'] ?? '');
    final modeloCtrl = TextEditingController(text: m['modelo'] ?? '');
    final anioCtrl = TextEditingController(text: m['anio']?.toString() ?? '');
    final descripcionCtrl = TextEditingController(text: m['descripcion'] ?? '');
    final capacidadCargaCtrl = TextEditingController(text: m['capacidad_carga']?.toString() ?? '');
    final alturaTrabajoCtrl = TextEditingController(text: m['altura_trabajo']?.toString() ?? '');
    final numeroSerieCtrl = TextEditingController(text: m['numero_serie'] ?? '');
    final numeroMotorCtrl = TextEditingController(text: m['numero_motor'] ?? '');
    final numeroChasisCtrl = TextEditingController(text: m['numero_chasis'] ?? '');
    final numeroMastilCtrl = TextEditingController(text: m['numero_mastil'] ?? '');
    String? categoria = m['categoria_equipo'];
    String? combustible = m['tipo_combustible'];

    final guardado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text('Editar ${m['codigo']}'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextField(controller: tipoCtrl, decoration: const InputDecoration(labelText: 'Tipo')),
                  TextField(controller: ubicacionCtrl, decoration: const InputDecoration(labelText: 'Ubicación')),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: categoria,
                    decoration: const InputDecoration(labelText: 'Categoría'),
                    items: [for (final c in categoriasEquipo) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
                    onChanged: (v) => setDialogState(() => categoria = v),
                  ),
                  const SizedBox(height: 12),
                  const Text('FICHA TÉCNICA', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                  ...camposFichaTecnica(
                    categoria: categoria,
                    combustible: combustible,
                    onCombustibleChanged: (v) => setDialogState(() => combustible = v),
                    marcaCtrl: marcaCtrl,
                    modeloCtrl: modeloCtrl,
                    anioCtrl: anioCtrl,
                    capacidadCargaCtrl: capacidadCargaCtrl,
                    alturaTrabajoCtrl: alturaTrabajoCtrl,
                    numeroMastilCtrl: numeroMastilCtrl,
                    numeroMotorCtrl: numeroMotorCtrl,
                    numeroChasisCtrl: numeroChasisCtrl,
                    numeroSerieCtrl: numeroSerieCtrl,
                    descripcionCtrl: descripcionCtrl,
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Guardar')),
          ],
        ),
      ),
    );

    if (guardado != true) return;
    try {
      await ApiClient.instance.patch('/api/maquinarias/${widget.maquinariaId}', {
        'tipo': tipoCtrl.text.trim().isEmpty ? null : tipoCtrl.text.trim(),
        'ubicacion': ubicacionCtrl.text.trim().isEmpty ? null : ubicacionCtrl.text.trim(),
        'categoria_equipo': categoria,
        'marca': marcaCtrl.text.trim().isEmpty ? null : marcaCtrl.text.trim(),
        'modelo': modeloCtrl.text.trim().isEmpty ? null : modeloCtrl.text.trim(),
        'anio': anioCtrl.text.trim().isEmpty ? null : int.tryParse(anioCtrl.text.trim()),
        'descripcion': descripcionCtrl.text.trim().isEmpty ? null : descripcionCtrl.text.trim(),
        'capacidad_carga': capacidadCargaCtrl.text.trim().isEmpty ? null : double.tryParse(capacidadCargaCtrl.text.trim()),
        'altura_trabajo': alturaTrabajoCtrl.text.trim().isEmpty ? null : double.tryParse(alturaTrabajoCtrl.text.trim()),
        'numero_serie': numeroSerieCtrl.text.trim().isEmpty ? null : numeroSerieCtrl.text.trim(),
        'numero_motor': numeroMotorCtrl.text.trim().isEmpty ? null : numeroMotorCtrl.text.trim(),
        'numero_chasis': numeroChasisCtrl.text.trim().isEmpty ? null : numeroChasisCtrl.text.trim(),
        'numero_mastil': numeroMastilCtrl.text.trim().isEmpty ? null : numeroMastilCtrl.text.trim(),
        'tipo_combustible': combustible,
      });
      await _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Widget _tile(String etiqueta, String? valor) {
    if (valor == null || valor.trim().isEmpty) return const SizedBox.shrink();
    return Container(
      width: 180,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: Colors.grey.shade200),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(etiqueta, style: const TextStyle(fontSize: 11, color: Colors.black54)),
          const SizedBox(height: 4),
          Text(valor, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();

    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F8),
      appBar: AppBar(title: Text(_maquinaria != null ? '${_maquinaria!['codigo']}' : 'Equipo')),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text('Error: $_error'))
              : _construirContenido(auth),
    );
  }

  Widget _construirContenido(AuthService auth) {
    final m = _maquinaria!;
    final categoria = m['categoria_equipo'] as String?;

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 16, offset: const Offset(0, 4))],
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: m['foto_url'] != null
                      ? Image.network(m['foto_url'], width: 160, height: 160, fit: BoxFit.cover)
                      : Container(
                          width: 160,
                          height: 160,
                          color: GomaqColors.primario.withValues(alpha: 0.08),
                          child: Icon(iconoCategoria(categoria), size: 48, color: GomaqColors.primario),
                        ),
                ),
                const SizedBox(width: 20),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(iconoCategoria(categoria), size: 18, color: GomaqColors.primario),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              '${m['codigo']} - ${m['tipo']}',
                              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (categoria != null)
                        Text(etiquetasCategoria[categoria] ?? '', style: const TextStyle(color: Colors.black54, fontSize: 13)),
                      const SizedBox(height: 10),
                      Chip(
                        label: Text(m['estado']),
                        backgroundColor: GomaqColors.fondoChip(m['estado']),
                        labelStyle: TextStyle(color: GomaqColors.colorEstado(m['estado'])),
                      ),
                      const SizedBox(height: 14),
                      if (auth.esAdministrativo)
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            OutlinedButton.icon(
                              onPressed: _subiendoFoto ? null : _cambiarFoto,
                              icon: _subiendoFoto
                                  ? const SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2))
                                  : const Icon(Icons.image_outlined, size: 16),
                              label: const Text('Cambiar foto'),
                            ),
                            FilledButton.icon(
                              onPressed: _editarFichaTecnica,
                              icon: const Icon(Icons.edit, size: 16),
                              label: const Text('Editar ficha técnica'),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          const Text('FICHA TÉCNICA', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              _tile('Cliente actual', m['cliente']),
              _tile('Marca', m['marca']),
              _tile('Modelo', m['modelo']),
              _tile('Año', m['anio']?.toString()),
              if (mostrarCapacidad(categoria)) _tile('Capacidad de carga', m['capacidad_carga'] != null ? '${m['capacidad_carga']} kg' : null),
              if (mostrarAltura(categoria)) _tile('Altura de trabajo', m['altura_trabajo'] != null ? '${m['altura_trabajo']} m' : null),
              if (mostrarMastil(categoria)) _tile('N° de mástil', m['numero_mastil']),
              if (mostrarCombustible(categoria))
                _tile('Combustible', m['tipo_combustible'] != null ? etiquetasCombustible[m['tipo_combustible']] : null),
              if (mostrarMotorChasis(categoria)) ...[
                _tile('N° de motor', m['numero_motor']),
                _tile('N° de chasis', m['numero_chasis']),
              ],
              _tile('N° de serie', m['numero_serie']),
            ],
          ),
          if ((m['descripcion'] as String?)?.trim().isNotEmpty ?? false) ...[
            const SizedBox(height: 16),
            Text(m['descripcion'], style: const TextStyle(fontSize: 13, color: Colors.black87)),
          ],
          const SizedBox(height: 28),
          const Text('HISTORIAL DE ÓRDENES DE TRABAJO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          const SizedBox(height: 12),
          if (_historial.isEmpty)
            const Text('Sin órdenes de trabajo registradas para este equipo', style: TextStyle(color: Colors.black54))
          else
            for (final ot in _historial)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.grey.shade200),
                ),
                child: IntrinsicHeight(
                  child: Row(
                    children: [
                      Container(
                        width: 4,
                        decoration: BoxDecoration(
                          color: GomaqColors.colorEstado(ot['estado']),
                          borderRadius: const BorderRadius.horizontal(left: Radius.circular(10)),
                        ),
                      ),
                      Expanded(
                        child: ListTile(
                          title: Text('OT #${ot['id']} · ${ot['motivo'] ?? 'Sin motivo especificado'}'),
                          subtitle: Text(
                            '${ot['diagnostico'] ?? 'Sin diagnóstico'}\n${(ot['fecha_creacion'] as String).split('T').first}'
                            '${ot['fecha_cierre'] != null ? ' → ${(ot['fecha_cierre'] as String).split('T').first}' : ''}',
                          ),
                          isThreeLine: true,
                          trailing: Chip(
                            label: Text(ot['estado']),
                            backgroundColor: GomaqColors.fondoChip(ot['estado']),
                            labelStyle: TextStyle(color: GomaqColors.colorEstado(ot['estado'])),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
        ],
      ),
    );
  }
}
