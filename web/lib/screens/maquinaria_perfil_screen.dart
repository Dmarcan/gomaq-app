import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';

const _etiquetasCategoria = {
  'grua_horquilla': 'Grúa Horquilla',
  'alzahombre': 'Alzahombre',
  'transpaleta': 'Transpaleta',
};

const _etiquetasCombustible = {
  'electrica': 'Eléctrica',
  'gas': 'Gas',
  'gasolina': 'Gasolina',
  'diesel': 'Diésel',
};

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

  Widget _fila(String etiqueta, String? valor) {
    if (valor == null || valor.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 160, child: Text(etiqueta, style: const TextStyle(color: Colors.black54, fontSize: 13))),
          Expanded(child: Text(valor, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();

    return Scaffold(
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
    final sinCategoria = categoria == null;
    final mostrarCapacidad = sinCategoria || categoria == 'grua_horquilla' || categoria == 'transpaleta';
    final mostrarMastil = sinCategoria || categoria == 'grua_horquilla';
    final mostrarCombustible = sinCategoria || categoria == 'grua_horquilla' || categoria == 'alzahombre';
    final mostrarMotorChasis = sinCategoria || categoria == 'grua_horquilla' || categoria == 'alzahombre';
    final mostrarAltura = sinCategoria || categoria == 'alzahombre';

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: m['foto_url'] != null
                    ? Image.network(m['foto_url'], width: 160, height: 160, fit: BoxFit.cover)
                    : Container(
                        width: 160,
                        height: 160,
                        color: Colors.grey.shade200,
                        child: const Icon(Icons.precision_manufacturing, size: 48, color: Colors.grey),
                      ),
              ),
              const SizedBox(width: 20),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${m['codigo']} - ${m['tipo']}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 6),
                    Chip(
                      label: Text(m['estado']),
                      backgroundColor: GomaqColors.fondoChip(m['estado']),
                      labelStyle: TextStyle(color: GomaqColors.colorEstado(m['estado'])),
                    ),
                    const SizedBox(height: 12),
                    if (auth.esAdministrativo)
                      OutlinedButton.icon(
                        onPressed: _subiendoFoto ? null : _cambiarFoto,
                        icon: _subiendoFoto
                            ? const SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.image_outlined, size: 16),
                        label: const Text('Cambiar foto'),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          const Text('FICHA TÉCNICA', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          const SizedBox(height: 12),
          _fila('Cliente actual', m['cliente']),
          _fila('Categoría', categoria != null ? _etiquetasCategoria[categoria] : null),
          _fila('Marca', m['marca']),
          _fila('Modelo', m['modelo']),
          _fila('Año', m['anio']?.toString()),
          if (mostrarCapacidad) _fila('Capacidad de carga', m['capacidad_carga'] != null ? '${m['capacidad_carga']} kg' : null),
          if (mostrarAltura) _fila('Altura de trabajo', m['altura_trabajo'] != null ? '${m['altura_trabajo']} m' : null),
          if (mostrarMastil) _fila('N° de mástil', m['numero_mastil']),
          if (mostrarCombustible)
            _fila('Combustible', m['tipo_combustible'] != null ? _etiquetasCombustible[m['tipo_combustible']] : null),
          if (mostrarMotorChasis) ...[
            _fila('N° de motor', m['numero_motor']),
            _fila('N° de chasis', m['numero_chasis']),
          ],
          _fila('N° de serie', m['numero_serie']),
          _fila('Descripción', m['descripcion']),
          const SizedBox(height: 24),
          const Text('HISTORIAL DE ÓRDENES DE TRABAJO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          const SizedBox(height: 12),
          if (_historial.isEmpty)
            const Text('Sin órdenes de trabajo registradas para este equipo', style: TextStyle(color: Colors.black54))
          else
            for (final ot in _historial)
              Card(
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
    );
  }
}
