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

/// El aviso es el correo de una factura (canal correo, tipo `factura_emitida`).
bool esCorreoDeFactura(Map n) => n['canal'] == 'email' && payloadAviso(n)['tipo'] == 'factura_emitida';

/// Id de la factura de un correo de factura, o null si el aviso no lo trae.
int? facturaDelAviso(Map n) {
  final v = payloadAviso(n)['factura_id'];
  return v is num ? v.toInt() : int.tryParse('${v ?? ''}');
}

/// Fotos del antes y el después que llevó ese correo (ids de `foto_ids` del aviso). Vacía si no llevó.
List<int> fotosDelAviso(Map n) {
  final v = payloadAviso(n)['foto_ids'];
  return v is List ? [for (final id in v) if (id is num) id.toInt()] : const [];
}

/// "2 fotos adjuntas" / "1 foto adjunta"; null si el correo no llevó fotos.
String? textoFotosAviso(Map n) {
  final k = fotosDelAviso(n).length;
  return k == 0 ? null : '$k ${k == 1 ? 'foto adjunta' : 'fotos adjuntas'}';
}

/// Reenviar desde la fila: correos de factura que ya salieron, fallaron o se cancelaron. No los que esperan salir
/// (ya van a salir), ni los de un correo sin proveedor (volvería a fallar igual), ni los cancelados porque la
/// factura se anuló (no hay nada que reenviar). Si el servidor dice que la factura ya no existe, tampoco.
bool puedeReenviarFila(Map n) {
  if (!esCorreoDeFactura(n) || facturaDelAviso(n) == null) return false;
  final estado = n['estado'];
  if (estado != 'enviado' && estado != 'error' && estado != 'cancelado') return false;
  if (esAvisoSinProveedor(n)) return false;
  if (estado == 'cancelado' && '${n['ultimo_error'] ?? ''}'.toLowerCase().contains('factura anulada')) return false;
  return n['factura_existe'] != false;
}

/// La línea de detalle de un aviso, con las fotos que llevó si las llevó.
String textoDetalleNotificacion(Map n) {
  final base = _detalleBase(n);
  final fotos = textoFotosAviso(n);
  return fotos == null ? base : '$base · $fotos';
}

/// Un error por proveedor sin conectar se dice en limpio; los demás errores se muestran como vienen.
String _detalleBase(Map n) {
  if (n['estado'] == 'error') {
    if (errorProveedorSinConectar(n['ultimo_error'])) {
      return 'Sin proveedor de envío conectado: el aviso quedó registrado.';
    }
    return 'Error tras ${n['intentos']} intentos: ${n['ultimo_error'] ?? ''}';
  }
  if (n['estado'] == 'cancelado') return 'Cancelada: ${n['ultimo_error'] ?? 'ya no corresponde enviarla'}';
  // un pendiente que ya falló (por ejemplo una clave mala del proveedor, que el worker reintenta cada hora sin
  // gastar intentos) muestra el motivo, para que se vea por qué no sale
  final motivo = '${n['ultimo_error'] ?? ''}'.trim();
  if (n['estado'] == 'pendiente' && motivo.isNotEmpty) {
    return 'Pendiente (${n['intentos']} intentos): $motivo';
  }
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
  return [p['folio'], p['cliente_nombre'], n['destinatario'], n['usuario_nombre']].any((v) => _plano(v).contains(t));
}

/// Busca facturas emitidas por folio o cliente: `GET /api/facturacion/emitidas?q=...`. Devuelve las filas.
typedef BuscarFacturas = Future<List<Map<String, dynamic>>> Function(String q);

/// Reenvía el correo de una factura: `POST /api/facturacion/:id/autorizar-envio`. Con [fotoIds] va esa selección
/// de fotos (una lista vacía = sin fotos); sin ella el servidor repite la del último correo de esa factura.
typedef ReenviarCorreo = Future<void> Function(int facturaId, {List<int>? fotoIds});

/// Carga los avisos (`soloProblemas` pide la vista filtrada del dashboard; `canal` es 'push', 'email' o
/// 'whatsapp' y solo aplica a la lista completa).
typedef CargarAvisos = Future<dynamic> Function({required bool soloProblemas, String? canal});

Future<dynamic> _cargarAvisosPorDefecto({required bool soloProblemas, String? canal}) =>
    ApiClient.instance.get(soloProblemas
        ? '/api/notificaciones?problemas=1'
        : canal == null
            ? '/api/notificaciones'
            : '/api/notificaciones?canal=$canal');

/// Canales que se pueden filtrar: valor del servidor y texto de la pantalla.
const canalesAviso = <String, String>{'push': 'Push', 'email': 'Correo', 'whatsapp': 'WhatsApp'};

/// Rol del usuario con su nombre de pantalla (el servidor devuelve el valor interno).
String rolAviso(Object? rol) => switch ('$rol') {
      'administrativo' => 'administrativo',
      'gerente' => 'gerente',
      'mecanico' => 'mecánico',
      'cliente' => 'cliente',
      _ => '$rol',
    };

/// A quién va el aviso. Un push guarda el id de un dispositivo, que no sirve para leer: se muestra el nombre y
/// el rol del usuario (el servidor los une; nunca llega el token del dispositivo).
String destinoAviso(Map n) {
  if (n['canal'] == 'push') {
    final nombre = n['usuario_nombre'];
    if (nombre == null) return 'dispositivo sin usuario';
    return '$nombre (${rolAviso(n['usuario_rol'])})';
  }
  return '${n['destinatario']}';
}

Future<List<Map<String, dynamic>>> _buscarFacturasPorDefecto(String q) async {
  final consulta = Uri(queryParameters: {'estado': 'todas', 'q': q, 'limit': '10'}).query;
  final r = await ApiClient.instance.get('/api/facturacion/emitidas?$consulta');
  return [for (final f in ((r as Map)['items'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];
}

Future<void> _reenviarPorDefecto(int facturaId, {List<int>? fotoIds}) async {
  await ApiClient.instance.post('/api/facturacion/$facturaId/autorizar-envio', {'foto_ids': ?fotoIds});
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
  String? _canal;
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

  /// Reenvío desde una fila de la lista: repite las mismas fotos que llevó ese correo (o ninguna, si no llevó).
  Future<void> _reenviarDesdeFila(Map n) {
    final p = payloadAviso(n);
    return _reenviarCorreo(
      {'id': facturaDelAviso(n), 'folio': p['folio'] ?? facturaDelAviso(n), 'cliente_nombre': p['cliente_nombre']},
      fotoIds: fotosDelAviso(n),
    );
  }

  Future<void> _reenviarCorreo(Map<String, dynamic> f, {List<int>? fotoIds}) async {
    final correo = f['cliente_email'];
    final destino = correo is String && correo.isNotEmpty
        ? 'al correo $correo'
        : 'al correo registrado de ${f['cliente_nombre'] ?? 'el cliente'}';
    final k = fotoIds?.length ?? 0;
    final fotos = k == 0 ? '' : ', con ${k == 1 ? '1 foto adjunta' : '$k fotos adjuntas'}';
    final ok = await mostrarConfirmacion(
      context,
      titulo: 'Reenviar correo',
      mensaje: 'Se enviará de nuevo la factura ${f['folio']} $destino$fotos.',
      textoAccion: 'Reenviar',
      icono: Icons.forward_to_inbox,
    );
    if (!ok || !mounted) return;
    try {
      await widget.reenviarCorreo(f['id'] as int, fotoIds: fotoIds);
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
      final data = await widget.cargarAvisos(soloProblemas: _soloProblemas, canal: _soloProblemas ? null : _canal);
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

  /// Chips para ver un solo canal; el estado seleccionado lo anuncia el propio chip.
  Widget _filtroCanal() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        children: [
          ChoiceChip(
            key: const ValueKey('canal-todos'),
            label: const Text('Todos los canales'),
            selected: _canal == null,
            onSelected: (_) => _elegirCanal(null),
          ),
          for (final c in canalesAviso.entries)
            ChoiceChip(
              key: ValueKey('canal-${c.key}'),
              label: Text(c.value),
              selected: _canal == c.key,
              onSelected: (_) => _elegirCanal(c.key),
            ),
        ],
      ),
    );
  }

  void _elegirCanal(String? canal) {
    if (_canal == canal) return;
    setState(() => _canal = canal);
    _cargar();
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
        child: Center(
          child: Text(_soloProblemas
              ? 'No hay avisos con problemas'
              : _canal != null
                  ? 'No hay notificaciones de ese canal'
                  : 'No hay notificaciones registradas'),
        ),
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
              trailing: _accionDeFila(n),
            ),
          ),
      ],
    );
  }

  /// El botón de la fila. Un correo de factura se **reenvía** (envío nuevo, con las mismas fotos): vale para los
  /// enviados, con error y cancelados, y reemplaza a "Reintentar", que queda para el resto de los avisos con error
  /// y para quien no puede reenviar (el gerente: autorizar el envío es del administrativo).
  Widget? _accionDeFila(Map n) {
    if (_puedeReenviar && puedeReenviarFila(n)) {
      return Tooltip(
        message: 'Reenviar el correo de la factura ${payloadAviso(n)['folio'] ?? ''}'.trim(),
        child: OutlinedButton.icon(
          onPressed: () => _reenviarDesdeFila(n),
          icon: const Icon(Icons.forward_to_inbox, size: 16),
          label: const Text('Reenviar'),
        ),
      );
    }
    if (puedeReintentarAviso(n)) {
      return OutlinedButton.icon(
        onPressed: () => _reintentar(n['id']),
        icon: const Icon(Icons.replay, size: 16),
        label: const Text('Reintentar'),
      );
    }
    return null;
  }

  String _titulo(Map n) {
    final p = payloadAviso(n);
    final factura = p['folio'] != null ? 'Factura ${p['folio']}${p['cliente_nombre'] != null ? ' (${p['cliente_nombre']})' : ''}: ' : '';
    return '$factura${canalesAviso[n['canal']] ?? n['canal']} -> ${destinoAviso(n)}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(
          padding: const EdgeInsets.all(16),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [_cabeceraBusqueda(), if (!_soloProblemas) _filtroCanal(), _avisos()],
        ),
      ),
    );
  }
}
