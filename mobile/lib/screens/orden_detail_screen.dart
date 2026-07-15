import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';

class OrdenDetailScreen extends StatefulWidget {
  final int ordenId;
  const OrdenDetailScreen({super.key, required this.ordenId});

  @override
  State<OrdenDetailScreen> createState() => _OrdenDetailScreenState();
}

class _OrdenDetailScreenState extends State<OrdenDetailScreen> {
  OrdenTrabajo? _orden;
  final _diagnosticoCtrl = TextEditingController();
  List<Map<String, dynamic>> _fotosLocales = [];

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
    if (!mounted || rows.isEmpty) return;
    setState(() {
      _orden = OrdenTrabajo.fromLocalMap(rows.first);
      _diagnosticoCtrl.text = _orden!.diagnostico ?? '';
      _fotosLocales = fotos;
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
          Chip(label: Text('Estado: ${orden.estado}')),
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
