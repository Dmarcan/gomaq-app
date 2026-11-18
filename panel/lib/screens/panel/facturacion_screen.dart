import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/cobranza.dart';
import '../../utils/numeros.dart';
import '../../utils/formato.dart';
import '../../widgets/campo_fecha_opcional.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/fotos_orden.dart';
import '../../widgets/zona_arrastre_pdf.dart';
import 'arriendos_en_curso_tab.dart';
import 'ordenes_screen.dart' show abrirDetalleOrden;

class FacturacionScreen extends StatefulWidget {
  /// Pestaña con la que se abre: 'valorizar' llega desde el atajo del Dashboard y 'en_curso' abre
  /// los arriendos en curso. Las facturas ya emitidas viven aparte, en `/facturas`.
  final String? pestanaInicial;

  /// 'aviso' (con pestana=en_curso) deja solo los arriendos con períodos sin facturar.
  final String? filtroInicial;
  const FacturacionScreen({super.key, this.pestanaInicial, this.filtroInicial});

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

  static const _idsPestana = ['por_facturar', 'valorizar', 'en_curso'];

  static int _indiceDe(String? pestana) => switch (pestana) { 'valorizar' => 1, 'en_curso' => 2, _ => 0 };

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this, initialIndex: _indiceDe(widget.pestanaInicial));
    _tabController.addListener(_pestanaCambio);
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  /// Al asentarse una pestaña nueva la URL la refleja (?pestana=) sin reconstruir la pantalla:
  /// la llave del router no depende de la pestaña, así el estado y las listas se conservan.
  void _pestanaCambio() {
    if (_tabController.indexIsChanging) return;
    if (_tabController.index == _indiceDe(widget.pestanaInicial)) return;
    final filtro = widget.filtroInicial;
    final query = {'pestana': _idsPestana[_tabController.index], 'filtro': ?filtro};
    context.go(Uri(path: '/facturacion', queryParameters: query).toString());
  }

  @override
  void didUpdateWidget(FacturacionScreen anterior) {
    super.didUpdateWidget(anterior);
    // un enlace (atajo del Dashboard, "Ver todos") cambia la pestaña desde la URL
    final destino = _indiceDe(widget.pestanaInicial);
    if (widget.pestanaInicial != anterior.pestanaInicial && destino != _tabController.index) {
      _tabController.animateTo(destino);
    }
  }

  @override
  void dispose() {
    _tabController.removeListener(_pestanaCambio);
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
    await showDialog(context: context, builder: (_) => FacturaPendienteDialog(item: item));
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
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: [
            Tab(text: 'Por facturar (${_arriendos.length + _listas.length})'),
            Tab(text: 'Pendiente de valorizar (${_pendientesValorizar.length})'),
            const Tab(text: 'Arriendos en curso'),
          ],
        ),
      ),
      // las dos primeras pestañas dependen de /pendientes; la de arriendos en curso carga lo suyo
      body: TabBarView(
        controller: _tabController,
        children: [
          _conEstadoDePendientes(_construirPorFacturar),
          _conEstadoDePendientes(_construirPendienteValorizar),
          ArriendosEnCursoTab(filtroInicial: widget.filtroInicial),
        ],
      ),
    );
  }

  Widget _conEstadoDePendientes(Widget Function() construir) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return EstadoError(titulo: 'No se pudo cargar la facturación', mensaje: _error!, onReintentar: _cargar);
    return construir();
  }

  Widget _construirPorFacturar() {
    final items = [
      for (final a in _arriendos)
        {
          'tipo': 'arriendo',
          'id': a['guia_recepcion_id'] ?? a['guia_despacho_id'],
          'guia_despacho_id': a['guia_despacho_id'],
          'titulo': '${a['maquinaria_codigo']} · Arriendo',
          'cliente_nombre': a['cliente_nombre'],
          'facturado_de_mas': a['facturado_de_mas'] == true,
          'subtitulo': a['facturado_de_mas'] == true
              ? 'Facturado de más hasta ${Formato.fecha(a['facturado_hasta'])}: la recepción es anterior. '
                  'Emite una nota de crédito en el SII · Cliente: ${a['cliente_nombre'] ?? '-'}'
              : '${a['dias']} día(s) por facturar'
              '${a['desde'] != null ? ' desde ${Formato.fecha(a['desde'])}' : ''}'
              ' · Cliente: ${a['cliente_nombre'] ?? '-'}'
              '${a['falta_recepcion'] == true ? ' · Sin recepción registrada' : ''}',
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
      return const Center(child: Text('Aún no hay trabajos ni arriendos listos para facturar.'));
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
              leading: Icon(
                item['facturado_de_mas'] == true ? Icons.warning_amber : (esArriendo ? Icons.local_shipping : Icons.build),
                color: item['facturado_de_mas'] == true ? GomaqColors.estadoAdvertencia : GomaqColors.primario,
              ),
              title: Text(item['titulo'] as String),
              subtitle: Text(
                puedeFacturar
                    ? item['subtitulo'] as String
                    : '${item['subtitulo']} · Administrativo emite la factura',
              ),
              // un arriendo facturado de más no admite otra factura: se corrige con nota de crédito en el SII
              onTap: (puedeFacturar && item['facturado_de_mas'] != true) ? () => _abrirDialogo(item) : null,
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
class FacturaPendienteDialog extends StatefulWidget {
  final Map<String, dynamic> item;

  /// Costuras para las pruebas: por defecto eligen el PDF con el selector del sistema y hablan con el servidor.
  final Future<PlatformFile?> Function()? elegirArchivo;
  final Future<dynamic> Function(PlatformFile archivo)? detectar;
  final Future<dynamic> Function(String ruta, PlatformFile archivo, Map<String, String> campos)? subir;
  final Future<dynamic> Function(int id, Map<String, dynamic> cuerpo)? corregir;

  const FacturaPendienteDialog({super.key, required this.item, this.elegirArchivo, this.detectar, this.subir, this.corregir});

  @override
  State<FacturaPendienteDialog> createState() => _FacturaPendienteDialogState();
}

class _FacturaPendienteDialogState extends State<FacturaPendienteDialog> {
  final _folioCtrl = TextEditingController();
  final _montoCtrl = TextEditingController();
  // parte de la factura que es traslado (solo arriendos): no cuenta como ingreso del equipo
  final _trasladoCtrl = TextEditingController();
  final _trasladoEditCtrl = TextEditingController();
  // monto neto, partes del traslado (entrega y retiro) y fechas de la factura: se precargan desde el PDF
  // y quien sube la factura los confirma o corrige (solo arriendos)
  final _netoCtrl = TextEditingController();
  final _entregaCtrl = TextEditingController();
  final _retiroCtrl = TextEditingController();
  final _netoEditCtrl = TextEditingController();
  final _entregaEditCtrl = TextEditingController();
  final _retiroEditCtrl = TextEditingController();
  String? _emision;
  String? _vencimiento;
  String? _emisionEdit;
  String? _vencimientoEdit;
  String? _errorNeto;
  String? _errorNetoEdicion;
  // lo que dijo la lectura del PDF: avisos y, si el vencimiento no coincide con el plazo del cliente, las dos opciones
  List<Map<String, dynamic>> _avisos = [];
  List<({String dia, String texto})>? _opcionesVencimiento;
  String? _errorTraslado;
  String? _errorTrasladoEdicion;
  PlatformFile? _archivo;
  bool _detectando = false;
  bool _procesando = false;
  bool _guardandoEdicion = false;
  // avisos de los campos: con el folio o el PDF sin llenar, el boton dice por que no avanza
  String? _errorArchivo;
  String? _errorFolio;
  String? _errorMonto;
  String? _errorMontoEdicion;
  Map<String, dynamic>? _facturaCreada;
  final _folioEditCtrl = TextEditingController();
  final _montoEditCtrl = TextEditingController();
  // periodo de un arriendo: lo propone el servidor y el administrativo elige hasta cuando
  Map<String, dynamic>? _propuesta;
  String? _hastaElegido;
  String? _errorPropuesta;
  bool _cargandoPropuesta = false;
  // texto del correo: lo propone el servidor y el administrativo lo puede editar antes de autorizar
  final _asuntoCtrl = TextEditingController();
  final _cuerpoCtrl = TextEditingController();
  Map<String, dynamic>? _vista;
  bool _cargandoVista = false;
  String? _errorVista;

  bool get _facturaPorPeriodo => widget.item['tipo'] == 'arriendo' && widget.item['guia_despacho_id'] != null;

  @override
  void initState() {
    super.initState();
    if (widget.item['monto_sugerido'] != null) {
      _montoCtrl.text = numeroParaEditar(widget.item['monto_sugerido']);
    }
    if (_facturaPorPeriodo) _cargarPropuesta();
  }

  @override
  void dispose() {
    _folioCtrl.dispose();
    _montoCtrl.dispose();
    _trasladoCtrl.dispose();
    _trasladoEditCtrl.dispose();
    _netoCtrl.dispose();
    _entregaCtrl.dispose();
    _retiroCtrl.dispose();
    _netoEditCtrl.dispose();
    _entregaEditCtrl.dispose();
    _retiroEditCtrl.dispose();
    _folioEditCtrl.dispose();
    _montoEditCtrl.dispose();
    _asuntoCtrl.dispose();
    _cuerpoCtrl.dispose();
    super.dispose();
  }

  /// Pide al servidor el periodo que toca facturar; se vuelve a pedir si cambió mientras tanto.
  Future<void> _cargarPropuesta() async {
    setState(() {
      _cargandoPropuesta = true;
      _errorPropuesta = null;
    });
    try {
      final p = await ApiClient.instance.get('/api/facturacion/arriendos/${widget.item['guia_despacho_id']}/propuesta');
      if (!mounted) return;
      final opciones = List<String>.from(p['opciones_hasta'] ?? const []);
      // si el desde cambio (otra factura de por medio), la eleccion anterior ya no vale: vuelve la sugerida
      final mismoDesde = _propuesta != null && _propuesta!['desde'] == p['desde'];
      setState(() {
        _propuesta = Map<String, dynamic>.from(p as Map);
        _hastaElegido = (mismoDesde && opciones.contains(_hastaElegido)) ? _hastaElegido : p['hasta_sugerido'] as String?;
      });
    } catch (e) {
      if (mounted) setState(() => _errorPropuesta = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargandoPropuesta = false);
    }
  }

  /// Días entre dos fechas AAAA-MM-DD, ambas incluidas.
  int _diasEntre(String desde, String hasta) =>
      DateTime.parse('${hasta}T00:00:00Z').difference(DateTime.parse('${desde}T00:00:00Z')).inDays + 1;

  bool get _esArriendo => widget.item['tipo'] == 'arriendo';

  Future<void> _elegirArchivo() async {
    final PlatformFile? archivo;
    if (widget.elegirArchivo != null) {
      archivo = await widget.elegirArchivo!();
    } else {
      final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
      archivo = resultado?.files.single;
    }
    if (archivo == null) return;
    await _recibirArchivo(archivo);
  }

  /// Camino comun del clic (selector) y del arrastre.
  Future<void> _recibirArchivo(PlatformFile archivo) async {
    if (archivo.bytes == null) return;
    setState(() => _archivo = archivo);

    setState(() => _detectando = true);
    try {
      final deteccion = widget.detectar != null
          ? await widget.detectar!(archivo)
          : await ApiClient.instance.postMultipart(
              '/api/facturacion/detectar',
              bytes: archivo.bytes,
              filename: archivo.name,
            );
      if (!mounted) return;
      setState(() => _aplicarDeteccion(Map<String, dynamic>.from(deteccion as Map)));
    } on ApiException catch (_) {
      // deteccion best-effort: si falla, el usuario sigue llenando a mano
    } finally {
      if (mounted) setState(() => _detectando = false);
    }
  }

  /// Llena el formulario con lo que leyó el servidor del PDF. Todo es una propuesta: quien sube la factura
  /// la confirma o la corrige. Neto, fechas y traslado solo se precargan en los arriendos.
  void _aplicarDeteccion(Map<String, dynamic> d) {
    if (d['monto_detectado'] != null) _montoCtrl.text = numeroParaEditar(d['monto_detectado']);
    if (d['folio_detectado'] != null) _folioCtrl.text = d['folio_detectado'].toString();
    if (!_esArriendo) return;
    if (d['monto_neto_detectado'] != null) _netoCtrl.text = numeroParaEditar(d['monto_neto_detectado']);
    if (d['fecha_emision_detectada'] is String) _emision = d['fecha_emision_detectada'] as String;
    final venc = d['vencimiento'] is Map ? Map<String, dynamic>.from(d['vencimiento'] as Map) : null;
    if (venc != null && venc['propuesta'] is String) _vencimiento = venc['propuesta'] as String;
    // con dos fechas posibles queda elegida la del PDF y se ofrece la del plazo del cliente
    _opcionesVencimiento = opcionesVencimiento(venc);
    final t = d['traslado_detectado'];
    if (t is Map) {
      _entregaCtrl.text = _trasladoParaEditar(t['entrega']);
      _retiroCtrl.text = _trasladoParaEditar(t['retiro']);
      _trasladoCtrl.text = _trasladoParaEditar(t['total']);
    }
    _avisos = [
      for (final a in (d['avisos'] as List? ?? const []))
        if (a is Map && a['mensaje'] != null) Map<String, dynamic>.from(a),
    ];
  }

  /// Si hay alguna parte del traslado, el total es su suma y no se escribe a mano.
  void _sincronizarTotal(TextEditingController entrega, TextEditingController retiro, TextEditingController total) {
    final suma = sumaTraslado(entrega.text, retiro.text);
    if (suma != null) total.text = suma == 0 ? '' : '$suma';
  }

  bool _conPartes(TextEditingController entrega, TextEditingController retiro) =>
      entrega.text.trim().isNotEmpty || retiro.text.trim().isNotEmpty;

  /// Texto de error de un monto de traslado o null. Vacío vale 0; debe ser entero y no pasar del monto ni del neto.
  String? _validarTraslado(String texto, double? monto, {double? neto}) {
    if (texto.trim().isEmpty) return null;
    final t = parsearMonto(texto);
    if (t == null || t != t.truncateToDouble() || t < 0) return 'Escribe un traslado válido, por ejemplo 140.000.';
    if (t > 0 && monto == null) return 'Para indicar un traslado, escribe primero el monto.';
    if (monto != null && t > monto) return 'El traslado no puede ser mayor que el monto.';
    if (neto != null && t > neto) return 'El traslado no puede ser mayor que el monto neto.';
    return null;
  }

  /// Error del traslado como se llena en el formulario: dos partes (el total es su suma) o un solo total.
  String? _validarTrasladoCampos(TextEditingController entrega, TextEditingController retiro, TextEditingController total,
      double? monto, double? neto) {
    if (!_conPartes(entrega, retiro)) return _validarTraslado(total.text, monto, neto: neto);
    for (final parte in [entrega.text, retiro.text]) {
      final e = _validarTraslado(parte, monto, neto: neto);
      if (e != null) return e;
    }
    final suma = sumaTraslado(entrega.text, retiro.text);
    return suma == null ? null : _validarTraslado('$suma', monto, neto: neto);
  }

  /// Error del monto neto o null. Vacío vale "sin neto"; entero y no mayor que el monto.
  String? _validarNeto(String texto, double? monto) {
    if (texto.trim().isEmpty) return null;
    final n = parsearMonto(texto);
    if (n == null || n != n.truncateToDouble() || n < 0) return 'Escribe un monto neto válido, por ejemplo 210.000.';
    if (monto != null && n > monto) return 'El monto neto no puede ser mayor que el monto.';
    return null;
  }

  /// El traslado 0 se muestra como campo vacío.
  String _trasladoParaEditar(dynamic valor) {
    final n = double.tryParse('$valor');
    return n == null || n == 0 ? '' : numeroParaEditar(valor);
  }

  /// Neto, traslado y fechas del formulario como campos de la subida. Con partes (entrega y retiro) el
  /// servidor suma el total; sin ellas, un solo monto de traslado.
  Map<String, String> _camposCobranza() {
    String entero(String texto) => montoParaCampo(parsearMonto(texto)!);
    return {
      if (_netoCtrl.text.trim().isNotEmpty) 'monto_neto': entero(_netoCtrl.text),
      if (_conPartes(_entregaCtrl, _retiroCtrl)) ...{
        'traslado_entrega': _entregaCtrl.text.trim().isEmpty ? '0' : entero(_entregaCtrl.text),
        'traslado_retiro': _retiroCtrl.text.trim().isEmpty ? '0' : entero(_retiroCtrl.text),
      } else if (_trasladoCtrl.text.trim().isNotEmpty)
        'monto_traslado': entero(_trasladoCtrl.text),
      'fecha_emision': ?_emision,
      'fecha_vencimiento': ?_vencimiento,
    };
  }

  Future<void> _subirFactura() async {
    // "249.900" son doscientos cuarenta y nueve mil novecientos; leido con tryParse era 249,9
    final monto = parsearMonto(_montoCtrl.text);
    setState(() {
      _errorArchivo = _archivo == null ? 'Elige el PDF de la factura.' : null;
      _errorFolio = _folioCtrl.text.trim().isEmpty ? 'Escribe el folio de la factura.' : null;
      // los pesos son enteros: un monto con decimales no se envía
      _errorMonto = (_montoCtrl.text.trim().isNotEmpty && (monto == null || monto != monto.truncateToDouble()))
          ? 'Escribe un monto válido, por ejemplo 249.900.'
          : null;
      _errorNeto = _esArriendo ? _validarNeto(_netoCtrl.text, monto) : null;
      _errorTraslado = _esArriendo
          ? _validarTrasladoCampos(_entregaCtrl, _retiroCtrl, _trasladoCtrl, monto, parsearMonto(_netoCtrl.text))
          : null;
    });
    if (_errorArchivo != null || _errorFolio != null || _errorMonto != null || _errorNeto != null || _errorTraslado != null) return;
    if (_facturaPorPeriodo && (_propuesta == null || _hastaElegido == null)) {
      setState(() => _errorPropuesta = 'No hay un período por facturar en este arriendo.');
      return;
    }
    setState(() => _procesando = true);
    try {
      final esArriendo = widget.item['tipo'] == 'arriendo';
      final path = esArriendo ? '/api/facturacion/arriendo' : '/api/ordenes-trabajo/${widget.item['id']}/factura';
      final campos = <String, String>{
        if (esArriendo && !_facturaPorPeriodo) 'guia_recepcion_id': widget.item['id'].toString(),
        if (_facturaPorPeriodo) ...{
          'guia_despacho_id': widget.item['guia_despacho_id'].toString(),
          'periodo_desde': _propuesta!['desde'] as String,
          'periodo_hasta': _hastaElegido!,
        },
        'folio': _folioCtrl.text.trim(),
        if (monto != null) 'monto': montoParaCampo(monto),
        // los datos de cobranza van solo si tienen valor: un servidor o un PDF sin ellos no los exige
        if (esArriendo) ..._camposCobranza(),
      };
      final resultado = widget.subir != null
          ? await widget.subir!(path, _archivo!, campos)
          : await ApiClient.instance.postMultipart(path, bytes: _archivo!.bytes!, filename: _archivo!.name, fields: campos);
      if (mounted) {
        setState(() {
          _facturaCreada = resultado;
          _folioEditCtrl.text = resultado['folio']?.toString() ?? '';
          _montoEditCtrl.text = numeroParaEditar(resultado['monto']);
          _trasladoEditCtrl.text = _trasladoParaEditar(resultado['monto_traslado']);
          _netoEditCtrl.text = numeroParaEditar(resultado['monto_neto']);
          _entregaEditCtrl.text = _trasladoParaEditar(resultado['traslado_entrega']);
          _retiroEditCtrl.text = _trasladoParaEditar(resultado['traslado_retiro']);
          _emisionEdit = resultado['fecha_emision'] is String ? resultado['fecha_emision'] as String : null;
          _vencimientoEdit = resultado['fecha_vencimiento'] is String ? resultado['fecha_vencimiento'] as String : null;
        });
        _cargarVistaPrevia();
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo crear la factura: ${e.message}')));
      // el periodo pudo cambiar (otra factura, una recepción nueva): se muestra el vigente
      if (mounted && e.statusCode == 409 && _facturaPorPeriodo) _cargarPropuesta();
    } catch (_) {
      // plazo vencido o sin red: el servidor pudo haber creado la factura, asi que no se asume nada
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No se pudo confirmar la subida; revisa si la factura quedó cargada.'),
        ));
        if (_facturaPorPeriodo) _cargarPropuesta();
      }
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  Future<void> _guardarCambios() async {
    if (_facturaCreada == null) return;
    final monto = parsearMonto(_montoEditCtrl.text);
    final montoInvalido = _montoEditCtrl.text.trim().isNotEmpty && monto == null;
    setState(() => _errorMontoEdicion = montoInvalido ? 'Escribe un monto válido, por ejemplo 249.900.' : null);
    final esArriendo = _esArriendo;
    // el monto que quedará: el escrito o, si se dejó vacío, el que ya tenía la factura
    final montoFinal = monto ?? double.tryParse('${_facturaCreada!['monto']}');
    final errorNeto = esArriendo ? _validarNeto(_netoEditCtrl.text, montoFinal) : null;
    final errorTraslado = esArriendo
        ? _validarTrasladoCampos(_entregaEditCtrl, _retiroEditCtrl, _trasladoEditCtrl, montoFinal, parsearMonto(_netoEditCtrl.text))
        : null;
    setState(() {
      _errorNetoEdicion = errorNeto;
      _errorTrasladoEdicion = errorTraslado;
    });
    if (montoInvalido || errorNeto != null || errorTraslado != null) return;
    setState(() => _guardandoEdicion = true);
    try {
      final cuerpo = <String, dynamic>{
        'folio': _folioEditCtrl.text.trim().isEmpty ? null : _folioEditCtrl.text.trim(),
        'monto': monto,
        if (esArriendo) ..._cuerpoCobranzaEdicion(),
      };
      final actualizada = widget.corregir != null
          ? await widget.corregir!(_facturaCreada!['id'] as int, cuerpo)
          : await ApiClient.instance.patch('/api/facturacion/${_facturaCreada!['id']}', cuerpo);
      if (mounted) {
        setState(() => _facturaCreada = actualizada);
        final textoEditado = await _recalcularTextoCorreo();
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(textoEditado
              ? 'Datos actualizados. Habías editado el texto del correo: revísalo, el folio o el monto pueden haber cambiado.'
              : 'Datos actualizados. El texto del correo se actualizó con los datos nuevos.'),
        ));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudieron guardar los cambios: ${e.message}')));
    } catch (_) {
      // plazo vencido o sin red: la correccion pudo haberse guardado o no
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No se pudo confirmar el cambio (sin conexión o tardó demasiado). Revisa los datos y vuelve a guardar.'),
        ));
      }
    } finally {
      if (mounted) setState(() => _guardandoEdicion = false);
    }
  }

  /// Cuerpo del PATCH con lo de cobranza: un campo vacío se manda como null para borrarlo. Con partes del
  /// traslado el servidor suma el total; sin ellas se manda el total (0 si está vacío) y se borra la división.
  Map<String, dynamic> _cuerpoCobranzaEdicion() {
    int? entero(String texto) => texto.trim().isEmpty ? null : parsearMonto(texto)!.toInt();
    final conPartes = _conPartes(_entregaEditCtrl, _retiroEditCtrl);
    return {
      'monto_neto': entero(_netoEditCtrl.text),
      if (conPartes) ...{
        'traslado_entrega': entero(_entregaEditCtrl.text) ?? 0,
        'traslado_retiro': entero(_retiroEditCtrl.text) ?? 0,
      } else ...{
        'traslado_entrega': null,
        'traslado_retiro': null,
        'monto_traslado': entero(_trasladoEditCtrl.text) ?? 0,
      },
      'fecha_emision': _emisionEdit,
      'fecha_vencimiento': _vencimientoEdit,
    };
  }

  /// Después de corregir folio o monto vuelve a pedir el texto por defecto. Si el administrativo no había
  /// tocado el texto, lo repone; si lo había editado, lo deja como está y devuelve true para avisarle.
  Future<bool> _recalcularTextoCorreo() async {
    final antes = _vista;
    final sinEditar = antes != null &&
        _asuntoCtrl.text == (antes['asunto']?.toString() ?? '') &&
        _cuerpoCtrl.text == (antes['cuerpo']?.toString() ?? '');
    try {
      final id = _facturaCreada!['id'];
      final v = Map<String, dynamic>.from(await ApiClient.instance.get('/api/facturacion/$id/vista-previa') as Map);
      if (!mounted) return false;
      setState(() {
        _vista = v;
        if (sinEditar || antes == null) {
          _asuntoCtrl.text = v['asunto']?.toString() ?? '';
          _cuerpoCtrl.text = v['cuerpo']?.toString() ?? '';
        }
      });
    } catch (_) {
      // sin red: queda el texto anterior; el aviso de abajo le pide revisarlo
      return true;
    }
    return !(sinEditar || antes == null);
  }

  Future<void> _cargarVistaPrevia() async {
    final id = _facturaCreada?['id'];
    if (id == null) return;
    setState(() {
      _cargandoVista = true;
      _errorVista = null;
    });
    try {
      final v = await ApiClient.instance.get('/api/facturacion/$id/vista-previa');
      if (!mounted) return;
      setState(() {
        _vista = Map<String, dynamic>.from(v as Map);
        _asuntoCtrl.text = _vista!['asunto']?.toString() ?? '';
        _cuerpoCtrl.text = _vista!['cuerpo']?.toString() ?? '';
      });
    } catch (e) {
      if (mounted) setState(() => _errorVista = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargandoVista = false);
    }
  }

  void _restaurarTexto() {
    if (_vista == null) return;
    setState(() {
      _asuntoCtrl.text = _vista!['asunto']?.toString() ?? '';
      _cuerpoCtrl.text = _vista!['cuerpo']?.toString() ?? '';
    });
  }

  String? _periodoTexto() {
    final d = _vista?['periodo_desde'];
    final h = _vista?['periodo_hasta'];
    if (d == null || h == null) return null;
    return '${Formato.fecha(d)} al ${Formato.fecha(h)}';
  }

  Future<void> _autorizarEnvio() async {
    if (_facturaCreada == null) return;
    setState(() => _procesando = true);
    // solo se manda el texto si el administrativo lo cambio: si coincide con el que el servidor acaba de
    // proponer, el servidor lo arma de nuevo (con los datos vigentes de la factura)
    final cambioAsunto = _vista == null || _asuntoCtrl.text != (_vista!['asunto']?.toString() ?? '');
    final cambioCuerpo = _vista == null || _cuerpoCtrl.text != (_vista!['cuerpo']?.toString() ?? '');
    final cuerpo = <String, dynamic>{
      if (cambioAsunto) 'asunto': _asuntoCtrl.text,
      if (cambioCuerpo) 'cuerpo': _cuerpoCtrl.text,
    };
    try {
      await ApiClient.instance.post('/api/facturacion/${_facturaCreada!['id']}/autorizar-envio', cuerpo);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Envío autorizado. Quedó encolado (se procesará cuando el correo esté configurado).')),
        );
        _cerrarSinPreguntar();
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.statusCode == 409 && e.message.contains('envío pendiente')) {
        // ya estaba autorizado (por ejemplo, un clic repetido o un reintento tras un corte): no es un error
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Esta factura ya tenía un envío pendiente: no hace falta autorizarlo de nuevo.')),
        );
        _cerrarSinPreguntar();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo autorizar el envío: ${e.message}')));
      }
    } catch (_) {
      // plazo vencido o sin red: el servidor pudo haber encolado el correo
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No se pudo confirmar el envío (sin conexión o tardó demasiado). Vuelve a intentarlo: si ya estaba autorizado, el sistema lo avisará.'),
        ));
      }
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  bool _envioAutorizado = false;
  bool _salidaLibre = false;

  bool get _pendienteDeEnvio => _facturaCreada != null && !_envioAutorizado && !_salidaLibre;

  /// Cierre tras un envío autorizado: no pide confirmación.
  void _cerrarSinPreguntar() {
    _envioAutorizado = true;
    Navigator.pop(context);
  }

  /// Si la factura ya existe y no se envió, pide confirmar antes de cerrar el cuadro.
  Future<void> _pedirCierre() async {
    if (!_pendienteDeEnvio) {
      Navigator.pop(context);
      return;
    }
    final cerrar = await mostrarConfirmacion(
      context,
      titulo: 'Factura sin enviar',
      mensaje: 'La factura quedó cargada pero no se envió por correo. ¿Cerrar igual?',
      textoAccion: 'Cerrar sin enviar',
      textoCancelar: 'Volver',
    );
    if (!cerrar || !mounted) return;
    // el PopScope deja salir recién al reconstruir: se avisa y se cierra después
    setState(() => _salidaLibre = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.pop(context);
    });
  }

  @override
  Widget build(BuildContext context) {
    final subiendo = _facturaCreada == null;
    return PopScope(
      canPop: !_pendienteDeEnvio,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _pedirCierre();
      },
      child: _construirCuadro(subiendo),
    );
  }

  Widget _construirCuadro(bool subiendo) {
    return CuadroDialogo(
      alCerrar: _pedirCierre,
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
        TextButton(onPressed: _pedirCierre, child: const Text('Cerrar')),
        if (subiendo)
          FilledButton(
            onPressed: (_procesando || _detectando || (_facturaPorPeriodo && (_propuesta?['nada_que_facturar'] ?? true) == true)) ? null : _subirFactura,
            child: _procesando
                ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Subir factura'),
          )
        else
          FilledButton.icon(
            onPressed: (_procesando || _vista == null || _vista?['envio_pendiente'] == true) ? null : _autorizarEnvio,
            icon: const Icon(Icons.send, size: 16),
            label: const Text('Enviar factura por correo'),
          ),
      ],
    );
  }

  Widget _construirPeriodo() {
    if (_cargandoPropuesta && _propuesta == null) {
      return const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator());
    }
    final p = _propuesta;
    if (p == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_errorPropuesta ?? 'No se pudo calcular el período.', style: const TextStyle(color: GomaqColors.estadoNegativo)),
          TextButton.icon(onPressed: _cargarPropuesta, icon: const Icon(Icons.refresh), label: const Text('Reintentar')),
          const SizedBox(height: 8),
        ],
      );
    }
    final opciones = List<String>.from(p['opciones_hasta'] ?? const []);
    final final_ = _hastaElegido != null && _hastaElegido == p['fin'];
    final avisos = <String>[
      if (p['falta_recepcion'] == true) 'Falta registrar la recepción: el arriendo se cerró al despachar el equipo a otro cliente.',
      if (p['facturado_de_mas'] == true) 'Ya se facturó más allá de la recepción. Si corresponde, emite una nota de crédito en el SII.',
      ?_errorPropuesta,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const TituloSeccion('Período a facturar'),
        if (p['nada_que_facturar'] == true)
          const Text('No hay días por facturar en este arriendo.')
        else ...[
          LayoutBuilder(builder: (context, caja) {
            final desdeCampo = InputDecorator(
              decoration: decoracionCampo('Desde'),
              child: Text(Formato.fecha(p['desde'])),
            );
            final hastaCampo = DropdownButtonFormField<String>(
              key: ValueKey(_hastaElegido),
              initialValue: _hastaElegido,
              isExpanded: true,
              decoration: decoracionCampo('Hasta'),
              items: [for (final o in opciones) DropdownMenuItem(value: o, child: Text(Formato.fecha(o)))],
              onChanged: (v) => setState(() => _hastaElegido = v),
            );
            // bajo 600 px (el cuadro mide menos) cada campo en su propia fila: lado a lado quedan de ~115 px
            if (MediaQuery.sizeOf(context).width < 600 || caja.maxWidth < 360) {
              return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [desdeCampo, const SizedBox(height: 12), hastaCampo]);
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [Expanded(child: desdeCampo), const SizedBox(width: 12), Expanded(child: hastaCampo)],
            );
          }),
          if (_hastaElegido != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '${_diasEntre(p['desde'] as String, _hastaElegido!)} día(s) · ${final_ ? 'Último período del arriendo' : 'Período parcial: el arriendo sigue'}',
                style: const TextStyle(fontSize: 12, color: Colors.black54),
              ),
            ),
        ],
        for (final aviso in avisos)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(aviso, style: const TextStyle(fontSize: 12, color: GomaqColors.estadoAdvertencia)),
          ),
        const SizedBox(height: 16),
      ],
    );
  }

  /// Lo que leyó el servidor del PDF y conviene revisar (traslado dividido, varias cuotas, vencimiento
  /// calculado con el plazo del cliente...). Se anuncia solo al lector de pantalla y nunca bloquea.
  Widget _construirAvisos() {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Semantics(
        liveRegion: true,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: GomaqColors.advertenciaFuerte.withValues(alpha: 0.07),
            border: Border.all(color: GomaqColors.advertenciaFuerte.withValues(alpha: 0.6)),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Revisa lo que se leyó de la factura',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: GomaqColors.advertenciaFuerte)),
              for (final aviso in _avisos)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Padding(
                        padding: EdgeInsets.only(top: 1),
                        child: ExcludeSemantics(child: Icon(Icons.warning_amber_rounded, size: 16, color: GomaqColors.advertenciaFuerte)),
                      ),
                      const SizedBox(width: 6),
                      Expanded(child: Text('${aviso['mensaje']}', style: const TextStyle(fontSize: 13))),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// Dos campos lado a lado y, en un cuadro angosto (teléfono), uno bajo el otro.
  Widget _dosCampos(Widget a, Widget b) {
    return LayoutBuilder(builder: (context, caja) {
      if (caja.maxWidth < 360) {
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [a, const SizedBox(height: 12), b]);
      }
      return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: a), const SizedBox(width: 12), Expanded(child: b)]);
    });
  }

  /// Monto neto, traslado (entrega, retiro y total) y fechas de emisión y vencimiento de un arriendo. Sirve
  /// para el formulario de subida y para corregir la factura ya creada. Con una parte del traslado escrita el
  /// total es su suma (no se edita); sin partes, el total se escribe a mano.
  Widget _camposCobranzaUi({
    required TextEditingController neto,
    required TextEditingController entrega,
    required TextEditingController retiro,
    required TextEditingController total,
    required String? errorNeto,
    required String? errorTraslado,
    required String? emision,
    required String? vencimiento,
    required ValueChanged<String?> alEmision,
    required ValueChanged<String?> alVencimiento,
    required VoidCallback alEditarNeto,
    required VoidCallback alEditarTraslado,
    required bool conOpciones,
  }) {
    final conPartes = _conPartes(entrega, retiro);
    void alCambiarParte(String _) {
      setState(() => _sincronizarTotal(entrega, retiro, total));
      alEditarTraslado();
    }

    final opciones = conOpciones ? _opcionesVencimiento : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextFormField(
          controller: neto,
          keyboardType: TextInputType.number,
          decoration: decoracionCampo('Monto neto (opcional)', prefijo: r'$ ').copyWith(errorText: errorNeto),
          onChanged: (_) => alEditarNeto(),
        ),
        const SizedBox(height: 12),
        const TituloSeccion('Traslado incluido en el monto'),
        _dosCampos(
          TextFormField(
            controller: entrega,
            keyboardType: TextInputType.number,
            decoration: decoracionCampo('Traslado de entrega', prefijo: r'$ '),
            onChanged: alCambiarParte,
          ),
          TextFormField(
            controller: retiro,
            keyboardType: TextInputType.number,
            decoration: decoracionCampo('Traslado de retiro', prefijo: r'$ '),
            onChanged: alCambiarParte,
          ),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: total,
          readOnly: conPartes,
          keyboardType: TextInputType.number,
          decoration: decoracionCampo('Traslado total (opcional)', prefijo: r'$ ').copyWith(
            errorText: errorTraslado,
            helperText: conPartes
                ? 'Suma de entrega y retiro.'
                : 'Entrega y retiro del equipo. No cuenta como ingreso del equipo en la rentabilidad.',
          ),
          onChanged: (_) => alEditarTraslado(),
        ),
        const SizedBox(height: 12),
        _dosCampos(
          CampoFechaOpcional(
            etiqueta: 'Fecha de emisión',
            valor: emision,
            onChanged: alEmision,
            ultima: DateTime.now().add(const Duration(days: 1)),
          ),
          CampoFechaOpcional(etiqueta: 'Fecha de vencimiento', valor: vencimiento, onChanged: alVencimiento),
        ),
        if (opciones != null) ...[
          const SizedBox(height: 8),
          Semantics(
            liveRegion: true,
            child: const Text('El vencimiento de la factura no coincide con el plazo del cliente. Elige cuál guardar:',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          ),
          RadioGroup<String>(
            groupValue: vencimiento,
            onChanged: (v) => alVencimiento(v),
            child: Column(
              children: [
                for (final o in opciones)
                  RadioListTile<String>(
                    key: ValueKey('vencimiento-${o.dia}'),
                    value: o.dia,
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    title: Text(o.texto, style: const TextStyle(fontSize: 13)),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _construirFormulario() {
    return [
      if (_facturaPorPeriodo) _construirPeriodo(),
      const TituloSeccion('Documento PDF de la factura'),
      ZonaArrastrePdf(
        onArchivo: _recibirArchivo,
        builder: (context, arrastrando) => Container(
          width: double.infinity,
          padding: arrastrando ? const EdgeInsets.all(12) : EdgeInsets.zero,
          decoration: BoxDecoration(
            color: arrastrando ? Colors.blue.shade50 : null,
            border: arrastrando ? Border.all(color: Colors.blue.shade800, width: 3) : null,
            borderRadius: BorderRadius.circular(8),
          ),
          child: arrastrando
              ? const Text('Suelta el PDF aquí', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold))
              : Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 12,
                  children: [
                    OutlinedButton.icon(
                      onPressed: _elegirArchivo,
                      icon: const Icon(Icons.upload_file),
                      label: Text(_archivo?.name ?? 'Elegir PDF'),
                    ),
                    if (_archivo == null) Text('o arrástralo aquí', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                  ],
                ),
        ),
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
      if (_avisos.isNotEmpty) _construirAvisos(),
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
      if (_esArriendo) ...[
        const SizedBox(height: 12),
        _camposCobranzaUi(
          neto: _netoCtrl,
          entrega: _entregaCtrl,
          retiro: _retiroCtrl,
          total: _trasladoCtrl,
          errorNeto: _errorNeto,
          errorTraslado: _errorTraslado,
          emision: _emision,
          vencimiento: _vencimiento,
          alEmision: (v) => setState(() => _emision = v),
          alVencimiento: (v) => setState(() => _vencimiento = v),
          alEditarNeto: () {
            if (_errorNeto != null) setState(() => _errorNeto = null);
          },
          alEditarTraslado: () => setState(() => _errorTraslado = null),
          conOpciones: true,
        ),
      ],
    ];
  }

  List<Widget> _construirVistaPrevia() {
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
            if (_esArriendo) ...[
              const SizedBox(height: 10),
              _camposCobranzaUi(
                neto: _netoEditCtrl,
                entrega: _entregaEditCtrl,
                retiro: _retiroEditCtrl,
                total: _trasladoEditCtrl,
                errorNeto: _errorNetoEdicion,
                errorTraslado: _errorTrasladoEdicion,
                emision: _emisionEdit,
                vencimiento: _vencimientoEdit,
                alEmision: (v) => setState(() => _emisionEdit = v),
                alVencimiento: (v) => setState(() => _vencimientoEdit = v),
                alEditarNeto: () {
                  if (_errorNetoEdicion != null) setState(() => _errorNetoEdicion = null);
                },
                alEditarTraslado: () => setState(() => _errorTrasladoEdicion = null),
                conOpciones: false,
              ),
            ],
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
      const TituloSeccion('Correo al cliente'),
      if (_periodoTexto() != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: LineaInfo(icono: Icons.date_range, texto: 'Período facturado: ${_periodoTexto()}'),
        ),
      if (_cargandoVista && _vista == null)
        const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator())
      else if (_errorVista != null && _vista == null)
        Row(
          children: [
            Expanded(child: Text('No se pudo preparar el correo: $_errorVista', style: const TextStyle(color: GomaqColors.estadoNegativo))),
            TextButton(onPressed: _cargarVistaPrevia, child: const Text('Reintentar')),
          ],
        )
      else ...[
        if (_vista?['envio_pendiente'] == true)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: LineaInfo(icono: Icons.schedule_send, texto: 'Esta factura ya tiene un envío pendiente.'),
          ),
        TextField(
          controller: _asuntoCtrl,
          maxLength: 200,
          decoration: decoracionCampo('Asunto'),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _cuerpoCtrl,
          minLines: 5,
          maxLines: 12,
          maxLength: 5000,
          decoration: decoracionCampo('Mensaje'),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(onPressed: _restaurarTexto, icon: const Icon(Icons.restore, size: 16), label: const Text('Restaurar texto')),
        ),
      ],
      if (_vista?['orden_trabajo_id'] != null) ...[
        const SizedBox(height: 8),
        FotosOrden(ordenId: _vista!['orden_trabajo_id']),
      ],
    ];
  }
}
