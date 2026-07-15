import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';

class OrdenDetailScreen extends StatefulWidget {
  final int ordenId;
  const OrdenDetailScreen({super.key, required this.ordenId});

  @override
  State<OrdenDetailScreen> createState() => _OrdenDetailScreenState();
}

class _OrdenDetailScreenState extends State<OrdenDetailScreen> {
  OrdenTrabajo? _orden;
  final _diagnosticoCtrl = TextEditingController();
  final _cantidadInsumoCtrl = TextEditingController();
  List<Map<String, dynamic>> _fotosLocales = [];
  List<Map<String, dynamic>> _insumosLocales = [];
  List<Map<String, dynamic>> _catalogoInsumos = [];
  int? _insumoSeleccionadoId;

  static const estadosDisponibles = ['en_terreno', 'en_reparacion'];

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final db = await LocalDatabase.instance.database;
    final rows = await db.query('ordenes_locales', where: 'id = ?', whereArgs: [widget.ordenId]);
    final fotos = await db.query('evidencias_locales', where: 'orden_trabajo_id = ?', whereArgs: [widget.ordenId]);
    final insumos = await db.query('insumos_locales', where: 'orden_trabajo_id = ?', whereArgs: [widget.ordenId]);
    final catalogo = await db.query('insumos_catalogo_local', orderBy: 'nombre ASC');
    if (!mounted || rows.isEmpty) return;
    setState(() {
      _orden = OrdenTrabajo.fromLocalMap(rows.first);
      _diagnosticoCtrl.text = _orden!.diagnostico ?? '';
      _fotosLocales = fotos;
      _insumosLocales = insumos;
      _catalogoInsumos = catalogo;
      if (_insumoSeleccionadoId == null && catalogo.isNotEmpty) {
        _insumoSeleccionadoId = catalogo.first['id'] as int;
      }
    });
  }

  Future<void> _intentarSincronizarAhora() async {
    if (!context.read<ConnectivityService>().online) return;
    try {
      await context.read<SyncService>().sincronizar();
    } catch (_) {
      // queda encolado para reintentar despues
    }
  }

  Future<void> _guardarDiagnostico({String? estado}) async {
    await context.read<SyncService>().encolarDiagnostico(
          widget.ordenId,
          diagnostico: _diagnosticoCtrl.text.trim(),
          estado: estado,
        );
    await _cargar();
    _intentarSincronizarAhora();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Guardado localmente, se sincroniza cuando haya señal')),
      );
    }
  }

  Future<void> _tomarFoto() async {
    final syncService = context.read<SyncService>();
    final picker = ImagePicker();
    final foto = await picker.pickImage(source: ImageSource.camera, imageQuality: 80);
    if (foto == null) return;

    final dir = await getApplicationDocumentsDirectory();
    final nombreArchivo = 'ot${widget.ordenId}_${DateTime.now().millisecondsSinceEpoch}.jpg';
    final rutaLocal = '${dir.path}/$nombreArchivo';
    await File(foto.path).copy(rutaLocal);

    await syncService.encolarEvidencia(widget.ordenId, rutaLocal);
    await _cargar();
    _intentarSincronizarAhora();
  }

  Future<void> _agregarInsumo() async {
    final insumoId = _insumoSeleccionadoId;
    final cantidad = double.tryParse(_cantidadInsumoCtrl.text.replaceAll(',', '.'));
    if (insumoId == null || cantidad == null || cantidad <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Selecciona un insumo y una cantidad valida')),
      );
      return;
    }
    final insumo = _catalogoInsumos.firstWhere((i) => i['id'] == insumoId);
    await context.read<SyncService>().encolarInsumo(widget.ordenId, insumoId, insumo['nombre'] as String, cantidad);
    _cantidadInsumoCtrl.clear();
    await _cargar();
    _intentarSincronizarAhora();
  }

  Future<void> _finalizar() async {
    final syncService = context.read<SyncService>();
    final confirmar = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Finalizar orden de trabajo'),
        content: const Text('¿Confirmas que el trabajo esta terminado?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Finalizar')),
        ],
      ),
    );
    if (confirmar != true) return;

    await syncService.encolarFinalizar(widget.ordenId);
    await _cargar();
    _intentarSincronizarAhora();
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final orden = _orden;
    if (orden == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      appBar: AppBar(title: Text(orden.maquinariaCodigo ?? 'OT #${orden.id}')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Cliente: ${orden.clienteNombre ?? "-"}'),
          const SizedBox(height: 4),
          Text('Motivo: ${orden.motivo ?? "-"}'),
          const SizedBox(height: 4),
          Chip(
            label: Text('Estado: ${orden.estado}'),
            backgroundColor: GomaqColors.fondoChip(orden.estado),
            labelStyle: TextStyle(color: GomaqColors.colorEstado(orden.estado)),
          ),
          const SizedBox(height: 24),

          const Text('Diagnostico', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          TextField(
            controller: _diagnosticoCtrl,
            maxLines: 4,
            decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'Describe el problema encontrado...'),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton(
                onPressed: () => _guardarDiagnostico(),
                child: const Text('Guardar diagnostico'),
              ),
              for (final estado in estadosDisponibles)
                OutlinedButton(
                  onPressed: () => _guardarDiagnostico(estado: estado),
                  child: Text('Marcar: $estado'),
                ),
            ],
          ),

          const SizedBox(height: 24),
          const Text('Evidencia fotografica', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final foto in _fotosLocales)
                Stack(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.file(File(foto['ruta_local'] as String), width: 80, height: 80, fit: BoxFit.cover),
                    ),
                    if (foto['sincronizado'] == 0)
                      const Positioned(
                        right: 2,
                        top: 2,
                        child: Icon(Icons.cloud_upload, size: 16, color: Colors.orange),
                      ),
                  ],
                ),
              InkWell(
                onTap: _tomarFoto,
                child: Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(border: Border.all(color: Colors.grey), borderRadius: BorderRadius.circular(8)),
                  child: const Icon(Icons.camera_alt),
                ),
              ),
            ],
          ),

          const SizedBox(height: 24),
          const Text('Insumos utilizados', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (_catalogoInsumos.isEmpty)
            const Text('Sin senal para cargar el catalogo de insumos todavia', style: TextStyle(color: Colors.grey))
          else
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<int>(
                    initialValue: _insumoSeleccionadoId,
                    decoration: const InputDecoration(border: OutlineInputBorder(), isDense: true),
                    items: [
                      for (final insumo in _catalogoInsumos)
                        DropdownMenuItem(
                          value: insumo['id'] as int,
                          child: Text('${insumo['nombre']} (${insumo['unidad_medida']})'),
                        ),
                    ],
                    onChanged: (v) => setState(() => _insumoSeleccionadoId = v),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 80,
                  child: TextField(
                    controller: _cantidadInsumoCtrl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(border: OutlineInputBorder(), isDense: true, hintText: 'Cant.'),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(onPressed: _agregarInsumo, icon: const Icon(Icons.add_circle)),
              ],
            ),
          const SizedBox(height: 8),
          for (final insumo in _insumosLocales)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.build_circle_outlined),
              title: Text('${insumo['insumo_nombre']} - ${insumo['cantidad']}'),
              trailing: insumo['sincronizado'] == 0
                  ? const Icon(Icons.cloud_upload, size: 16, color: Colors.orange)
                  : const Icon(Icons.cloud_done, size: 16, color: Colors.green),
            ),

          const SizedBox(height: 32),
          if (orden.estado != 'finalizada')
            SizedBox(
              width: double.infinity,
              child: FilledButton(onPressed: _finalizar, child: const Text('Finalizar Orden de Trabajo')),
            ),
        ],
      ),
    );
  }
}
