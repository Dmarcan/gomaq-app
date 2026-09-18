import 'dart:async';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/estado_chip.dart';
import '../widgets/estado_vacio.dart';

class OrdenesScreen extends StatefulWidget {
  /// Abre el formulario de nueva OT al entrar (el botón del Dashboard llega con ?nueva=1).
  final bool abrirNueva;
  const OrdenesScreen({super.key, this.abrirNueva = false});

  @override
  State<OrdenesScreen> createState() => _OrdenesScreenState();
}

class _OrdenesScreenState extends State<OrdenesScreen> {
  List<dynamic> _ordenes = [];
  bool _cargando = true;
  String? _error;

  // Búsqueda y filtro: la API ya los soportaba, pero la pantalla no los ofrecía
  String _busqueda = '';
  String? _estadoFiltro;
  Timer? _esperaBusqueda;

  static const _estados = ['pendiente', 'asignada', 'en_terreno', 'en_reparacion', 'finalizada'];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _cargar();
      if (widget.abrirNueva) _abrirDialogoCrear();
    });
  }

  @override
  void dispose() {
    _esperaBusqueda?.cancel();
    super.dispose();
  }

  void _buscar(String texto) {
    _esperaBusqueda?.cancel();
    _esperaBusqueda = Timer(const Duration(milliseconds: 350), () {
      _busqueda = texto.trim();
      _cargar();
    });
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final params = <String, String>{
        if (_busqueda.isNotEmpty) 'q': _busqueda,
        'estado': ?_estadoFiltro,
      };
      final query = params.isEmpty ? '' : '?${Uri(queryParameters: params).query}';
      final data = (await ApiClient.instance.get('/api/ordenes-trabajo$query'))['items'];
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
      maquinarias = (await ApiClient.instance.get('/api/maquinarias'))['items'];
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
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    onChanged: _buscar,
                    decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search),
                      hintText: 'Buscar por equipo, cliente o motivo...',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                DropdownButton<String?>(
                  value: _estadoFiltro,
                  hint: const Text('Todos los estados'),
                  items: [
                    const DropdownMenuItem<String?>(value: null, child: Text('Todos los estados')),
                    for (final e in _estados)
                      DropdownMenuItem<String?>(value: e, child: Text(GomaqColors.etiquetaEstado(e))),
                  ],
                  onChanged: (v) {
                    setState(() => _estadoFiltro = v);
                    _cargar();
                  },
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text('Error: $_error'))
                : _ordenes.isEmpty
                    ? EstadoVacio(
                        icono: Icons.assignment_outlined,
                        titulo: _busqueda.isEmpty && _estadoFiltro == null
                            ? 'Aún no hay órdenes de trabajo'
                            : 'Ninguna orden coincide con la búsqueda',
                        mensaje: _busqueda.isEmpty && _estadoFiltro == null
                            ? 'Crea la primera con «Nueva OT».'
                            : 'Prueba con otro texto o quita el filtro de estado.',
                      )
                    : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _ordenes.length,
                    itemBuilder: (context, i) {
                      final o = _ordenes[i];
                      return Card(
                        child: ListTile(
                          title: Text('OT #${o['id']} - ${o['maquinaria_codigo'] ?? ''}'),
                          subtitle: Text('${o['motivo'] ?? ''} | Cliente: ${o['cliente_nombre'] ?? '-'}'),
                          trailing: EstadoChip(estado: o['estado']),
                          onTap: () => _abrirDetalle(o),
                        ),
                      );
                    },
                  ),
            ),
          ),
        ],
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
  List<dynamic> _lineas = [];
  int? _mecanicoSeleccionado;
  final _valorizacionCtrl = TextEditingController();
  bool _cargandoAccion = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _cargarMecanicos();
      _cargarLineas();
    });
  }

  Future<void> _cargarMecanicos() async {
    try {
      final data = await ApiClient.instance.get('/api/usuarios?rol=mecanico');
      if (mounted) setState(() => _mecanicos = data);
    } catch (_) {}
  }

  Future<void> _cargarLineas() async {
    try {
      final data = await ApiClient.instance.get('/api/insumos/orden/${widget.orden['id']}');
      if (mounted) setState(() => _lineas = data);
    } catch (_) {}
  }

  /// Resuelve el "?" del papel. Al cambiar una línea el backend recalcula el facturable de
  /// la OT, así que se refresca el listado para que Facturación quede consistente.
  Future<void> _resolverLinea(dynamic lineaId, String facturable) async {
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch(
        '/api/insumos/orden/${widget.orden['id']}/linea/$lineaId',
        {'facturable': facturable},
      );
      await _cargarLineas();
      widget.onCambio();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  /// Anula una línea mal ingresada: queda tachada y el repuesto vuelve a su ubicación.
  /// Desde el panel se puede incluso con la OT cerrada, para corregir lo que el mecánico no alcanzó.
  Future<void> _anularLinea(dynamic linea) async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('¿Anular esta línea?'),
        content: Text(
          '${linea['insumo_nombre'] ?? linea['descripcion'] ?? 'Repuesto'} · ${linea['cantidad']}\n\n'
          'La línea queda tachada, el repuesto vuelve a su ubicación y deja de contar como gasto del equipo. '
          'No se puede deshacer.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Anular línea')),
        ],
      ),
    );
    if (confirmado != true) return;
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.post('/api/insumos/orden/${widget.orden['id']}/linea/${linea['id']}/anular', {});
      await _cargarLineas();
      widget.onCambio();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
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

  static const _etiquetasTipoServicio = {
    'preventivo': 'Preventivo',
    'reparacion': 'Reparación',
    'garantia_full_mantencion': 'Garantía / Full Mantención',
    'correctivo': 'Correctivo',
    'bateria_cargador': 'Batería / Cargador',
    'administrativo': 'Administrativo',
  };

  String _etiquetaTipoServicio(dynamic valor) =>
      valor == null ? 'Sin marcar' : (_etiquetasTipoServicio[valor] ?? valor.toString());

  /// Repuestos de la OT con su facturable por línea, como la tabla del talonario.
  /// Las líneas "por decidir" (el "?" del papel) son las que gerencia tiene que resolver.
  Widget _seccionLineas(AuthService auth) {
    if (_lineas.isEmpty) {
      return const Padding(
        padding: EdgeInsets.only(bottom: 16),
        child: Text('Sin repuestos registrados', style: TextStyle(color: Colors.black54)),
      );
    }
    final puedeResolver = auth.esGerente || auth.esAdministrativo;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Repuestos utilizados', style: TextStyle(fontWeight: FontWeight.bold)),
        for (final l in _lineas)
          if (l['anulada_at'] != null)
            // tachada, como en el talonario: queda la constancia de que se anuló
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(
                '${l['insumo_nombre'] ?? l['descripcion'] ?? 'Repuesto'} · ${l['cantidad']}',
                style: const TextStyle(decoration: TextDecoration.lineThrough, color: Colors.black54),
              ),
              subtitle: const Text('Anulada', style: TextStyle(fontSize: 12, color: Colors.black54)),
            )
          else
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('${l['insumo_nombre'] ?? l['descripcion'] ?? 'Repuesto'} · ${l['cantidad']}'),
              subtitle: Text(
                l['precio_unitario'] == null ? 'Sin precio' : '\$${l['precio_unitario']}',
                style: const TextStyle(fontSize: 12),
              ),
              trailing: puedeResolver
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        DropdownButton<String>(
                          value: l['facturable'] as String? ?? 'pendiente',
                          underline: const SizedBox.shrink(),
                          items: const [
                            DropdownMenuItem(value: 'si', child: Text('Se cobra')),
                            DropdownMenuItem(value: 'no', child: Text('No se cobra')),
                            DropdownMenuItem(value: 'pendiente', child: Text('Por decidir')),
                          ],
                          onChanged: _cargandoAccion ? null : (v) => _resolverLinea(l['id'], v!),
                        ),
                        IconButton(
                          tooltip: 'Anular línea',
                          icon: const Icon(Icons.remove_circle_outline, color: GomaqColors.estadoNegativo),
                          onPressed: _cargandoAccion ? null : () => _anularLinea(l),
                        ),
                      ],
                    )
                  : Text(l['facturable']?.toString() ?? 'pendiente'),
            ),
        const Divider(height: 32),
      ],
    );
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
              Text('Tipo de servicio: ${_etiquetaTipoServicio(o['tipo_servicio'])}'),
              Text('Motivo: ${o['motivo'] ?? '-'}'),
              // el talonario separa lo que se encontró al llegar de lo que se hizo
              Text('Observaciones iniciales: ${o['diagnostico'] ?? 'Sin registrar'}'),
              Text('Observaciones finales: ${o['observacion_final'] ?? 'Sin registrar'}'),
              if (o['folio_papel'] != null) Text('OT en papel: N° ${o['folio_papel']}'),
              Text('Facturable: ${o['facturable'] == true ? 'Sí' : 'No'}'),
              Text('Valorización: ${o['valorizacion'] ?? 'Sin aprobar'}'),
              const Divider(height: 32),

              _seccionLineas(auth),

              if (auth.esAdministrativo && o['mecanico_id'] == null) ...[
                const Text('Asignar mecánico', style: TextStyle(fontWeight: FontWeight.bold)),
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
                const Text('Aprobar valorización', style: TextStyle(fontWeight: FontWeight.bold)),
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
                const Text('Gestión documental - factura', style: TextStyle(fontWeight: FontWeight.bold)),
                TextField(controller: _folioCtrl, decoration: const InputDecoration(labelText: 'Número de folio SII')),
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
