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
import '../widgets/estado_chip.dart';
import '../widgets/foto_thumbnail.dart';
import '../widgets/seccion_bloqueada.dart';

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
  bool _facturable = false;

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
      _facturable = _orden!.facturable;
      _fotosLocales = fotos;
      _insumosLocales = insumos;
      _catalogoInsumos = catalogo;
      if (_insumoSeleccionadoId == null && catalogo.isNotEmpty) {
        _insumoSeleccionadoId = catalogo.first['id'] as int;
      }
    });
  }

  Future<void> _intentarSincronizarAhora() async {
    if (!mounted) return; // se invoca tras awaits: la pantalla pudo cerrarse en el intertanto
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

  Future<void> _iniciarTrabajo() async {
    await _guardarDiagnostico(estado: 'en_terreno');
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
        content: Text(
          _facturable
              ? 'El trabajo quedara marcado como FACTURABLE (se cobra al cliente). ¿Confirmas que esta terminado?'
              : '¿Confirmas que el trabajo esta terminado?',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Finalizar')),
        ],
      ),
    );
    if (confirmar != true) return;

    await syncService.encolarFinalizar(widget.ordenId, facturable: _facturable);
    await _cargar();
    _intentarSincronizarAhora();
    if (mounted) Navigator.pop(context);
  }

  // ---------- Secciones de UI ----------

  Widget _tituloSeccion(IconData icono, String texto) {
    return Row(
      children: [
        Icon(icono, size: 18, color: GomaqColors.primario),
        const SizedBox(width: 8),
        Text(texto, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
      ],
    );
  }

  Widget _cabecera(OrdenTrabajo orden) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                EstadoChip(estado: orden.estado),
                Text(
                  'OT-${orden.id}',
                  style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 12),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              orden.maquinariaCodigo ?? 'Sin código',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            if (orden.motivo != null && orden.motivo!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(orden.motivo!, style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 13)),
            ],
            if (orden.clienteNombre != null) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  const Icon(Icons.business_outlined, size: 15, color: GomaqColors.textoSecundario),
                  const SizedBox(width: 6),
                  Text(orden.clienteNombre!, style: const TextStyle(fontSize: 13)),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _seccionFotos({required bool puedeAgregar}) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.photo_camera_outlined, 'Evidencia fotográfica'),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final foto in _fotosLocales)
                  FotoThumbnail(
                    rutaLocal: foto['ruta_local'] as String,
                    sincronizada: foto['sincronizado'] != 0,
                    creadoEn: foto['creado_en'] as String?,
                  ),
                if (puedeAgregar)
                  InkWell(
                    onTap: _tomarFoto,
                    borderRadius: BorderRadius.circular(10),
                    child: Container(
                      width: 92,
                      height: 92,
                      decoration: BoxDecoration(
                        border: Border.all(color: GomaqColors.primario.withValues(alpha: 0.6)),
                        borderRadius: BorderRadius.circular(10),
                        color: GomaqColors.primario.withValues(alpha: 0.08),
                      ),
                      child: const Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.add_a_photo_outlined, color: GomaqColors.primario),
                          SizedBox(height: 4),
                          Text('Agregar', style: TextStyle(fontSize: 11, color: GomaqColors.primario)),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _seccionDiagnostico({required bool soloLectura, required bool enTerreno}) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.build_outlined, 'Diagnóstico y trabajo realizado'),
            const SizedBox(height: 12),
            TextField(
              controller: _diagnosticoCtrl,
              maxLines: 4,
              readOnly: soloLectura,
              decoration: const InputDecoration(hintText: 'Describe el problema encontrado y los pasos realizados...'),
            ),
            if (!soloLectura) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => _guardarDiagnostico(),
                      icon: const Icon(Icons.save_outlined, size: 18),
                      label: const Text('Guardar'),
                    ),
                  ),
                  if (enTerreno) ...[
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _guardarDiagnostico(estado: 'en_reparacion'),
                        icon: const Icon(Icons.handyman_outlined, size: 18),
                        label: const Text('En reparación'),
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _seccionInsumos({required bool soloLectura}) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.inventory_2_outlined, 'Insumos y repuestos'),
            const SizedBox(height: 12),
            if (!soloLectura) ...[
              if (_catalogoInsumos.isEmpty)
                const Text(
                  'Sin señal para cargar el catálogo de insumos todavía',
                  style: TextStyle(color: GomaqColors.textoSecundario),
                )
              else
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<int>(
                        initialValue: _insumoSeleccionadoId,
                        decoration: const InputDecoration(isDense: true),
                        items: [
                          for (final insumo in _catalogoInsumos)
                            DropdownMenuItem(
                              value: insumo['id'] as int,
                              child: Text(
                                '${insumo['nombre']} (${insumo['unidad_medida']})',
                                overflow: TextOverflow.ellipsis,
                              ),
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
                        decoration: const InputDecoration(isDense: true, hintText: 'Cant.'),
                      ),
                    ),
                    const SizedBox(width: 4),
                    IconButton(
                      onPressed: _agregarInsumo,
                      icon: const Icon(Icons.add_circle, color: GomaqColors.primario, size: 30),
                    ),
                  ],
                ),
              const SizedBox(height: 4),
            ],
            if (_insumosLocales.isEmpty && soloLectura)
              const Text('Sin insumos registrados', style: TextStyle(color: GomaqColors.textoSecundario)),
            for (final insumo in _insumosLocales)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.build_circle_outlined),
                title: Text('${insumo['insumo_nombre']} - ${insumo['cantidad']}'),
                trailing: insumo['sincronizado'] == 0
                    ? const Icon(Icons.cloud_upload, size: 16, color: GomaqColors.estadoAdvertencia)
                    : const Icon(Icons.cloud_done, size: 16, color: GomaqColors.estadoPositivo),
              ),
          ],
        ),
      ),
    );
  }

  Widget _seccionFacturable({required bool soloLectura}) {
    return Card(
      child: SwitchListTile(
        title: const Text('Trabajo facturable', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
        subtitle: const Text(
          'Marcar si el trabajo se cobra al cliente (daño de su responsabilidad)',
          style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
        ),
        activeThumbColor: GomaqColors.primario,
        value: _facturable,
        onChanged: soloLectura ? null : (v) => setState(() => _facturable = v),
      ),
    );
  }

  Widget? _botonInferior(OrdenTrabajo orden) {
    final String texto;
    final IconData icono;
    final VoidCallback accion;

    switch (orden.estado) {
      case 'asignada':
      case 'pendiente':
        texto = 'INICIAR TRABAJO';
        icono = Icons.play_circle_outline;
        accion = _iniciarTrabajo;
        break;
      case 'en_terreno':
      case 'en_reparacion':
        texto = 'FINALIZAR TRABAJO';
        icono = Icons.check_circle_outline;
        accion = _finalizar;
        break;
      default:
        return null; // finalizada u otro estado terminal: sin accion
    }

    return SafeArea(
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
        decoration: const BoxDecoration(
          color: GomaqColors.fondoOscuro,
          border: Border(top: BorderSide(color: GomaqColors.bordeSutil)),
        ),
        child: SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: accion,
            icon: Icon(icono),
            label: Text(texto),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final orden = _orden;
    if (orden == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final asignada = orden.estado == 'asignada' || orden.estado == 'pendiente';
    final enProgreso = orden.estado == 'en_terreno' || orden.estado == 'en_reparacion';
    final finalizada = orden.estado == 'finalizada';

    return Scaffold(
      appBar: AppBar(title: Text('OT-${orden.id}')),
      bottomNavigationBar: _botonInferior(orden),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _cabecera(orden),

          // Flujo guiado: antes de iniciar solo se documenta el estado inicial;
          // diagnostico e insumos se desbloquean al pasar a en_terreno.
          if (asignada) ...[
            _seccionFotos(puedeAgregar: true),
            const SeccionBloqueada(titulo: 'Diagnóstico y trabajo realizado', icono: Icons.build_outlined),
            const SeccionBloqueada(titulo: 'Insumos y repuestos', icono: Icons.inventory_2_outlined),
          ] else if (enProgreso) ...[
            _seccionDiagnostico(soloLectura: false, enTerreno: orden.estado == 'en_terreno'),
            _seccionInsumos(soloLectura: false),
            _seccionFotos(puedeAgregar: true),
            _seccionFacturable(soloLectura: false),
          ] else if (finalizada) ...[
            _seccionDiagnostico(soloLectura: true, enTerreno: false),
            _seccionInsumos(soloLectura: true),
            _seccionFotos(puedeAgregar: false),
            _seccionFacturable(soloLectura: true),
          ] else ...[
            // estado no contemplado: mostrar todo editable para no bloquear al mecanico
            _seccionDiagnostico(soloLectura: false, enTerreno: false),
            _seccionInsumos(soloLectura: false),
            _seccionFotos(puedeAgregar: true),
          ],
        ],
      ),
    );
  }
}
