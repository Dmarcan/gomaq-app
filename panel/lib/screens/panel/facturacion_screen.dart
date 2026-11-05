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
import '../../widgets/fotos_orden.dart';
import 'arriendos_en_curso_tab.dart';
import 'ordenes_screen.dart' show abrirDetalleOrden;

class FacturacionScreen extends StatefulWidget {
  /// Pestaña con la que se abre: 'valorizar' llega desde el atajo del Dashboard y 'en_curso' abre
  /// los arriendos en curso.
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

  @override
  void initState() {
    super.initState();
    _tabController = TabController(
      length: 3,
      vsync: this,
      initialIndex: switch (widget.pestanaInicial) { 'valorizar' => 1, 'en_curso' => 2, _ => 0 },
    );
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
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? EstadoError(titulo: 'No se pudo cargar la facturación', mensaje: _error!, onReintentar: _cargar)
              : TabBarView(
                  controller: _tabController,
                  children: [_construirPorFacturar(), _construirPendienteValorizar(), ArriendosEnCursoTab(filtroInicial: widget.filtroInicial)],
                ),
    );
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
  const FacturaPendienteDialog({super.key, required this.item});

  @override
  State<FacturaPendienteDialog> createState() => _FacturaPendienteDialogState();
}

class _FacturaPendienteDialogState extends State<FacturaPendienteDialog> {
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
    if (_facturaPorPeriodo && (_propuesta == null || _hastaElegido == null)) {
      setState(() => _errorPropuesta = 'No hay un período por facturar en este arriendo.');
      return;
    }
    setState(() => _procesando = true);
    try {
      final esArriendo = widget.item['tipo'] == 'arriendo';
      final path = esArriendo ? '/api/facturacion/arriendo' : '/api/ordenes-trabajo/${widget.item['id']}/factura';
      final resultado = await ApiClient.instance.postMultipart(
        path,
        bytes: _archivo!.bytes!,
        filename: _archivo!.name,
        fields: {
          if (esArriendo && !_facturaPorPeriodo) 'guia_recepcion_id': widget.item['id'].toString(),
          if (_facturaPorPeriodo) ...{
            'guia_despacho_id': widget.item['guia_despacho_id'].toString(),
            'periodo_desde': _propuesta!['desde'] as String,
            'periodo_hasta': _hastaElegido!,
          },
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
        _cargarVistaPrevia();
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
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
    if (montoInvalido) return;
    setState(() => _guardandoEdicion = true);
    try {
      final actualizada = await ApiClient.instance.patch('/api/facturacion/${_facturaCreada!['id']}', {
        'folio': _folioEditCtrl.text.trim().isEmpty ? null : _folioEditCtrl.text.trim(),
        'monto': monto,
      });
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
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
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

  /// Pide al servidor el texto por defecto del correo (asunto, cuerpo y periodo) de la factura creada.
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
        Navigator.pop(context);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.statusCode == 409 && e.message.contains('envío pendiente')) {
        // ya estaba autorizado (por ejemplo, un clic repetido o un reintento tras un corte): no es un error
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Esta factura ya tenía un envío pendiente: no hace falta autorizarlo de nuevo.')),
        );
        Navigator.pop(context);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
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

  List<Widget> _construirFormulario() {
    return [
      if (_facturaPorPeriodo) _construirPeriodo(),
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
