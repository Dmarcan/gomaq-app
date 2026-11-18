import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';

/// Aviso único de la lista cuando el servidor no tiene proveedor de envío conectado.
const avisoProveedorSinConectar =
    'No hay un proveedor de envío conectado (correo o mensajes): los avisos quedan registrados, pero no salen hacia el destinatario.';

/// El error que deja el worker cuando falta el proveedor ("Proveedor de email no configurado todavia").
bool errorProveedorSinConectar(Object? ultimoError) =>
    RegExp(r'Proveedor de \S+ no configurado', caseSensitive: false).hasMatch('${ultimoError ?? ''}');

/// Un aviso en error cuyo único problema es que no hay proveedor de envío: no es una falla del aviso.
bool esAvisoSinProveedor(Map n) => n['estado'] == 'error' && errorProveedorSinConectar(n['ultimo_error']);

/// Reintentar solo sirve en un error real: sin proveedor conectado volvería a fallar igual.
bool puedeReintentarAviso(Map n) => n['estado'] == 'error' && !esAvisoSinProveedor(n);

/// Color del punto de la fila: gris apagado para el aviso sin proveedor (el texto lo dice), el de siempre en el resto.
Color colorPuntoAviso(Map n) =>
    esAvisoSinProveedor(n) ? GomaqColors.grisApagado : GomaqColors.colorEstado(n['estado']);

/// La línea de detalle de un aviso. Un error por proveedor sin conectar se dice en limpio; los demás
/// errores se muestran como vienen.
String textoDetalleNotificacion(Map n) {
  if (n['estado'] == 'error') {
    if (errorProveedorSinConectar(n['ultimo_error'])) {
      return 'Sin proveedor de envío conectado: el aviso quedó registrado.';
    }
    return 'Error tras ${n['intentos']} intentos: ${n['ultimo_error'] ?? ''}';
  }
  if (n['estado'] == 'cancelado') return 'Cancelada: ${n['ultimo_error'] ?? 'ya no corresponde enviarla'}';
  return 'Estado: ${n['estado']} (${n['intentos']} intentos)';
}

/// Texto en minúsculas y sin tildes, para comparar lo que el usuario escribe.
String _plano(Object? v) => '${v ?? ''}'
    .toLowerCase()
    .replaceAll('á', 'a')
    .replaceAll('é', 'e')
    .replaceAll('í', 'i')
    .replaceAll('ó', 'o')
    .replaceAll('ú', 'u')
    .replaceAll('ñ', 'n');

/// El `payload` de un aviso (folio, cliente, ...). Vacío si no es un objeto.
Map<String, dynamic> payloadAviso(Map n) {
  final p = n['payload'];
  return p is Map ? Map<String, dynamic>.from(p) : <String, dynamic>{};
}

/// Si el aviso coincide con el texto buscado: por folio de la factura, cliente o destinatario.
bool avisoCoincide(Map n, String texto) {
  final t = _plano(texto.trim());
  if (t.isEmpty) return true;
  final p = payloadAviso(n);
  return [p['folio'], p['cliente_nombre'], n['destinatario']].any((v) => _plano(v).contains(t));
}

/// Busca facturas emitidas por folio o cliente: `GET /api/facturacion/emitidas?q=...`. Devuelve las filas.
typedef BuscarFacturas = Future<List<Map<String, dynamic>>> Function(String q);

/// Reenvía el correo de una factura: `POST /api/facturacion/:id/autorizar-envio`.
typedef ReenviarCorreo = Future<void> Function(int facturaId);

/// Carga los avisos (`soloProblemas` pide la vista filtrada del dashboard).
typedef CargarAvisos = Future<dynamic> Function({required bool soloProblemas});

Future<dynamic> _cargarAvisosPorDefecto({required bool soloProblemas}) =>
    ApiClient.instance.get(soloProblemas ? '/api/notificaciones?problemas=1' : '/api/notificaciones');

Future<List<Map<String, dynamic>>> _buscarFacturasPorDefecto(String q) async {
  final consulta = Uri(queryParameters: {'estado': 'todas', 'q': q, 'limit': '10'}).query;
  final r = await ApiClient.instance.get('/api/facturacion/emitidas?$consulta');
  return [for (final f in ((r as Map)['items'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];
}

Future<void> _reenviarPorDefecto(int facturaId) async {
  await ApiClient.instance.post('/api/facturacion/$facturaId/autorizar-envio', {});
}

class NotificacionesScreen extends StatefulWidget {
  /// 'problemas' llega desde el dashboard: solo los avisos que ese número cuenta (con error o atrasados,
  /// sin los avisos internos), con el total real aunque la lista tenga un tope.
  final String? filtroInicial;

  /// Solo el administrativo puede reenviar correos. Si es null se lee de la sesión.
  final bool? puedeReenviar;
  final CargarAvisos cargarAvisos;
  final BuscarFacturas buscarFacturas;
  final ReenviarCorreo reenviarCorreo;
  const NotificacionesScreen({
    super.key,
    this.filtroInicial,
    this.puedeReenviar,
    this.cargarAvisos = _cargarAvisosPorDefecto,
    this.buscarFacturas = _buscarFacturasPorDefecto,
    this.reenviarCorreo = _reenviarPorDefecto,
  });

  @override
  State<NotificacionesScreen> createState() => _NotificacionesScreenState();
}

class _NotificacionesScreenState extends State<NotificacionesScreen> {
  List<dynamic> _notificaciones = [];
  bool _cargando = true;
  String? _error;
  bool _soloProblemas = false;
  int _totalProblemas = 0;
  final _busquedaCtrl = TextEditingController();
  String _texto = '';
  List<Map<String, dynamic>>? _facturas;
  bool _buscandoFacturas = false;
  String? _errorFacturas;
  String? _aviso;

  @override
  void initState() {
    super.initState();
    _soloProblemas = widget.filtroInicial == 'problemas';
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    super.dispose();
  }

  bool get _puedeReenviar => widget.puedeReenviar ?? context.read<AuthService>().esAdministrativo;

  List<dynamic> get _visibles =>
      _texto.isEmpty ? _notificaciones : _notificaciones.where((n) => avisoCoincide(n as Map, _texto)).toList();

  Future<void> _buscarEmitidas() async {
    final q = _busquedaCtrl.text.trim();
    if (q.isEmpty) return;
    setState(() {
      _texto = q;
      _buscandoFacturas = true;
      _errorFacturas = null;
      _aviso = null;
    });
    try {
      final r = await widget.buscarFacturas(q);
      if (mounted && _texto == q) setState(() => _facturas = r);
    } catch (e) {
      if (mounted) {
        setState(() {
          _facturas = null;
          _errorFacturas = 'No se pudo buscar en las facturas emitidas: ${mensajeErrorCarga(e)}';
        });
      }
    } finally {
      if (mounted) setState(() => _buscandoFacturas = false);
    }
  }

  void _limpiarBusqueda() {
    _busquedaCtrl.clear();
    setState(() {
      _texto = '';
      _facturas = null;
      _errorFacturas = null;
    });
  }

  Future<void> _reenviarCorreo(Map<String, dynamic> f) async {
    final correo = f['cliente_email'];
    final destino = correo is String && correo.isNotEmpty
        ? 'al correo $correo'
        : 'al correo registrado de ${f['cliente_nombre'] ?? 'el cliente'}';
    final ok = await mostrarConfirmacion(
      context,
      titulo: 'Reenviar correo',
      mensaje: 'Se enviará de nuevo la factura ${f['folio']} $destino.',
      textoAccion: 'Reenviar',
      icono: Icons.forward_to_inbox,
    );
    if (!ok || !mounted) return;
    try {
      await widget.reenviarCorreo(f['id'] as int);
      if (!mounted) return;
      setState(() => _aviso = 'Correo de la factura ${f['folio']} puesto en la cola de envío.');
      _cargar();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _aviso = e.statusCode == 409
          ? 'La factura ${f['folio']} ya tiene un envío pendiente: espera a que salga antes de reenviarla.'
          : 'No se pudo reenviar el correo de la factura ${f['folio']}: ${e.message}');
    } catch (e) {
      if (mounted) setState(() => _aviso = 'No se pudo reenviar el correo de la factura ${f['folio']}: ${mensajeErrorCarga(e)}');
    }
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await widget.cargarAvisos(soloProblemas: _soloProblemas);
      if (!mounted) return;
      setState(() {
        if (_soloProblemas) {
          // { items, total, hay_mas }: el total es el número que mostró el dashboard
          _notificaciones = (data['items'] as List?) ?? [];
          _totalProblemas = (data['total'] as num?)?.toInt() ?? _notificaciones.length;
        } else {
          _notificaciones = data;
        }
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      // sin red o dato inesperado
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _reintentar(int id) async {
    try {
      await ApiClient.instance.post('/api/notificaciones/$id/reintentar', {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Notificación devuelta a la cola de envío')));
      }
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo reintentar el envío: ${e.message}')));
    }
  }

  /// Aviso de que la lista viene filtrada desde el dashboard, con la salida para ver todos.
  bool get _hayProveedorSinConectar =>
      _notificaciones.any((n) => n['estado'] == 'error' && errorProveedorSinConectar(n['ultimo_error']));

  Widget _encabezadoFiltro() {
    final hayMas = _totalProblemas > _notificaciones.length;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              hayMas
                  ? 'Avisos con problemas: $_totalProblemas (se muestran los ${_notificaciones.length} más recientes)'
                  : 'Avisos con problemas: $_totalProblemas',
              style: const TextStyle(fontSize: 13),
            ),
          ),
          TextButton(
            onPressed: () => context.go('/notificaciones'),
            child: const Text('Ver todos'),
          ),
        ],
      ),
    );
  }

  Widget _cabeceraBusqueda() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: _busquedaCtrl,
          textInputAction: TextInputAction.search,
          onChanged: (v) => setState(() {
            final anterior = _texto;
            _texto = v.trim();
            // los resultados de facturas son de la busqueda anterior: no se muestran (ni se puede reenviar
            // desde ellos) mientras el texto no coincida con el que se busco
            if (_texto.isEmpty || _texto != anterior) {
              _facturas = null;
              _errorFacturas = null;
            }
          }),
          onSubmitted: (_) => _buscarEmitidas(),
          decoration: decoracionCampo('Buscar por número de factura o cliente',
              ayuda: 'Filtra los últimos 100 avisos. Con Buscar también se consultan las facturas emitidas.').copyWith(
            suffixIcon: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_texto.isNotEmpty) IconButton(icon: const Icon(Icons.close), tooltip: 'Limpiar búsqueda', onPressed: _limpiarBusqueda),
                IconButton(icon: const Icon(Icons.search), tooltip: 'Buscar', onPressed: _buscarEmitidas),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
        // el resultado de reenviar o de buscar se anuncia solo
        Semantics(
          container: true,
          liveRegion: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_aviso != null) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(_aviso!, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
              if (_errorFacturas != null) Text(_errorFacturas!, style: const TextStyle(fontSize: 13, color: GomaqColors.estadoNegativo)),
              if (_buscandoFacturas) const Text('Buscando facturas...', style: TextStyle(fontSize: 13)),
            ],
          ),
        ),
        if (_facturas != null) ...[
          Semantics(
            header: true,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Text(
                _facturas!.isEmpty ? 'Facturas emitidas: sin resultados para "$_texto"' : 'Facturas emitidas encontradas',
                style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
              ),
            ),
          ),
          for (final f in _facturas!)
            Card(
              key: ValueKey('factura-${f['id']}'),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Factura ${f['folio']}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                    Text('${f['cliente_nombre'] ?? 'Sin cliente'}', style: const TextStyle(fontSize: 13)),
                    if (_puedeReenviar) ...[
                      const SizedBox(height: 8),
                      OutlinedButton.icon(
                        onPressed: () => _reenviarCorreo(f),
                        icon: const Icon(Icons.forward_to_inbox, size: 18),
                        label: const Text('Reenviar correo'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          const Divider(height: 24),
        ],
      ],
    );
  }

  Widget _avisos() {
    final visibles = _visibles;
    if (_cargando) return const Padding(padding: EdgeInsets.symmetric(vertical: 40), child: Center(child: CircularProgressIndicator()));
    if (_error != null) {
      return SizedBox(height: 280, child: EstadoError(titulo: 'No se pudieron cargar los avisos', mensaje: _error!, onReintentar: _cargar));
    }
    if (_notificaciones.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 40),
        child: Center(child: Text(_soloProblemas ? 'No hay avisos con problemas' : 'No hay notificaciones registradas')),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_soloProblemas) _encabezadoFiltro(),
        if (_hayProveedorSinConectar)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: LineaInfo(icono: Icons.info_outline, texto: avisoProveedorSinConectar),
          ),
        if (visibles.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text('Ningún aviso reciente coincide con "$_texto".'),
          ),
        for (final n in visibles)
          Card(
            child: ListTile(
              leading: Icon(Icons.circle, size: 12, color: colorPuntoAviso(n)),
              title: Text(_titulo(n)),
              subtitle: Text(
                textoDetalleNotificacion(n),
                style: esAvisoSinProveedor(n) ? const TextStyle(color: GomaqColors.grisApagado) : null,
              ),
              trailing: puedeReintentarAviso(n)
                  ? OutlinedButton.icon(
                      onPressed: () => _reintentar(n['id']),
                      icon: const Icon(Icons.replay, size: 16),
                      label: const Text('Reintentar'),
                    )
                  : null,
            ),
          ),
      ],
    );
  }

  String _titulo(Map n) {
    final p = payloadAviso(n);
    final factura = p['folio'] != null ? 'Factura ${p['folio']}${p['cliente_nombre'] != null ? ' (${p['cliente_nombre']})' : ''}: ' : '';
    return '$factura${n['canal']} -> ${n['destinatario']}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(
          padding: const EdgeInsets.all(16),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [_cabeceraBusqueda(), _avisos()],
        ),
      ),
    );
  }
}
