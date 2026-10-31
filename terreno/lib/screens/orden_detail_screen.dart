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
import '../utils/formato.dart';
import '../widgets/dialogo_horometro.dart';
import '../widgets/dialogo_texto.dart';
import '../widgets/seccion_bloqueada.dart';
import '../widgets/selector_equipo.dart';
import 'cerrar_orden_screen.dart';
import 'maquinaria_historial_screen.dart';

class OrdenDetailScreen extends StatefulWidget {
  final int ordenId;
  const OrdenDetailScreen({super.key, required this.ordenId});

  @override
  State<OrdenDetailScreen> createState() => _OrdenDetailScreenState();
}

class _OrdenDetailScreenState extends State<OrdenDetailScreen> {
  /// Id con el que se opera la OT (el real si una creada en terreno ya se sincronizo).
  late final SyncService _sincronizador;
  int get _id => _sincronizador.resolverIdOrden(widget.ordenId);

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
  // true cuando el mecanico escribio el precio a mano: ya no se pisa con el costo del catalogo
  bool _precioEditado = false;
  // evita abrir dos tramos si se toca INICIAR dos veces seguidas
  bool _iniciando = false;

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
    _sincronizador = context.read<SyncService>();
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
    final rows = await db.query('ordenes_locales', where: 'id = ?', whereArgs: [_id]);
    final fotos = await db.query('evidencias_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id]);
    final insumos = await db.query('insumos_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id]);
    final catalogo = await db.query('insumos_catalogo_local', orderBy: 'nombre ASC');
    final checklist = await db.query('checklist_catalogo_local', orderBy: 'orden ASC');
    final marcados = await db.query('ot_servicios_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id]);
    final tramos = await db.query('tramos_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id], orderBy: 'inicio ASC');
    if (!mounted || rows.isEmpty) return;
    setState(() {
      _orden = OrdenTrabajo.fromLocalMap(rows.first);
      _diagnosticoCtrl.text = _orden!.diagnostico ?? '';
      // la cabecera del talonario ahora vive tambien en el telefono: al reabrir la orden se ve lo ya llenado
      _tipoServicio = _orden!.tipoServicio;
      if (_observacionFinalCtrl.text.isEmpty) _observacionFinalCtrl.text = _orden!.observacionFinal ?? '';
      if (_folioPapelCtrl.text.isEmpty) _folioPapelCtrl.text = _orden!.folioPapel ?? '';
      _fotosLocales = fotos;
      _insumosLocales = insumos;
      _catalogoInsumos = catalogo;
      _catalogoChecklist = checklist;
      _serviciosMarcados = marcados.map((m) => m['servicio_id'] as int).toSet();
      _tramosLocales = tramos;
      if (_insumoSeleccionadoId == null && catalogo.isNotEmpty) {
        _insumoSeleccionadoId = catalogo.first['id'] as int;
      }
      _precargarPrecio();
    });
  }

  /// Guarda la cabecera del talonario: tipo de servicio, observación final y folio del papel.
  Future<void> _guardarDatosOt() async {
    await context.read<SyncService>().encolarDatosOt(
          _id,
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
    await context.read<SyncService>().encolarChecklist(_id, nuevos.toList());
    _intentarSincronizarAhora();
  }

  /// Cierra el tramo abierto, o abre uno nuevo. En el papel son los bloques
  /// INICIO / TÉRMINO DEL TRABAJO, y hay más de uno porque el trabajo se puede retomar.
  Future<void> _alternarTramo() async {
    final abierto = _tramosLocales.where((t) => t['termino'] == null).toList();
    final sync = context.read<SyncService>();
    final db = await LocalDatabase.instance.database;
    if (abierto.isEmpty) {
      await sync.encolarTramo(_id, inicio: DateTime.now());
    } else {
      final tramo = abierto.last;
      final inicio = DateTime.parse(tramo['inicio'] as String);
      await db.delete('tramos_locales', where: 'id = ?', whereArgs: [tramo['id']]);
      await sync.encolarTramo(_id, inicio: inicio, termino: DateTime.now());
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
          _id,
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

  /// El mecanico acepta el trabajo: la oficina ve que lo recibio. No hace falta senal.
  Future<void> _aceptarTrabajo() async {
    await context.read<SyncService>().encolarDiagnostico(_id, estado: 'aceptada');
    await _cargar();
    _intentarSincronizarAhora();
  }

  /// Sale hacia el destino: desde aqui corre el tiempo de viaje, separado del de trabajo, y el
  /// cliente ve que el tecnico va en camino.
  Future<void> _salirAlDestino() async {
    await context.read<SyncService>().encolarDiagnostico(_id, estado: 'en_camino');
    await _cargar();
    _intentarSincronizarAhora();
  }

  /// INICIAR TRABAJO se pulsa ya en el sitio: pasa la orden a en terreno y arranca el reloj de
  /// trabajo (el INICIO del talonario), sin pedirle al mecanico que abra el tramo a mano.
  Future<void> _iniciarTrabajo() async {
    if (_iniciando) return;
    _iniciando = true;
    try {
      final sync = context.read<SyncService>();
      await sync.encolarDiagnostico(_id, diagnostico: _diagnosticoCtrl.text.trim(), estado: 'en_terreno');
      // despues del cambio de estado: la cola corre en orden de creacion
      if (!_tramosLocales.any((t) => t['termino'] == null)) {
        await sync.encolarTramo(_id, inicio: DateTime.now());
      }
      await _cargar();
      _intentarSincronizarAhora();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Trabajo iniciado. El tiempo de trabajo ya está corriendo.')),
        );
      }
    } finally {
      _iniciando = false;
    }
  }

  /// Lectura de horometro en cualquier momento de la visita, no solo al cerrar. Va a la cola como
  /// una tarea mas (con su uuid), asi que funciona sin senal y un reintento no la duplica.
  Future<void> _registrarHorometro() async {
    final orden = _orden;
    if (orden == null) return;
    final valor = await pedirLecturaHorometro(
      context,
      codigo: orden.maquinariaCodigo ?? 'el equipo',
      maquinariaId: orden.maquinariaId,
    );
    if (valor == null || !mounted) return;
    await context.read<SyncService>().encolarHorometro(
          _id,
          maquinariaId: orden.maquinariaId,
          valor: valor,
        );
    _intentarSincronizarAhora();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Lectura de ${formatoHoras(valor)} h guardada')),
      );
    }
  }

  Future<void> _tomarFoto(String tipo) async {
    final syncService = context.read<SyncService>();
    final picker = ImagePicker();
    final foto = await picker.pickImage(source: ImageSource.camera, imageQuality: 80);
    if (foto == null) return;

    final dir = await getApplicationDocumentsDirectory();
    final nombreArchivo = 'ot${_id}_${DateTime.now().millisecondsSinceEpoch}.jpg';
    final rutaLocal = '${dir.path}/$nombreArchivo';
    await File(foto.path).copy(rutaLocal);

    await syncService.encolarEvidencia(_id, rutaLocal, tipo: tipo);
    await _cargar();
    _intentarSincronizarAhora();
  }

  List<Map<String, dynamic>> _fotosDeTipo(String tipo) =>
      _fotosLocales.where((f) => (f['tipo'] ?? 'antes') == tipo).toList();

  /// Costo del repuesto elegido, en pesos enteros, o null si no tiene (o se escribe a mano).
  double? _costoDelElegido() {
    final id = _insumoSeleccionadoId;
    if (id == null) return null;
    final fila = _catalogoInsumos.where((i) => i['id'] == id);
    if (fila.isEmpty) return null;
    final costo = (fila.first['costo_unitario'] as num?)?.toDouble();
    return (costo == null || costo <= 0) ? null : costo.roundToDouble();
  }

  /// El precio de una linea parte del que ya tiene el repuesto (por ahora su costo); el mecanico
  /// puede cambiarlo. No pisa un precio que escribio a mano.
  void _precargarPrecio() {
    if (_precioEditado) return;
    final costo = _costoDelElegido();
    _precioInsumoCtrl.text = costo == null ? '' : costo.round().toString();
  }

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
          _id,
          insumoId: insumoId,
          insumoNombre: nombre,
          cantidad: cantidad,
          descripcion: descripcion.isEmpty ? null : descripcion,
          // si no es facturable el precio no se muestra, pero se guarda el costo del catalogo: el
          // gasto por equipo cuenta todas las lineas, se cobren o no
          precioUnitario: _facturableLinea == 'no'
              ? _costoDelElegido()
              : double.tryParse(_precioInsumoCtrl.text.replaceAll('.', '').replaceAll(',', '.')),
          facturable: _facturableLinea,
        );
    _cantidadInsumoCtrl.clear();
    _descripcionInsumoCtrl.clear();
    _precioEditado = false;
    setState(() {
      _facturableLinea = 'pendiente';
      _precargarPrecio();
    });
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
          insumos: _insumosLocales.where((l) => l['anulada'] != 1).length,
        ),
      ),
    );
    // CerrarOrdenScreen hace popUntil(first) al confirmar; si el mecanico volvio
    // con "atras" sin cerrar, refrescamos por si acaso
    if (mounted) await _cargar();
    _intentarSincronizarAhora();
  }

  // ---------- Secciones de UI ----------

  /// `completa`: true = listo (verde), false = falta completarlo (amarillo), null = sin estado
  /// (seccion opcional o la orden ya esta cerrada). Ademas del color lleva texto e icono, para
  /// que no dependa solo del color.
  Widget _tituloSeccion(IconData icono, String texto, {bool? completa}) {
    return Row(
      children: [
        Icon(icono, size: 18, color: GomaqColors.primario),
        const SizedBox(width: 8),
        Expanded(child: Text(texto, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
        if (completa != null) ...[
          Icon(
            completa ? Icons.check_circle : Icons.pending_outlined,
            size: 16,
            color: completa ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia,
          ),
          const SizedBox(width: 4),
          Text(
            completa ? 'Listo' : 'Falta',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: completa ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia,
            ),
          ),
        ],
      ],
    );
  }

  /// Tarjeta de seccion que se tine segun este completa (verde) o falte (amarillo).
  Widget _tarjeta({required Widget child, bool? completa}) {
    if (completa == null) return Card(child: child);
    final color = completa ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia;
    return Card(
      color: color.withValues(alpha: 0.08),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: color.withValues(alpha: 0.6)),
      ),
      child: child,
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
                  etiquetaOt(orden.id),
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
            if (orden.estado != 'finalizada') ...[
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: _registrarHorometro,
                icon: const Icon(Icons.speed, size: 18),
                label: const Text('Agregar lectura de horómetro'),
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
    // mientras la orden esta abierta: las de ANTES son recomendadas, las de DESPUES obligatorias
    final completa = puedeAgregar
        ? (tipo == 'despues' ? fotos.length >= ReglasNegocio.minFotosDespues : fotos.isNotEmpty)
        : null;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.photo_camera_outlined, titulo, completa: completa),
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
    final completa = soloLectura ? null : (_orden?.diagnostico ?? '').trim().isNotEmpty;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // El talonario separa OBSERVACIONES INICIALES de OBSERVACIONES FINALES:
            // qué se encontró al llegar y qué se hizo (entrevista el jefe de taller, punto 5).
            _tituloSeccion(Icons.build_outlined, 'Observaciones', completa: completa),
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
    // opcional: sin repuestos la orden no se cobra, y eso es valido. Solo se marca cuando ya hay.
    final hayRepuestos = _insumosLocales.any((l) => l['anulada'] != 1);
    final bool? completa = soloLectura ? null : (hayRepuestos ? true : null);
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.inventory_2_outlined, 'Repuestos utilizados', completa: completa),
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
                  onChanged: (v) => setState(() {
                    _insumoSeleccionadoId = v;
                    _precioEditado = false;
                    _precargarPrecio();
                  }),
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
                    // sin cobro no hace falta pedir un precio
                    child: _facturableLinea == 'no'
                        ? const Text(
                            'No se cobra al cliente',
                            style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
                          )
                        : TextField(
                            controller: _precioInsumoCtrl,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(isDense: true, labelText: 'Precio unitario'),
                            onChanged: (_) => _precioEditado = true,
                          ),
                  ),
                  const SizedBox(width: 4),
                  IconButton(
                    tooltip: 'Agregar repuesto',
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
              _lineaRepuesto(insumo, soloLectura: soloLectura),
          ],
        ),
      ),
    );
  }

  /// Una linea de repuesto. Mientras la OT esta abierta el mecanico puede anularla (queda
  /// tachada, como en el talonario); anulada, se sigue viendo para que quede constancia.
  Widget _lineaRepuesto(Map<String, dynamic> insumo, {required bool soloLectura}) {
    final anulada = insumo['anulada'] == 1;
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(Icons.build_circle_outlined,
          color: anulada ? GomaqColors.textoSecundario : null),
      title: Text(
        '${insumo['insumo_nombre']} · ${_cantidadLimpia(insumo['cantidad'])}',
        style: anulada
            ? const TextStyle(decoration: TextDecoration.lineThrough, color: GomaqColors.textoSecundario)
            : null,
      ),
      subtitle: Text(
        anulada ? 'Anulada' : _resumenLinea(insumo),
        style: const TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          insumo['sincronizado'] == 0
              ? const Icon(Icons.cloud_upload, size: 16, color: GomaqColors.estadoAdvertencia)
              : const Icon(Icons.cloud_done, size: 16, color: GomaqColors.estadoPositivo),
          if (!soloLectura && !anulada)
            IconButton(
              tooltip: 'Anular línea',
              icon: const Icon(Icons.remove_circle_outline, color: GomaqColors.estadoNegativo),
              onPressed: () => _anularLinea(insumo),
            ),
        ],
      ),
    );
  }

  Future<void> _anularLinea(Map<String, dynamic> insumo) async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('¿Anular esta línea?'),
        content: Text(
          '${insumo['insumo_nombre']} · ${insumo['cantidad']}\n\n'
          'La línea queda tachada y el repuesto vuelve a tu furgón. No se puede deshacer: '
          'si te equivocaste, vuelve a agregar la línea correcta.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Anular línea')),
        ],
      ),
    );
    if (confirmado != true || !mounted) return;
    final error = await context.read<SyncService>().anularInsumo(insumo);
    if (!mounted) return;
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    await _cargar();
    _intentarSincronizarAhora();
  }

  static const _etiquetaFacturable = {'si': 'Se cobra', 'no': 'No se cobra', 'pendiente': 'Por decidir'};

  /// 2.0 -> 2 (las cantidades enteras no llevan decimal).
  static String _cantidadLimpia(dynamic v) {
    if (v is num && v == v.roundToDouble()) return v.round().toString();
    return '$v';
  }

  String _resumenLinea(Map<String, dynamic> linea) {
    final partes = <String>[_etiquetaFacturable[linea['facturable']] ?? 'Por decidir'];
    if (linea['precio_unitario'] != null) partes.add(Formato.clp(linea['precio_unitario'] as num));
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
    final equipo = await elegirEquipo(context, excluirId: _orden?.maquinariaId);
    if (equipo == null || !mounted) return;

    final motivo = await pedirTexto(
      context,
      titulo: 'Intervine ${equipo['codigo']}',
      etiqueta: 'Qué se encontró',
      ayuda: 'Se abre una orden aparte para ese equipo, para que sus repuestos queden a su nombre.',
      confirmar: 'Crear orden',
    );
    if (motivo == null || !mounted) return;

    await context.read<SyncService>().encolarOtEnTerreno(
          maquinariaId: equipo['id'] as int,
          maquinariaCodigo: equipo['codigo'] as String,
          motivo: motivo.trim().isEmpty ? null : motivo.trim(),
        );
    _intentarSincronizarAhora();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Orden creada. Aparece en tu lista de OT.')),
      );
    }
  }

  Widget _seccionTipoServicio({required bool soloLectura}) {
    final completa = soloLectura ? null : _tipoServicio != null;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.assignment_outlined, 'Tipo de servicio', completa: completa),
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
    final completa = soloLectura ? null : _serviciosMarcados.isNotEmpty;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.checklist_outlined, 'Sistemas intervenidos', completa: completa),
            const Text(
              'Marca dónde se intervino en esta visita',
              style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
            ),
            // Los 31 ítems estaban siempre desplegados: en terreno, con guantes y sol, eso
            // es un scroll enorme para marcar una o dos casillas. Ahora son cinco grupos
            // plegados, y cada uno se abre solo si ya tiene algo marcado.
            for (final entrada in grupos.entries)
              Builder(builder: (context) {
                final marcadosDelGrupo =
                    entrada.value.where((i) => _serviciosMarcados.contains(i['id'])).length;
                return Theme(
                  data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                  child: ExpansionTile(
                    initiallyExpanded: marcadosDelGrupo > 0,
                    tilePadding: EdgeInsets.zero,
                    childrenPadding: const EdgeInsets.only(left: 8),
                    title: Text(
                      _titulosGrupo[entrada.key] ?? entrada.key,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold),
                    ),
                    subtitle: Text(
                      marcadosDelGrupo == 0
                          ? '${entrada.value.length} sistemas'
                          : '$marcadosDelGrupo marcado${marcadosDelGrupo == 1 ? '' : 's'}',
                      style: TextStyle(
                        fontSize: 11,
                        color: marcadosDelGrupo > 0 ? GomaqColors.primario : GomaqColors.textoSecundario,
                      ),
                    ),
                    children: [
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
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  /// INICIO / TÉRMINO DEL TRABAJO. El papel trae dos bloques porque el trabajo se puede
  /// retomar en otra visita; aquí se pueden registrar los que hagan falta.
  Widget _seccionTramos({required bool soloLectura}) {
    final abierto = _tramosLocales.where((t) => t['termino'] == null).toList();
    final completa = soloLectura ? null : _tramosLocales.isNotEmpty;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.schedule_outlined, 'Tiempos de trabajo', completa: completa),
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

    // alternativa para quien ya esta en el lugar y no pasa por los pasos del viaje
    VoidCallback? accionSecundaria;

    switch (orden.estado) {
      case 'asignada':
      case 'pendiente':
        texto = 'ACEPTAR TRABAJO';
        icono = Icons.check_circle_outline;
        accion = _aceptarTrabajo;
        accionSecundaria = _iniciarTrabajo;
        break;
      case 'aceptada':
        texto = 'SALIR HACIA EL DESTINO';
        icono = Icons.directions_car_outlined;
        accion = _salirAlDestino;
        accionSecundaria = _iniciarTrabajo;
        break;
      case 'en_camino':
        texto = 'LLEGUÉ · INICIAR TRABAJO';
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
            if (accionSecundaria != null)
              TextButton(
                onPressed: accionSecundaria,
                child: const Text('Ya estoy en el lugar: iniciar trabajo'),
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

    // antes de iniciar el trabajo: asignada, aceptada o en camino
    final asignada = const ['pendiente', 'asignada', 'aceptada', 'en_camino'].contains(orden.estado);
    final enProgreso = orden.estado == 'en_terreno' || orden.estado == 'en_reparacion';
    final finalizada = orden.estado == 'finalizada';

    return Scaffold(
      appBar: AppBar(title: Text(etiquetaOt(orden.id))),
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
