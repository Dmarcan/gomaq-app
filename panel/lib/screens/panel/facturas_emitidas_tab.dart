import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/cobranza.dart';
import '../../utils/enlaces.dart';
import '../../utils/formato.dart';
import '../../utils/numeros.dart';
import '../../widgets/campo_fecha_opcional.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';

/// Pide una página de facturas emitidas. `estado` es un filtro de [filtrosCobranza].
typedef CargarEmitidas = Future<Map<String, dynamic>> Function({required String estado, String? q, required int offset});

/// Cambia una factura: `PATCH /api/facturacion/:id/pago` (pago y nota de crédito) o `PATCH /api/facturacion/:id`
/// (corrección de neto y vencimiento). `ruta` es la parte después de `/api/facturacion/:id`.
typedef CambiarFactura = Future<void> Function(int id, String ruta, Map<String, dynamic> cuerpo);

/// Exporta la facturación: `POST /api/facturacion/exportar` con `{desde, hasta, cliente_id}` opcionales.
/// Responde `{url, filas, sin_neto, generado_en}`.
typedef ExportarFacturas = Future<Map<String, dynamic>> Function(Map<String, dynamic> cuerpo);

/// Abre la URL firmada del archivo exportado.
typedef AbrirUrl = Future<void> Function(String url);

const _tamanoPagina = 50;

Future<Map<String, dynamic>> _cargarPorDefecto({required String estado, String? q, required int offset}) async {
  final consulta = Uri(queryParameters: {
    'estado': estado,
    if (q != null && q.isNotEmpty) 'q': q,
    'limit': '$_tamanoPagina',
    'offset': '$offset',
  }).query;
  final r = await ApiClient.instance.get('/api/facturacion/emitidas?$consulta');
  return Map<String, dynamic>.from(r as Map);
}

Future<void> _cambiarPorDefecto(int id, String ruta, Map<String, dynamic> cuerpo) async {
  await ApiClient.instance.patch('/api/facturacion/$id$ruta', cuerpo);
}

/// Pestaña "Emitidas" de Facturación: las facturas ya cargadas con su estado de cobranza.
///
/// Filtros con texto (todas, por cobrar, vencidas, próximas a vencer, pagadas, anuladas), búsqueda por
/// folio o cliente y lista paginada. El estado de cada fila lleva icono y texto además del color. Solo el
/// administrativo ([puedeEscribir]) marca pagos, anula con nota de crédito y corrige; el gerente la ve en
/// lectura.
Future<Map<String, dynamic>> _exportarPorDefecto(Map<String, dynamic> cuerpo) async {
  final r = await ApiClient.instance.post('/api/facturacion/exportar', cuerpo);
  return Map<String, dynamic>.from(r as Map);
}

class FacturasEmitidasTab extends StatefulWidget {
  /// `vencidas` o `proximas` llegan desde las tarjetas del inicio. Otro valor deja la lista completa.
  final String? filtroInicial;
  final bool puedeEscribir;
  final CargarEmitidas cargar;
  final CambiarFactura cambiar;
  final ExportarFacturas exportar;
  final AbrirUrl abrirUrl;

  /// Si la lista está acotada a un cliente, la exportación también.
  final int? clienteId;

  const FacturasEmitidasTab({
    super.key,
    this.filtroInicial,
    required this.puedeEscribir,
    this.cargar = _cargarPorDefecto,
    this.cambiar = _cambiarPorDefecto,
    this.exportar = _exportarPorDefecto,
    this.abrirUrl = abrirEnlace,
    this.clienteId,
  });

  @override
  State<FacturasEmitidasTab> createState() => _FacturasEmitidasTabState();
}

class _FacturasEmitidasTabState extends State<FacturasEmitidasTab> {
  late String _estado;
  final _busquedaCtrl = TextEditingController();
  String _q = '';
  List<Map<String, dynamic>> _items = [];
  int _total = 0;
  bool _hayMas = false;
  bool _cargando = true;
  bool _cargandoMas = false;
  String? _error;
  String? _aviso;
  int _peticion = 0;

  @override
  void initState() {
    super.initState();
    _estado = filtroCobranzaDesdeUrl(widget.filtroInicial);
    _cargarLista();
  }

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargarLista() async {
    final mia = ++_peticion;
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final r = await widget.cargar(estado: _estado, q: _q, offset: 0);
      if (!mounted || mia != _peticion) return;
      setState(() {
        _items = _filas(r);
        _total = _entero(r['total'], _items.length);
        _hayMas = r['hay_mas'] == true;
      });
    } catch (e) {
      if (mounted && mia == _peticion) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted && mia == _peticion) setState(() => _cargando = false);
    }
  }

  Future<void> _cargarMas() async {
    if (_cargandoMas) return;
    final mia = _peticion;
    setState(() => _cargandoMas = true);
    try {
      final r = await widget.cargar(estado: _estado, q: _q, offset: _items.length);
      if (!mounted || mia != _peticion) return;
      setState(() {
        _items = [..._items, ..._filas(r)];
        _total = _entero(r['total'], _items.length);
        _hayMas = r['hay_mas'] == true;
      });
    } catch (e) {
      if (mounted) setState(() => _aviso = 'No se pudieron cargar más facturas: ${mensajeErrorCarga(e)}');
    } finally {
      if (mounted) setState(() => _cargandoMas = false);
    }
  }

  static List<Map<String, dynamic>> _filas(Map<String, dynamic> r) =>
      [for (final f in (r['items'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];

  static int _entero(dynamic v, int siNo) => v is num ? v.toInt() : int.tryParse('$v') ?? siNo;

  void _elegirFiltro(String id) {
    if (id == _estado) return;
    setState(() {
      _estado = id;
      _aviso = null;
      _items = [];
    });
    _cargarLista();
  }

  void _buscar() {
    final texto = _busquedaCtrl.text.trim();
    if (texto == _q) return;
    setState(() {
      _q = texto;
      _aviso = null;
      _items = [];
    });
    _cargarLista();
  }

  Future<void> _aplicar(Map<String, dynamic> f, String ruta, Map<String, dynamic> cuerpo, String aviso) async {
    await widget.cambiar(f['id'] as int, ruta, cuerpo);
    if (!mounted) return;
    setState(() => _aviso = aviso);
    await _cargarLista();
  }

  Future<void> _marcarPagada(Map<String, dynamic> f) async {
    var dia = diaIso(DateTime.now());
    final ok = await mostrarFormulario(
      context,
      icono: Icons.payments_outlined,
      titulo: 'Marcar pagada',
      subtitulo: 'Factura ${f['folio']}',
      textoAccion: 'Marcar pagada',
      contenido: (context, redibujar) => CampoFechaOpcional(
        etiqueta: 'Fecha de pago',
        valor: dia,
        opcional: false,
        ultima: DateTime.now(),
        onChanged: (v) => redibujar(() => dia = v ?? dia),
      ),
      alGuardar: () => widget.cambiar(f['id'] as int, '/pago', {'fecha_pago': dia}),
    );
    if (!ok || !mounted) return;
    setState(() => _aviso = 'Factura ${f['folio']} marcada como pagada el ${fechaGuiones(dia)}.');
    await _cargarLista();
  }

  Future<void> _anularConNc(Map<String, dynamic> f) async {
    final folioCtrl = TextEditingController();
    final ok = await mostrarFormulario(
      context,
      icono: Icons.block,
      titulo: 'Anulada con nota de crédito',
      subtitulo: 'Factura ${f['folio']}',
      textoAccion: 'Guardar',
      contenido: (context, redibujar) => TextFormField(
        controller: folioCtrl,
        autofocus: true,
        decoration: decoracionCampo('Folio de la nota de crédito', obligatorio: true,
            ayuda: 'La factura sale de la cobranza y deja de contar como ingreso del equipo.'),
        validator: obligatorio('Escribe el folio de la nota de crédito.'),
      ),
      alGuardar: () => widget.cambiar(f['id'] as int, '/pago', {'anulada_nc': folioCtrl.text.trim()}),
    );
    final folio = folioCtrl.text.trim();
    if (!ok || !mounted) return;
    setState(() => _aviso = 'Factura ${f['folio']} anulada con la nota de crédito $folio.');
    await _cargarLista();
  }

  Future<void> _deshacer(Map<String, dynamic> f, {required bool pago}) async {
    final confirmado = await mostrarConfirmacion(
      context,
      titulo: pago ? 'Deshacer el pago' : 'Deshacer la anulación',
      mensaje: pago
          ? 'La factura ${f['folio']} vuelve a quedar por cobrar.'
          : 'La factura ${f['folio']} deja de estar anulada con la nota de crédito ${f['anulada_nc']} y vuelve a la cobranza.',
      textoAccion: 'Deshacer',
    );
    if (!confirmado || !mounted) return;
    try {
      await _aplicar(
        f,
        '/pago',
        pago ? {'fecha_pago': null} : {'anulada_nc': null},
        pago ? 'Pago de la factura ${f['folio']} deshecho.' : 'Anulación de la factura ${f['folio']} deshecha.',
      );
    } catch (e) {
      if (mounted) setState(() => _aviso = 'No se pudo deshacer: ${mensajeErrorCarga(e)}');
    }
  }

  Future<void> _corregir(Map<String, dynamic> f) async {
    final netoCtrl = TextEditingController(text: numeroParaEditar(f['monto_neto']));
    final netoInicial = netoCtrl.text;
    var vencimiento = f['fecha_vencimiento'] as String?;
    final vencimientoInicial = vencimiento;
    final ok = await mostrarFormulario(
      context,
      icono: Icons.edit_outlined,
      titulo: 'Corregir factura',
      subtitulo: 'Factura ${f['folio']}',
      textoAccion: 'Guardar',
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextFormField(
            controller: netoCtrl,
            keyboardType: TextInputType.number,
            decoration: decoracionCampo('Monto neto', prefijo: r'$ ', ayuda: 'Vacío lo borra.'),
            validator: (v) => (v == null || v.trim().isEmpty)
                ? null
                : (() {
                    final n = parsearMonto(v);
                    return (n == null || n < 0 || n != n.truncateToDouble()) ? 'Escribe un monto válido, por ejemplo 210.000.' : null;
                  })(),
          ),
          separadorCampos,
          CampoFechaOpcional(
            etiqueta: 'Fecha de vencimiento',
            valor: vencimiento,
            onChanged: (v) => redibujar(() => vencimiento = v),
          ),
        ],
      ),
      alGuardar: () {
        final cuerpo = <String, dynamic>{
          if (netoCtrl.text.trim() != netoInicial)
            'monto_neto': netoCtrl.text.trim().isEmpty ? null : parsearMonto(netoCtrl.text)!.toInt(),
          if (vencimiento != vencimientoInicial) 'fecha_vencimiento': vencimiento,
        };
        if (cuerpo.isEmpty) return Future.value();
        return widget.cambiar(f['id'] as int, '', cuerpo);
      },
    );
    if (!ok || !mounted) return;
    setState(() => _aviso = 'Factura ${f['folio']} corregida.');
    await _cargarLista();
  }

  Future<void> _exportar() async {
    String? desde;
    String? hasta;
    Map<String, dynamic>? resultado;
    final ok = await mostrarFormulario(
      context,
      icono: Icons.download_outlined,
      titulo: 'Exportar a Excel',
      subtitulo: 'Una fila por factura, con el formato de la planilla de cobranza',
      textoAccion: 'Exportar',
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const LineaInfo(
            icono: Icons.info_outline,
            texto: 'Las fechas filtran por la emisión de la factura. Sin fechas se exporta todo (hasta 5.000 facturas).',
          ),
          separadorCampos,
          CampoFechaOpcional(etiqueta: 'Desde', valor: desde, onChanged: (v) => redibujar(() => desde = v)),
          separadorCampos,
          CampoFechaOpcional(etiqueta: 'Hasta', valor: hasta, onChanged: (v) => redibujar(() => hasta = v)),
          if (widget.clienteId != null) ...[
            separadorCampos,
            const LineaInfo(icono: Icons.person_outline, texto: 'Solo las facturas del cliente de esta lista.'),
          ],
        ],
      ),
      alGuardar: () async {
        resultado = await widget.exportar({
          'desde': ?desde,
          'hasta': ?hasta,
          if (widget.clienteId != null) 'cliente_id': widget.clienteId,
        });
      },
    );
    final r = resultado;
    if (!ok || !mounted || r == null) return;
    final filas = _entero(r['filas'], 0);
    final sinNeto = _entero(r['sin_neto'], 0);
    var aviso = filas == 1 ? 'Se exportó 1 factura a Excel.' : 'Se exportaron $filas facturas a Excel.';
    if (sinNeto > 0) {
      aviso += sinNeto == 1
          ? ' 1 factura no tiene monto neto guardado: su neto es una estimación (monto / 1,19); las exentas de IVA pueden salir mal.'
          : ' $sinNeto facturas no tienen monto neto guardado: su neto es una estimación (monto / 1,19); las exentas de IVA pueden salir mal.';
    }
    final url = r['url'];
    try {
      if (url is String && url.isNotEmpty) await widget.abrirUrl(url);
    } catch (_) {
      aviso += ' No se pudo abrir la descarga automáticamente: vuelve a exportar o permite las ventanas emergentes.';
    }
    if (mounted) setState(() => _aviso = aviso);
  }

  // ---------- presentación ----------

  /// Color del texto y del icono del estado: los de texto cumplen 4,5:1 sobre blanco.
  ({IconData icono, Color color}) _estiloEstado(String? estado) => switch (estado) {
        'vencida' => (icono: Icons.error_outline, color: GomaqColors.estadoNegativo),
        'proxima' => (icono: Icons.schedule, color: GomaqColors.advertenciaFuerte),
        'pagada' => (icono: Icons.check_circle_outline, color: GomaqColors.textoEstado('operativa')),
        'anulada' => (icono: Icons.block, color: GomaqColors.grisApagado),
        'al_dia' => (icono: Icons.event_available, color: GomaqColors.textoEstado('pendiente')),
        _ => (icono: Icons.event_busy, color: GomaqColors.grisApagado),
      };

  Widget _etiquetaEstado(Map<String, dynamic> f) {
    final estado = f['estado_cobranza'] as String?;
    final e = _estiloEstado(estado);
    final fuerte = estado == 'vencida' || estado == 'proxima';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        // el borde (no solo el color) marca la urgencia
        border: Border.all(color: e.color, width: fuerte ? 1.5 : 1),
        color: e.color.withValues(alpha: fuerte ? 0.08 : 0.04),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ExcludeSemantics(child: Icon(e.icono, size: 18, color: e.color)),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              textoEstadoCobranza(f),
              style: TextStyle(fontSize: 13, color: e.color, fontWeight: fuerte ? FontWeight.w700 : FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  String _detalleEquipo(Map<String, dynamic> f) {
    final partes = <String>[];
    if (f['tipo'] == 'reparacion') {
      partes.add('Reparación OT #${f['orden_trabajo_id']}');
    } else {
      partes.add('Arriendo');
    }
    if (f['maquinaria_codigo'] != null) partes.add('${f['maquinaria_codigo']}');
    if (f['periodo_desde'] != null && f['periodo_hasta'] != null) {
      partes.add('${fechaGuiones(f['periodo_desde'] as String?)} al ${fechaGuiones(f['periodo_hasta'] as String?)}');
    }
    return partes.join(' · ');
  }

  Widget _fila(Map<String, dynamic> f) {
    final estado = f['estado_cobranza'] as String?;
    final montos = <String>[
      if (f['monto_neto'] != null) 'Neto ${Formato.clp(num.tryParse('${f['monto_neto']}'))}',
      if (((f['monto_traslado'] as num?) ?? 0) > 0) 'Traslado ${Formato.clp(f['monto_traslado'] as num)}',
    ];
    final acciones = <Widget>[
      if (widget.puedeEscribir && estado != 'pagada' && estado != 'anulada')
        OutlinedButton.icon(
          onPressed: () => _marcarPagada(f),
          icon: const Icon(Icons.payments_outlined, size: 18),
          label: const Text('Marcar pagada'),
        ),
      if (widget.puedeEscribir && estado == 'pagada')
        OutlinedButton.icon(
          onPressed: () => _deshacer(f, pago: true),
          icon: const Icon(Icons.undo, size: 18),
          label: const Text('Deshacer pago'),
        ),
      if (widget.puedeEscribir && estado != 'anulada' && estado != 'pagada')
        OutlinedButton.icon(
          onPressed: () => _anularConNc(f),
          icon: const Icon(Icons.block, size: 18),
          label: const Text('Anulada con nota de crédito'),
        ),
      if (widget.puedeEscribir && estado == 'anulada')
        OutlinedButton.icon(
          onPressed: () => _deshacer(f, pago: false),
          icon: const Icon(Icons.undo, size: 18),
          label: const Text('Deshacer anulación'),
        ),
      if (widget.puedeEscribir)
        TextButton.icon(
          onPressed: () => _corregir(f),
          icon: const Icon(Icons.edit_outlined, size: 18),
          label: const Text('Corregir'),
        ),
    ];
    return Card(
      key: ValueKey('factura-${f['id']}'),
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: Text('Factura ${f['folio']}', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))),
                const SizedBox(width: 8),
                Text(Formato.clp(f['monto'] as num?), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(height: 2),
            Text('${f['cliente_nombre'] ?? 'Sin cliente'}', style: const TextStyle(fontSize: 14)),
            Text(_detalleEquipo(f), style: const TextStyle(fontSize: 13, color: Colors.black54)),
            if (montos.isNotEmpty) Text(montos.join(' · '), style: const TextStyle(fontSize: 13, color: Colors.black54)),
            Text(
              'Emisión: ${fechaGuiones(f['fecha_emision'] as String?, siVacio: 'sin fecha')} · '
              'Vencimiento: ${fechaGuiones(f['fecha_vencimiento'] as String?, siVacio: 'sin fecha')}',
              style: const TextStyle(fontSize: 13, color: Colors.black54),
            ),
            const SizedBox(height: 10),
            _etiquetaEstado(f),
            if (acciones.isNotEmpty) ...[
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: acciones),
            ],
          ],
        ),
      ),
    );
  }

  Widget _cabecera() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final filtro in filtrosCobranza)
              ChoiceChip(
                key: ValueKey('filtro-${filtro.id}'),
                label: Text(filtro.etiqueta),
                selected: _estado == filtro.id,
                onSelected: (_) => _elegirFiltro(filtro.id),
              ),
          ],
        ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            key: const ValueKey('exportar-excel'),
            onPressed: _exportar,
            icon: const Icon(Icons.download_outlined, size: 18),
            label: const Text('Exportar a Excel'),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _busquedaCtrl,
          textInputAction: TextInputAction.search,
          onSubmitted: (_) => _buscar(),
          decoration: decoracionCampo('Buscar por folio o cliente').copyWith(
            suffixIcon: IconButton(icon: const Icon(Icons.search), tooltip: 'Buscar', onPressed: _buscar),
          ),
        ),
        if (!widget.puedeEscribir)
          const Padding(
            padding: EdgeInsets.only(top: 10),
            child: LineaInfo(icono: Icons.visibility_outlined, texto: 'Solo lectura: el administrativo registra los pagos y las notas de crédito.'),
          ),
        const SizedBox(height: 10),
        // el resultado de un filtro o de una acción se anuncia solo
        Semantics(
          container: true,
          liveRegion: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!_cargando && _error == null)
                Text(
                  _total == 1 ? '1 factura' : '$_total facturas',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
              if (_aviso != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(_aviso!, style: const TextStyle(fontSize: 13)),
                ),
            ],
          ),
        ),
        const SizedBox(height: 8),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final sinItems = _items.isEmpty;
    return RefreshIndicator(
      onRefresh: _cargarLista,
      child: ListView(
        padding: const EdgeInsets.all(16),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          _cabecera(),
          if (_cargando && sinItems)
            const Padding(padding: EdgeInsets.symmetric(vertical: 40), child: Center(child: CircularProgressIndicator()))
          else if (_error != null && sinItems)
            SizedBox(
              height: 280,
              child: EstadoError(titulo: 'No se pudieron cargar las facturas', mensaje: _error!, onReintentar: _cargarLista),
            )
          else if (sinItems)
            const SizedBox(
              height: 220,
              child: EstadoVacio(
                icono: Icons.receipt_long,
                titulo: 'No hay facturas con este filtro',
                mensaje: 'Prueba con otro estado o cambia el texto de la búsqueda.',
              ),
            )
          else ...[
            for (final f in _items) _fila(f),
            if (_hayMas)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Center(
                  child: OutlinedButton(
                    onPressed: _cargandoMas ? null : _cargarMas,
                    child: _cargandoMas
                        ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : Text('Cargar más (${_total - _items.length} restantes)'),
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
