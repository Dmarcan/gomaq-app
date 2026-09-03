import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import '../config/reglas_negocio.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/estado_chip.dart';
import '../widgets/foto_thumbnail.dart';
import '../widgets/seccion_bloqueada.dart';
import 'cerrar_orden_screen.dart';
import 'maquinaria_historial_screen.dart';

class OrdenDetailScreen extends StatefulWidget {
  final int ordenId;
  const OrdenDetailScreen({super.key, required this.ordenId});

  @override
  State<OrdenDetailScreen> createState() => _OrdenDetailScreenState();
}

class _OrdenDetailScreenState extends State<OrdenDetailScreen> {
  OrdenTrabajo? _orden;
  final _diagnosticoCtrl = TextEditingController();
  final _observacionFinalCtrl = TextEditingController();
  final _folioPapelCtrl = TextEditingController();
  final _cantidadInsumoCtrl = TextEditingController();
  final _descripcionInsumoCtrl = TextEditingController();
  final _precioInsumoCtrl = TextEditingController();
  List<Map<String, dynamic>> _fotosLocales = [];
  List<Map<String, dynamic>> _insumosLocales = [];
  List<Map<String, dynamic>> _catalogoInsumos = [];
  List<Map<String, dynamic>> _catalogoChecklist = [];
  List<Map<String, dynamic>> _tramosLocales = [];
  Set<int> _serviciosMarcados = {};
  int? _insumoSeleccionadoId;
  String? _tipoServicio;
  String _facturableLinea = 'pendiente';

  /// Los seis tipos del talonario, en el mismo orden que el papel.
  static const _tiposServicio = [
    ('preventivo', 'Preventivo'),
    ('reparacion', 'Reparación'),
    ('garantia_full_mantencion', 'Garantía / Full Mantención'),
    ('correctivo', 'Correctivo'),
    ('bateria_cargador', 'Batería / Cargador'),
    ('administrativo', 'Administrativo'),
  ];

  static const _titulosGrupo = {
    'mecanicos': 'Servicios mecánicos',
    'electronicos': 'Servicios electrónicos',
    'hidraulicos': 'Servicios hidráulicos',
    'administrativos': 'Servicios administrativos',
    'complementos': 'Complementos máquinas',
  };

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  @override
  void dispose() {
    _diagnosticoCtrl.dispose();
    _observacionFinalCtrl.dispose();
    _folioPapelCtrl.dispose();
    _cantidadInsumoCtrl.dispose();
    _descripcionInsumoCtrl.dispose();
    _precioInsumoCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    final db = await LocalDatabase.instance.database;
    final rows = await db.query('ordenes_locales', where: 'id = ?', whereArgs: [widget.ordenId]);
    final fotos = await db.query('evidencias_locales', where: 'orden_trabajo_id = ?', whereArgs: [widget.ordenId]);
    final insumos = await db.query('insumos_locales', where: 'orden_trabajo_id = ?', whereArgs: [widget.ordenId]);
    final catalogo = await db.query('insumos_catalogo_local', orderBy: 'nombre ASC');
    final checklist = await db.query('checklist_catalogo_local', orderBy: 'orden ASC');
    final marcados = await db.query('ot_servicios_locales', where: 'orden_trabajo_id = ?', whereArgs: [widget.ordenId]);
    final tramos = await db.query('tramos_locales', where: 'orden_trabajo_id = ?', whereArgs: [widget.ordenId], orderBy: 'inicio ASC');
    if (!mounted || rows.isEmpty) return;
    setState(() {
      _orden = OrdenTrabajo.fromLocalMap(rows.first);
      _diagnosticoCtrl.text = _orden!.diagnostico ?? '';
      _fotosLocales = fotos;
      _insumosLocales = insumos;
      _catalogoInsumos = catalogo;
      _catalogoChecklist = checklist;
      _serviciosMarcados = marcados.map((m) => m['servicio_id'] as int).toSet();
      _tramosLocales = tramos;
      if (_insumoSeleccionadoId == null && catalogo.isNotEmpty) {
        _insumoSeleccionadoId = catalogo.first['id'] as int;
      }
    });
  }

  /// Guarda la cabecera del talonario: tipo de servicio, observación final y folio del papel.
  Future<void> _guardarDatosOt() async {
    await context.read<SyncService>().encolarDatosOt(
          widget.ordenId,
          tipoServicio: _tipoServicio,
          observacionFinal: _observacionFinalCtrl.text.trim().isEmpty ? null : _observacionFinalCtrl.text.trim(),
          folioPapel: _folioPapelCtrl.text.trim().isEmpty ? null : _folioPapelCtrl.text.trim(),
        );
    await _cargar();
    _intentarSincronizarAhora();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Guardado localmente, se sincroniza cuando haya señal')),
      );
    }
  }

  Future<void> _alternarServicio(int servicioId) async {
    final nuevos = Set<int>.from(_serviciosMarcados);
    if (!nuevos.remove(servicioId)) nuevos.add(servicioId);
    setState(() => _serviciosMarcados = nuevos);
    await context.read<SyncService>().encolarChecklist(widget.ordenId, nuevos.toList());
    _intentarSincronizarAhora();
  }

  /// Cierra el tramo abierto, o abre uno nuevo. En el papel son los bloques
  /// INICIO / TÉRMINO DEL TRABAJO, y hay más de uno porque el trabajo se puede retomar.
  Future<void> _alternarTramo() async {
    final abierto = _tramosLocales.where((t) => t['termino'] == null).toList();
    final sync = context.read<SyncService>();
    final db = await LocalDatabase.instance.database;
    if (abierto.isEmpty) {
      await sync.encolarTramo(widget.ordenId, inicio: DateTime.now());
    } else {
      final tramo = abierto.last;
      final inicio = DateTime.parse(tramo['inicio'] as String);
      await db.delete('tramos_locales', where: 'id = ?', whereArgs: [tramo['id']]);
      await sync.encolarTramo(widget.ordenId, inicio: inicio, termino: DateTime.now());
    }
    await _cargar();
    _intentarSincronizarAhora();
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

  Future<void> _tomarFoto(String tipo) async {
    final syncService = context.read<SyncService>();
    final picker = ImagePicker();
    final foto = await picker.pickImage(source: ImageSource.camera, imageQuality: 80);
    if (foto == null) return;

    final dir = await getApplicationDocumentsDirectory();
    final nombreArchivo = 'ot${widget.ordenId}_${DateTime.now().millisecondsSinceEpoch}.jpg';
    final rutaLocal = '${dir.path}/$nombreArchivo';
    await File(foto.path).copy(rutaLocal);

    await syncService.encolarEvidencia(widget.ordenId, rutaLocal, tipo: tipo);
    await _cargar();
    _intentarSincronizarAhora();
  }

  List<Map<String, dynamic>> _fotosDeTipo(String tipo) =>
      _fotosLocales.where((f) => (f['tipo'] ?? 'antes') == tipo).toList();

  Future<void> _agregarInsumo() async {
    final cantidad = double.tryParse(_cantidadInsumoCtrl.text.replaceAll(',', '.'));
    final descripcion = _descripcionInsumoCtrl.text.trim();
    final insumoId = _insumoSeleccionadoId;
    if (cantidad == null || cantidad <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Ingresa una cantidad válida')),
      );
      return;
    }
    // como en el papel: o se elige del catálogo, o se escribe el repuesto a mano
    if (insumoId == null && descripcion.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Elige un repuesto del catálogo o escribe su descripción')),
      );
      return;
    }
    final nombre = insumoId != null
        ? _catalogoInsumos.firstWhere((i) => i['id'] == insumoId)['nombre'] as String
        : descripcion;
    await context.read<SyncService>().encolarInsumo(
          widget.ordenId,
          insumoId: insumoId,
          insumoNombre: nombre,
          cantidad: cantidad,
          descripcion: descripcion.isEmpty ? null : descripcion,
          precioUnitario: double.tryParse(_precioInsumoCtrl.text.replaceAll('.', '').replaceAll(',', '.')),
          facturable: _facturableLinea,
        );
    _cantidadInsumoCtrl.clear();
    _descripcionInsumoCtrl.clear();
    _precioInsumoCtrl.clear();
    setState(() => _facturableLinea = 'pendiente');
    await _cargar();
    _intentarSincronizarAhora();
  }

  Future<void> _finalizar() async {
    final orden = _orden;
    if (orden == null) return;
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CerrarOrdenScreen(
          orden: orden,
          fotosAntes: _fotosDeTipo('antes').length,
          fotosDespues: _fotosDeTipo('despues').length,
          insumos: _insumosLocales.length,
        ),
      ),
    );
    // CerrarOrdenScreen hace popUntil(first) al confirmar; si el mecanico volvio
    // con "atras" sin cerrar, refrescamos por si acaso
    if (mounted) await _cargar();
    _intentarSincronizarAhora();
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
            Row(
              children: [
                Expanded(
                  child: Text(
                    orden.maquinariaCodigo ?? 'Sin código',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                  ),
                ),
                // el informe dice que el mecanico consulta el historial tecnico del equipo
                TextButton.icon(
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => MaquinariaHistorialScreen(
                        maquinariaId: orden.maquinariaId,
                        codigo: orden.maquinariaCodigo ?? '',
                      ),
                    ),
                  ),
                  icon: const Icon(Icons.history, size: 16),
                  label: const Text('Historial', style: TextStyle(fontSize: 12)),
                ),
              ],
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

  Widget _seccionFotos({
    required String tipo,
    required String titulo,
    required bool puedeAgregar,
    String? ayuda,
  }) {
    final fotos = _fotosDeTipo(tipo);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.photo_camera_outlined, titulo),
            if (ayuda != null) ...[
              const SizedBox(height: 4),
              Text(ayuda, style: const TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
            ],
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final foto in fotos)
                  FotoThumbnail(
                    rutaLocal: foto['ruta_local'] as String,
                    sincronizada: foto['sincronizado'] != 0,
                    creadoEn: foto['creado_en'] as String?,
                  ),
                if (puedeAgregar)
                  InkWell(
                    onTap: () => _tomarFoto(tipo),
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
            // El talonario separa OBSERVACIONES INICIALES de OBSERVACIONES FINALES:
            // qué se encontró al llegar y qué se hizo (entrevista el jefe de taller, punto 5).
            _tituloSeccion(Icons.build_outlined, 'Observaciones'),
            const SizedBox(height: 12),
            const Text('INICIALES · qué se encontró al llegar',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 4),
            TextField(
              controller: _diagnosticoCtrl,
              maxLines: 3,
              readOnly: soloLectura,
              decoration: const InputDecoration(hintText: 'Ej: cliente solicita llave de contacto por pérdida'),
            ),
            const SizedBox(height: 12),
            const Text('FINALES · qué se hizo',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 4),
            TextField(
              controller: _observacionFinalCtrl,
              maxLines: 3,
              readOnly: soloLectura,
              decoration: const InputDecoration(hintText: 'Ej: se reemplaza llave de contacto'),
              onEditingComplete: soloLectura ? null : _guardarDatosOt,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _folioPapelCtrl,
              readOnly: soloLectura,
              decoration: const InputDecoration(
                isDense: true,
                labelText: 'N° de OT en papel (opcional)',
                hintText: '00904',
              ),
              onEditingComplete: soloLectura ? null : _guardarDatosOt,
            ),
            if (!soloLectura) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () async {
                        await _guardarDiagnostico();
                        await _guardarDatosOt();
                      },
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
            _tituloSeccion(Icons.inventory_2_outlined, 'Repuestos utilizados'),
            const SizedBox(height: 4),
            if (!soloLectura) ...[
              const Text(
                'Elige del catálogo o escribe el repuesto a mano, e indica si se le cobra al cliente',
                style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
              ),
              const SizedBox(height: 8),
              if (_catalogoInsumos.isNotEmpty)
                DropdownButtonFormField<int?>(
                  initialValue: _insumoSeleccionadoId,
                  isExpanded: true,
                  decoration: const InputDecoration(isDense: true, labelText: 'Repuesto del catálogo'),
                  items: [
                    const DropdownMenuItem<int?>(value: null, child: Text('— escribir a mano —')),
                    for (final insumo in _catalogoInsumos)
                      DropdownMenuItem<int?>(
                        value: insumo['id'] as int,
                        child: Text(
                          '${insumo['nombre']} (${insumo['unidad_medida']})',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: (v) => setState(() => _insumoSeleccionadoId = v),
                ),
              TextField(
                controller: _descripcionInsumoCtrl,
                decoration: const InputDecoration(isDense: true, labelText: 'Descripción / observación'),
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  SizedBox(
                    width: 80,
                    child: TextField(
                      controller: _cantidadInsumoCtrl,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(isDense: true, labelText: 'Cant.'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      controller: _precioInsumoCtrl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(isDense: true, labelText: 'Precio unitario'),
                    ),
                  ),
                  const SizedBox(width: 4),
                  IconButton(
                    onPressed: _agregarInsumo,
                    icon: const Icon(Icons.add_circle, color: GomaqColors.primario, size: 30),
                  ),
                ],
              ),
              // las tres casillas del papel: SI / NO / ?
              Row(
                children: [
                  const Text('Facturable:', style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
                  const SizedBox(width: 8),
                  for (final (valor, etiqueta) in [('si', 'Sí'), ('no', 'No'), ('pendiente', 'Por decidir')])
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(etiqueta, style: const TextStyle(fontSize: 12)),
                        selected: _facturableLinea == valor,
                        onSelected: (_) => setState(() => _facturableLinea = valor),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 8),
            ],
            if (!soloLectura)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: _intervenirOtroEquipo,
                  icon: const Icon(Icons.add_box_outlined, size: 18),
                  label: const Text('El repuesto va a otro equipo', style: TextStyle(fontSize: 12)),
                ),
              ),
            if (_insumosLocales.isEmpty)
              const Text('Sin repuestos registrados', style: TextStyle(color: GomaqColors.textoSecundario)),
            for (final insumo in _insumosLocales)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.build_circle_outlined),
                title: Text('${insumo['insumo_nombre']} · ${insumo['cantidad']}'),
                subtitle: Text(
                  _resumenLinea(insumo),
                  style: const TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
                ),
                trailing: insumo['sincronizado'] == 0
                    ? const Icon(Icons.cloud_upload, size: 16, color: GomaqColors.estadoAdvertencia)
                    : const Icon(Icons.cloud_done, size: 16, color: GomaqColors.estadoPositivo),
              ),
          ],
        ),
      ),
    );
  }

  static const _etiquetaFacturable = {'si': 'Se cobra', 'no': 'No se cobra', 'pendiente': 'Por decidir'};

  String _resumenLinea(Map<String, dynamic> linea) {
    final partes = <String>[_etiquetaFacturable[linea['facturable']] ?? 'Por decidir'];
    if (linea['precio_unitario'] != null) partes.add('\$${linea['precio_unitario']}');
    if (linea['descripcion'] != null && (linea['descripcion'] as String).isNotEmpty) {
      partes.add(linea['descripcion'] as String);
    }
    return partes.join(' · ');
  }

  /// Abre una OT para otro equipo intervenido durante esta misma visita.
  ///
  /// el jefe de taller lo describió como el caso donde el repuesto "queda en el aire": si el técnico
  /// atiende una segunda máquina, su gasto tiene que quedar contra ESA máquina y no contra
  /// la de la orden en curso, o el costo por equipo queda mal atribuido.
  Future<void> _intervenirOtroEquipo() async {
    final db = await LocalDatabase.instance.database;
    final flota = await db.query('maquinarias_local', orderBy: 'codigo ASC');
    if (!mounted) return;
    if (flota.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Sin señal para cargar la lista de equipos todavía')),
      );
      return;
    }

    final motivoCtrl = TextEditingController();
    int? elegido;
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Intervine otro equipo'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Se abre una orden aparte para ese equipo, para que sus repuestos queden a su nombre.',
                style: TextStyle(fontSize: 12),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<int>(
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Equipo'),
                items: [
                  for (final m in flota.where((m) => m['id'] != _orden?.maquinariaId))
                    DropdownMenuItem(
                      value: m['id'] as int,
                      child: Text('${m['codigo']} · ${m['tipo'] ?? ''}', overflow: TextOverflow.ellipsis),
                    ),
                ],
                onChanged: (v) => setDialogState(() => elegido = v),
              ),
              TextField(
                controller: motivoCtrl,
                decoration: const InputDecoration(labelText: 'Qué se encontró'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Crear orden')),
          ],
        ),
      ),
    );
    final motivo = motivoCtrl.text.trim();
    motivoCtrl.dispose();
    if (confirmado != true || elegido == null || !mounted) return;

    final equipo = flota.firstWhere((m) => m['id'] == elegido);
    await context.read<SyncService>().encolarOtEnTerreno(
          maquinariaId: elegido!,
          maquinariaCodigo: equipo['codigo'] as String,
          motivo: motivo.isEmpty ? null : motivo,
        );
    _intentarSincronizarAhora();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Orden creada. Aparece en tu lista de OT.')),
      );
    }
  }

  /// TIPO DE SERVICIO del talonario. Lo marca el mecánico, que es quien sabe de qué se trató.
  Widget _seccionTipoServicio({required bool soloLectura}) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.assignment_outlined, 'Tipo de servicio'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final (valor, etiqueta) in _tiposServicio)
                  ChoiceChip(
                    label: Text(etiqueta, style: const TextStyle(fontSize: 12)),
                    selected: _tipoServicio == valor,
                    onSelected: soloLectura
                        ? null
                        : (_) {
                            setState(() => _tipoServicio = valor);
                            _guardarDatosOt();
                          },
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Checklist del talonario: marca DÓNDE SE INTERVINO, no una pauta de revisión.
  Widget _seccionChecklist({required bool soloLectura}) {
    if (_catalogoChecklist.isEmpty) {
      return const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text(
            'Sin señal para cargar el checklist de servicios todavía',
            style: TextStyle(color: GomaqColors.textoSecundario),
          ),
        ),
      );
    }
    final grupos = <String, List<Map<String, dynamic>>>{};
    for (final item in _catalogoChecklist) {
      grupos.putIfAbsent(item['grupo'] as String, () => []).add(item);
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.checklist_outlined, 'Sistemas intervenidos'),
            const Text(
              'Marca dónde se intervino en esta visita',
              style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
            ),
            for (final entrada in grupos.entries) ...[
              const SizedBox(height: 8),
              Text(
                _titulosGrupo[entrada.key] ?? entrada.key,
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario),
              ),
              for (final item in entrada.value)
                CheckboxListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  activeColor: GomaqColors.primario,
                  title: Text(item['nombre'] as String, style: const TextStyle(fontSize: 14)),
                  value: _serviciosMarcados.contains(item['id']),
                  onChanged: soloLectura ? null : (_) => _alternarServicio(item['id'] as int),
                ),
            ],
          ],
        ),
      ),
    );
  }

  /// INICIO / TÉRMINO DEL TRABAJO. El papel trae dos bloques porque el trabajo se puede
  /// retomar en otra visita; aquí se pueden registrar los que hagan falta.
  Widget _seccionTramos({required bool soloLectura}) {
    final abierto = _tramosLocales.where((t) => t['termino'] == null).toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.schedule_outlined, 'Tiempos de trabajo'),
            const SizedBox(height: 8),
            if (_tramosLocales.isEmpty)
              const Text('Sin tramos registrados', style: TextStyle(color: GomaqColors.textoSecundario)),
            for (final tramo in _tramosLocales)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  tramo['termino'] == null ? Icons.play_circle_outline : Icons.check_circle_outline,
                  color: tramo['termino'] == null ? GomaqColors.estadoAdvertencia : GomaqColors.estadoPositivo,
                ),
                title: Text(_rangoTramo(tramo), style: const TextStyle(fontSize: 14)),
                trailing: tramo['sincronizado'] == 0
                    ? const Icon(Icons.cloud_upload, size: 16, color: GomaqColors.estadoAdvertencia)
                    : const Icon(Icons.cloud_done, size: 16, color: GomaqColors.estadoPositivo),
              ),
            if (!soloLectura) ...[
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _alternarTramo,
                  icon: Icon(abierto.isEmpty ? Icons.play_arrow : Icons.stop, size: 18),
                  label: Text(abierto.isEmpty ? 'INICIAR TRAMO' : 'TERMINAR TRAMO'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _rangoTramo(Map<String, dynamic> tramo) {
    String hhmm(DateTime f) => '${f.day}/${f.month} ${f.hour.toString().padLeft(2, '0')}:${f.minute.toString().padLeft(2, '0')}';
    final inicio = DateTime.parse(tramo['inicio'] as String).toLocal();
    final termino = tramo['termino'] == null ? null : DateTime.parse(tramo['termino'] as String).toLocal();
    if (termino == null) return '${hhmm(inicio)} — en curso';
    final minutos = termino.difference(inicio).inMinutes;
    return '${hhmm(inicio)} a ${hhmm(termino)}  ·  ${minutos ~/ 60}h ${minutos % 60}m';
  }

  Widget? _botonInferior(OrdenTrabajo orden) {
    final String texto;
    final IconData icono;
    VoidCallback? accion;
    String? notaFaltante;

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
        final faltan = ReglasNegocio.minFotosDespues - _fotosDeTipo('despues').length;
        if (faltan > 0) {
          accion = null;
          notaFaltante = faltan == 1
              ? 'Falta 1 foto del trabajo terminado (DESPUÉS) para poder cerrar'
              : 'Faltan $faltan fotos del trabajo terminado (DESPUÉS) para poder cerrar';
        } else {
          accion = _finalizar;
        }
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
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (notaFaltante != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  notaFaltante,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 12, color: GomaqColors.estadoAdvertencia),
                ),
              ),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: accion,
                icon: Icon(icono),
                label: Text(texto),
              ),
            ),
          ],
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
            _seccionFotos(
              tipo: 'antes',
              titulo: 'Paso 1: Fotos ANTES',
              puedeAgregar: true,
              ayuda: 'Documenta el estado inicial de la máquina antes de intervenirla',
            ),
            const SeccionBloqueada(titulo: 'Tipo de servicio', icono: Icons.assignment_outlined),
            const SeccionBloqueada(titulo: 'Observaciones', icono: Icons.build_outlined),
            const SeccionBloqueada(titulo: 'Repuestos utilizados', icono: Icons.inventory_2_outlined),
          ] else if (enProgreso) ...[
            // mismo orden que el talonario en papel
            _seccionTipoServicio(soloLectura: false),
            _seccionChecklist(soloLectura: false),
            _seccionTramos(soloLectura: false),
            _seccionDiagnostico(soloLectura: false, enTerreno: orden.estado == 'en_terreno'),
            _seccionInsumos(soloLectura: false),
            _seccionFotos(tipo: 'antes', titulo: 'Fotos ANTES', puedeAgregar: true),
            _seccionFotos(
              tipo: 'despues',
              titulo: 'Fotos DESPUÉS',
              puedeAgregar: true,
              ayuda: 'Se requiere al menos ${ReglasNegocio.minFotosDespues} foto del trabajo terminado para cerrar',
            ),
          ] else if (finalizada) ...[
            _seccionTipoServicio(soloLectura: true),
            _seccionChecklist(soloLectura: true),
            _seccionTramos(soloLectura: true),
            _seccionDiagnostico(soloLectura: true, enTerreno: false),
            _seccionInsumos(soloLectura: true),
            _seccionFotos(tipo: 'antes', titulo: 'Fotos ANTES', puedeAgregar: false),
            _seccionFotos(tipo: 'despues', titulo: 'Fotos DESPUÉS', puedeAgregar: false),
          ] else ...[
            // estado no contemplado: mostrar todo editable para no bloquear al mecanico
            _seccionTipoServicio(soloLectura: false),
            _seccionChecklist(soloLectura: false),
            _seccionTramos(soloLectura: false),
            _seccionDiagnostico(soloLectura: false, enTerreno: false),
            _seccionInsumos(soloLectura: false),
            _seccionFotos(tipo: 'antes', titulo: 'Fotos ANTES', puedeAgregar: true),
            _seccionFotos(tipo: 'despues', titulo: 'Fotos DESPUÉS', puedeAgregar: true),
          ],
        ],
      ),
    );
  }
}
