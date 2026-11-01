import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/numeros.dart';
import '../../utils/formato.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';
import 'ordenes_screen.dart' show abrirDetalleOrden;

class FacturacionScreen extends StatefulWidget {
  /// Pestaña con la que se abre: 'valorizar' llega desde el atajo del Dashboard.
  final String? pestanaInicial;
  const FacturacionScreen({super.key, this.pestanaInicial});

  @override
  State<FacturacionScreen> createState() => _FacturacionScreenState();
}

class _FacturacionScreenState extends State<FacturacionScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<dynamic> _arriendos = [];
  List<dynamic> _pendientesValorizar = [];
  List<dynamic> _listas = [];
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this, initialIndex: widget.pestanaInicial == 'valorizar' ? 1 : 0);
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/facturacion/pendientes');
      if (!mounted) return;
      setState(() {
        _arriendos = data['arriendos'] ?? [];
        _pendientesValorizar = data['reparaciones_pendientes_valorizar'] ?? [];
        _listas = data['reparaciones_listas'] ?? [];
      });
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogo(Map<String, dynamic> item) async {
    await showDialog(context: context, builder: (_) => _FacturaPendienteDialog(item: item));
    _cargar();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        // sin título: el marco del panel ya muestra el nombre de la sección justo arriba
        toolbarHeight: 0,
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(text: 'Por facturar (${_arriendos.length + _listas.length})'),
            Tab(text: 'Pendiente de valorizar (${_pendientesValorizar.length})'),
          ],
        ),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? EstadoError(titulo: 'No se pudo cargar la facturación', mensaje: _error!, onReintentar: _cargar)
              : TabBarView(
                  controller: _tabController,
                  children: [_construirPorFacturar(), _construirPendienteValorizar()],
                ),
    );
  }

  Widget _construirPorFacturar() {
    final items = [
      for (final a in _arriendos)
        {
          'tipo': 'arriendo',
          'id': a['guia_recepcion_id'],
          'titulo': '${a['maquinaria_codigo']} · Arriendo',
          'cliente_nombre': a['cliente_nombre'],
          'subtitulo': '${a['dias']} día(s) de arriendo · Cliente: ${a['cliente_nombre'] ?? '-'}',
        },
      for (final r in _listas)
        {
          'tipo': 'reparacion',
          'id': r['id'],
          'titulo': 'OT #${r['id']} · ${r['maquinaria_codigo']} · Reparación',
          'cliente_nombre': r['cliente_nombre'],
          'monto_sugerido': r['valorizacion'],
          'subtitulo': 'Valorización aprobada: ${Formato.clp(num.tryParse('${r['valorizacion']}'))} · Cliente: ${r['cliente_nombre'] ?? '-'}',
        },
    ];

    if (items.isEmpty) {
      return const Center(child: Text('No hay nada listo para facturar por el momento'));
    }
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: items.length,
        itemBuilder: (context, i) {
          final item = items[i];
          final esArriendo = item['tipo'] == 'arriendo';
          // emitir la factura es exclusivo de Administrativo (backend igual);
          // el Gerente ve la lista de pendientes como lectura
          final puedeFacturar = context.watch<AuthService>().esAdministrativo;
          return Card(
            child: ListTile(
              leading: Icon(esArriendo ? Icons.local_shipping : Icons.build, color: GomaqColors.primario),
              title: Text(item['titulo'] as String),
              subtitle: Text(
                puedeFacturar
                    ? item['subtitulo'] as String
                    : '${item['subtitulo']} · Administrativo emite la factura',
              ),
              onTap: puedeFacturar ? () => _abrirDialogo(item) : null,
            ),
          );
        },
      ),
    );
  }

  Widget _construirPendienteValorizar() {
    if (_pendientesValorizar.isEmpty) {
      return const Center(child: Text('No hay reparaciones esperando valorización'));
    }
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _pendientesValorizar.length,
        itemBuilder: (context, i) {
          final ot = _pendientesValorizar[i];
          final esGerente = context.watch<AuthService>().esGerente;
          return Card(
            child: ListTile(
              leading: const Icon(Icons.hourglass_empty, color: Colors.grey),
              title: Text('OT #${ot['id']} · ${ot['maquinaria_codigo']}'),
              subtitle: Text(
                'Cliente: ${ot['cliente_nombre'] ?? '-'} · El mecánico ya la marcó facturable, '
                '${esGerente ? 'toca para ponerle el monto' : 'falta que el Gerente le ponga el monto'}',
              ),
              trailing: const Icon(Icons.chevron_right),
              // abre el detalle de la orden, donde el Gerente aprueba el monto
              onTap: () => abrirDetalleOrden(context, ot['id'] as int, onCambio: _cargar),
            ),
          );
        },
      ),
    );
  }
}

/// Dialogo unico para ambos tipos de pendiente (arriendo/reparacion): subir PDF, detectar
/// datos (mejor esfuerzo), confirmar/editar, crear la factura, y armar la vista previa
/// del correo antes de autorizar el envio.
class _FacturaPendienteDialog extends StatefulWidget {
  final Map<String, dynamic> item;
  const _FacturaPendienteDialog({required this.item});

  @override
  State<_FacturaPendienteDialog> createState() => _FacturaPendienteDialogState();
}

class _FacturaPendienteDialogState extends State<_FacturaPendienteDialog> {
  final _folioCtrl = TextEditingController();
  final _montoCtrl = TextEditingController();
  PlatformFile? _archivo;
  bool _detectando = false;
  bool _procesando = false;
  bool _guardandoEdicion = false;
  // avisos de los campos: antes, con el folio o el PDF sin llenar, el boton no hacia nada y no decia por que
  String? _errorArchivo;
  String? _errorFolio;
  String? _errorMonto;
  String? _errorMontoEdicion;
  Map<String, dynamic>? _facturaCreada;
  final _folioEditCtrl = TextEditingController();
  final _montoEditCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    if (widget.item['monto_sugerido'] != null) {
      _montoCtrl.text = numeroParaEditar(widget.item['monto_sugerido']);
    }
  }

  Future<void> _elegirArchivo() async {
    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado == null || resultado.files.single.bytes == null) return;
    setState(() => _archivo = resultado.files.single);

    setState(() => _detectando = true);
    try {
      final deteccion = await ApiClient.instance.postMultipart(
        '/api/facturacion/detectar',
        bytes: _archivo!.bytes,
        filename: _archivo!.name,
      );
      if (!mounted) return;
      setState(() {
        if (deteccion['monto_detectado'] != null) _montoCtrl.text = numeroParaEditar(deteccion['monto_detectado']);
        if (deteccion['folio_detectado'] != null) _folioCtrl.text = deteccion['folio_detectado'].toString();
      });
    } on ApiException catch (_) {
      // deteccion best-effort: si falla, el usuario sigue llenando a mano
    } finally {
      if (mounted) setState(() => _detectando = false);
    }
  }

  Future<void> _subirFactura() async {
    // "249.900" son doscientos cuarenta y nueve mil novecientos; leido con tryParse era 249,9
    final monto = parsearMonto(_montoCtrl.text);
    setState(() {
      _errorArchivo = _archivo == null ? 'Elige el PDF de la factura.' : null;
      _errorFolio = _folioCtrl.text.trim().isEmpty ? 'Escribe el folio de la factura.' : null;
      _errorMonto = (_montoCtrl.text.trim().isNotEmpty && monto == null) ? 'Escribe un monto válido, por ejemplo 249.900.' : null;
    });
    if (_errorArchivo != null || _errorFolio != null || _errorMonto != null) return;
    setState(() => _procesando = true);
    try {
      final esArriendo = widget.item['tipo'] == 'arriendo';
      final path = esArriendo ? '/api/facturacion/arriendo' : '/api/ordenes-trabajo/${widget.item['id']}/factura';
      final resultado = await ApiClient.instance.postMultipart(
        path,
        bytes: _archivo!.bytes!,
        filename: _archivo!.name,
        fields: {
          if (esArriendo) 'guia_recepcion_id': widget.item['id'].toString(),
          'folio': _folioCtrl.text.trim(),
          if (monto != null) 'monto': '$monto',
        },
      );
      if (mounted) {
        setState(() {
          _facturaCreada = resultado;
          _folioEditCtrl.text = resultado['folio']?.toString() ?? '';
          _montoEditCtrl.text = numeroParaEditar(resultado['monto']);
        });
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  Future<void> _guardarCambios() async {
    if (_facturaCreada == null) return;
    final monto = parsearMonto(_montoEditCtrl.text);
    final montoInvalido = _montoEditCtrl.text.trim().isNotEmpty && monto == null;
    setState(() => _errorMontoEdicion = montoInvalido ? 'Escribe un monto válido, por ejemplo 249.900.' : null);
    if (montoInvalido) return;
    setState(() => _guardandoEdicion = true);
    try {
      final actualizada = await ApiClient.instance.patch('/api/facturacion/${_facturaCreada!['id']}', {
        'folio': _folioEditCtrl.text.trim().isEmpty ? null : _folioEditCtrl.text.trim(),
        'monto': monto,
      });
      if (mounted) {
        setState(() => _facturaCreada = actualizada);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Datos actualizados')));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _guardandoEdicion = false);
    }
  }

  Future<void> _autorizarEnvio() async {
    if (_facturaCreada == null) return;
    setState(() => _procesando = true);
    try {
      await ApiClient.instance.post('/api/facturacion/${_facturaCreada!['id']}/autorizar-envio', {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Envío autorizado. Quedó encolado (se procesará cuando el correo esté configurado).')),
        );
        Navigator.pop(context);
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final subiendo = _facturaCreada == null;
    return CuadroDialogo(
      icono: Icons.receipt_long,
      titulo: widget.item['titulo'] as String,
      subtitulo: subiendo ? 'Sube la factura del SII' : 'Revisa los datos y envía la factura al cliente',
      ancho: 520,
      cuerpo: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: subiendo ? _construirFormulario() : _construirVistaPrevia(),
      ),
      acciones: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
        if (subiendo)
          FilledButton(
            onPressed: (_procesando || _detectando) ? null : _subirFactura,
            child: _procesando
                ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Subir factura'),
          )
        else
          FilledButton.icon(
            onPressed: _procesando ? null : _autorizarEnvio,
            icon: const Icon(Icons.send, size: 16),
            label: const Text('Enviar factura por correo'),
          ),
      ],
    );
  }

  List<Widget> _construirFormulario() {
    return [
      const TituloSeccion('Documento PDF de la factura'),
      OutlinedButton.icon(
        onPressed: _elegirArchivo,
        icon: const Icon(Icons.upload_file),
        label: Text(_archivo?.name ?? 'Elegir PDF'),
      ),
      if (_errorArchivo != null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(_errorArchivo!, style: const TextStyle(fontSize: 12, color: GomaqColors.estadoNegativo)),
        ),
      if (_detectando) ...[
        const SizedBox(height: 8),
        const Row(
          children: [
            SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2)),
            SizedBox(width: 8),
            Text('Buscando el monto y el folio en el PDF...', style: TextStyle(fontSize: 12, color: Colors.black54)),
          ],
        ),
      ],
      const SizedBox(height: 16),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: TextFormField(
              controller: _folioCtrl,
              decoration: decoracionCampo('Folio SII', obligatorio: true).copyWith(errorText: _errorFolio),
              onChanged: (_) {
                if (_errorFolio != null) setState(() => _errorFolio = null);
              },
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextFormField(
              controller: _montoCtrl,
              keyboardType: TextInputType.number,
              decoration: decoracionCampo('Monto', prefijo: r'$ ').copyWith(errorText: _errorMonto),
              onChanged: (_) {
                if (_errorMonto != null) setState(() => _errorMonto = null);
              },
            ),
          ),
        ],
      ),
    ];
  }

  List<Widget> _construirVistaPrevia() {
    final f = _facturaCreada!;
    final cliente = widget.item['cliente_nombre'] ?? '-';
    return [
      const LineaInfo(icono: Icons.info_outline, texto: 'Si algo no se detectó bien, corrígelo y guarda antes de enviar el correo.'),
      const SizedBox(height: 14),
      const TituloSeccion('Datos de la factura'),
      Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: GomaqColors.primario.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(10)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Cliente: $cliente', style: const TextStyle(fontWeight: FontWeight.w600)),
            Text(widget.item['titulo'] as String, style: const TextStyle(fontSize: 13, color: Colors.black54)),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: TextFormField(controller: _folioEditCtrl, decoration: decoracionCampo('Folio'))),
                const SizedBox(width: 12),
                Expanded(
                  child: TextFormField(
                    controller: _montoEditCtrl,
                    keyboardType: TextInputType.number,
                    decoration: decoracionCampo('Monto', prefijo: r'$ ').copyWith(errorText: _errorMontoEdicion),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerRight,
              child: OutlinedButton(
                onPressed: _guardandoEdicion ? null : _guardarCambios,
                child: _guardandoEdicion
                    ? const SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Guardar cambios'),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      const TituloSeccion('Vista previa del correo'),
      Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(border: Border.all(color: Colors.grey.shade300), borderRadius: BorderRadius.circular(10)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Factura folio ${f['folio']} — GOMAQ Maquinarias', style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text('Adjuntamos la factura correspondiente a ${widget.item['titulo']}. Ante cualquier consulta, puede responder directamente este correo.'),
          ],
        ),
      ),
    ];
  }
}
