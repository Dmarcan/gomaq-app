import 'dart:async';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../widgets/asignar_mecanico.dart';
import '../../widgets/dialogos.dart';
import '../../utils/formato.dart';
import '../../utils/historial_ot.dart';
import '../../utils/motivo_cambio.dart';
import '../../utils/numeros.dart';
import '../../utils/unidades.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/motivo_cambio_dialogo.dart';


/// Abre el detalle de una orden por su id (con el campo para aprobar la valorización si
/// corresponde). Lo usa Facturación, cuyas filas no traen todos los datos de la orden.
Future<void> abrirDetalleOrden(BuildContext context, int id, {VoidCallback? onCambio}) async {
  final Map<String, dynamic> orden;
  try {
    orden = (await ApiClient.instance.get('/api/ordenes-trabajo/$id')) as Map<String, dynamic>;
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo abrir la orden. ${mensajeErrorCarga(e)}')));
    }
    return;
  }
  if (!context.mounted) return;
  await showDialog(
    context: context,
    builder: (_) => DetalleOrden(orden: orden, onCambio: onCambio ?? () {}),
  );
}

/// Detalle de una orden. El mismo cuerpo se muestra como cuadro (desde Facturación) o como página
/// completa (/ordenes/:id): con [enPagina] las acciones no cierran la pantalla, avisan y recargan.
/// El gerente aprueba la valorización solo de una orden facturable, sin valorizar y ya finalizada.
bool puedeAprobarValorizacion({required bool esGerente, required Map orden, required bool cerrada}) =>
    esGerente && orden['facturable'] == true && orden['valorizacion'] == null && cerrada;

/// Cantidad de repuestos vigentes (no anulados) que siguen en "Por decidir" (facturable 'pendiente').
int repuestosSinDecidir(List<dynamic> lineas) => lineas
    .where((l) => l is Map && l['anulada_at'] == null && (l['facturable'] ?? 'pendiente') == 'pendiente')
    .length;

/// Texto de la confirmación al aprobar con repuestos sin decidir; no bloquea, solo avisa.
String textoConfirmarValorizacion(int n) =>
    'Hay $n ${n == 1 ? 'repuesto sin decidir si se cobra' : 'repuestos sin decidir si se cobran'}. ¿Aprobar la valorización igual?';

/// Quién atiende la orden, para la sección "Mecánico" del detalle.
String textoMecanicoOrden(Map orden) {
  final nombre = '${orden['mecanico_nombre'] ?? ''}'.trim();
  if (nombre.isNotEmpty) return nombre;
  return orden['mecanico_id'] == null ? 'Sin asignar' : 'Mecánico asignado';
}

/// El administrativo puede reasignar una orden que ya tiene mecánico y no está finalizada.
bool puedeReasignar({required bool esAdministrativo, required Map orden}) =>
    esAdministrativo && orden['mecanico_id'] != null && orden['estado'] != 'finalizada';

/// Con la orden ya en viaje o en trabajo, cambiar de mecánico deja sin efecto lo que el anterior no alcanzó a enviar.
bool reasignacionPideConfirmar(Object? estado) => const {'en_camino', 'en_terreno', 'en_reparacion'}.contains(estado);

/// Qué se dice del destino de la OT. Nunca coordenadas: solo de dónde salió.
String textoDestinoOt(Map orden) {
  if (!hayDestinoOt(orden)) return 'Sin destino';
  return switch (orden['destino_origen']) {
    'guia' => 'Ubicación de la guía',
    'solicitud' => 'Ubicación indicada en la solicitud del cliente',
    _ => 'Ubicación del cliente',
  };
}

/// El destino existe cuando están las dos coordenadas.
bool hayDestinoOt(Map orden) => orden['destino_lat'] != null && orden['destino_lng'] != null;

/// La hora de llegada estimada ("15:40"), solo con la OT en camino y si el servidor la entregó.
/// null si no corresponde mostrarla.
String? horaLlegadaEstimada(Map orden) {
  if (orden['estado'] != 'en_camino' || orden['eta_llegada_at'] == null) return null;
  final hora = Formato.diaMesHora(orden['eta_llegada_at'], siVacio: '');
  return hora.isEmpty ? null : hora;
}

/// "2,5 litro" en vez de "2.50": la cantidad de una línea de repuesto con su unidad.
String cantidadLineaRepuesto(Map linea) =>
    medidaConUnidad(linea['cantidad'], '${linea['unidad_medida'] ?? ''}', siVacio: '${linea['cantidad'] ?? ''}');

class DetalleOrden extends StatefulWidget {
  final Map<String, dynamic> orden;
  final VoidCallback onCambio;
  final bool enPagina;
  const DetalleOrden({super.key, required this.orden, required this.onCambio, this.enPagina = false});

  @override
  State<DetalleOrden> createState() => DetalleOrdenState();
}

class DetalleOrdenState extends State<DetalleOrden> {
  List<dynamic> _mecanicos = [];
  List<dynamic> _lineas = [];
  // hasta que termina la primera carga no se dice "sin repuestos" (aparecía un instante de más)
  bool _cargandoLineas = true;
  // línea de tiempo de la orden (solo administrativo y gerente)
  List<dynamic> _historial = [];
  bool _cargandoHistorial = true;
  String? _errorHistorial;
  int? _mecanicoSeleccionado;
  final _valorizacionCtrl = TextEditingController();
  bool _cargandoAccion = false;
  // avisos en su campo: antes cada uno era un mensaje pasajero abajo, o un boton que no hacia nada
  String? _errorMecanico;
  String? _errorValorizacion;
  String? _errorFolio;

  // La orden como la entrega el servidor. La lista trae una copia que se queda vieja: un cambio de
  // líneas puede anular la valorización, y la orden puede recibir su factura mientras el cuadro
  // está abierto.
  late Map<String, dynamic> _orden = Map<String, dynamic>.from(widget.orden);

  // Llave de idempotencia de los cambios de línea (cabecera Idempotency-Key). Se genera al abrir el
  // cuadro y se renueva tras cada cambio hecho: si la respuesta se pierde y el usuario reintenta el
  // mismo cambio, el servidor no lo repite. Si lo que se reintenta es otro cambio, la llave cambia.
  String _llave = nuevoUuid();
  String? _firmaLlave;

  bool get _cerrada => _orden['estado'] == 'finalizada';
  Object? get _folioFactura => _orden['factura_folio'];
  bool get _facturada => _folioFactura != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _cargarMecanicos();
      _cargarLineas();
      _cargarOrden();
      final auth = context.read<AuthService>();
      if (auth.esAdministrativo || auth.esGerente) _cargarHistorial();
    });
  }

  /// Trae la orden al día: estado, valorización y, sobre todo, si ya tiene factura y su folio.
  /// Si falla se queda con lo que traía la lista; el servidor igual rechaza lo que no corresponda.
  Future<bool> _cargarOrden() async {
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/${widget.orden['id']}');
      if (mounted && data is Map) setState(() => _orden = {..._orden, ...Map<String, dynamic>.from(data)});
      return data is Map;
    } catch (_) {
      return false;
    }
  }

  /// Aviso de red de las acciones: sin conexión o plazo vencido no llegan como ApiException.
  void _avisoRed() {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('No hubo respuesta del servidor. Revisa tu conexión y revisa si el cambio quedó hecho antes de repetirlo.')),
    );
  }

  /// Tras un cambio de líneas se actualiza todo lo que pudo moverse: las líneas, la orden (la
  /// valorización puede haberse anulado), el historial y la lista de atrás.
  Future<void> _refrescarTrasCambio() async {
    final auth = context.read<AuthService>();
    await Future.wait([
      _cargarLineas(),
      _cargarOrden(),
      if (auth.esAdministrativo || auth.esGerente) _cargarHistorial(),
    ]);
    widget.onCambio();
  }

  String _llavePara(String cambio) {
    if (_firmaLlave != null && _firmaLlave != cambio) _llave = nuevoUuid();
    _firmaLlave = cambio;
    return _llave;
  }

  void _renovarLlave() {
    _llave = nuevoUuid();
    _firmaLlave = null;
  }

  Future<void> _cargarHistorial() async {
    setState(() {
      _cargandoHistorial = true;
      _errorHistorial = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/${widget.orden['id']}/historial');
      if (mounted) setState(() => _historial = data);
    } catch (e) {
      if (mounted) setState(() => _errorHistorial = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargandoHistorial = false);
    }
  }

  Future<void> _cargarMecanicos() async {
    try {
      final data = await ApiClient.instance.get('/api/usuarios?rol=mecanico');
      if (mounted) setState(() => _mecanicos = data);
    } catch (_) {
      // antes se tragaba el error y el selector de mecánico quedaba vacío sin explicación
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: const Text('No se pudo cargar la lista de mecánicos.'),
          action: SnackBarAction(label: 'Reintentar', onPressed: _cargarMecanicos),
        ));
      }
    }
  }

  Future<void> _cargarLineas() async {
    try {
      final data = await ApiClient.instance.get('/api/insumos/orden/${widget.orden['id']}');
      if (mounted) setState(() => _lineas = data);
    } catch (_) {
    } finally {
      if (mounted) setState(() => _cargandoLineas = false);
    }
  }

  /// Resuelve el "?" del papel. Al cambiar una línea el backend recalcula el facturable de
  /// la OT, así que se refresca el listado para que Facturación quede consistente.
  ///
  /// Con la orden cerrada pide el motivo (lo exige el servidor y queda en el historial); con la orden
  /// facturada no se llega acá: los controles de la línea quedan apagados con el aviso de la nota de
  /// crédito, y si el servidor igual responde 409 se muestra su mensaje.
  Future<void> _resolverLinea(dynamic linea, String facturable) async {
    final actual = linea['facturable'] as String? ?? 'pendiente';
    if (facturable == actual) return;
    final ruta = '/api/insumos/orden/${widget.orden['id']}/linea/${linea['id']}';
    final cambio = 'facturable:${linea['id']}:$facturable';

    Future<void> enviar(Map<String, String> motivo) async {
      try {
        await ApiClient.instance.patch(
          ruta,
          {'facturable': facturable, ...motivo},
          cabeceras: {'Idempotency-Key': _llavePara(cambio)},
        );
        _renovarLlave();
        if (mounted) await _refrescarTrasCambio();
      } on ApiException catch (e) {
        // 409: la factura se subió mientras tanto; 400: la orden se cerró y ahora exige motivo. Se actualiza la orden
        if (e.statusCode == 409 || e.statusCode == 400) unawaited(_cargarOrden());
        rethrow;
      }
    }

    if (_cerrada) {
      await mostrarCambioConMotivo(
        context,
        titulo: 'Cambiar lo facturable',
        resumen: '${_nombreLinea(linea)}\nDe «${_etiquetaFacturable(actual)}» a «${_etiquetaFacturable(facturable)}».',
        textoAccion: 'Guardar cambio',
        alEnviar: enviar,
      );
      return;
    }
    setState(() => _cargandoAccion = true);
    try {
      await enviar(const {});
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo guardar el cambio: ${e.message}')));
    } catch (_) {
      _avisoRed();
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  String _nombreLinea(dynamic linea) => '${linea['insumo_nombre'] ?? linea['descripcion'] ?? 'Repuesto'} · ${cantidadLineaRepuesto(linea)}';

  static String _etiquetaFacturable(String valor) => switch (valor) {
        'si' => 'Se cobra',
        'no' => 'No se cobra',
        _ => 'Por decidir',
      };

  /// Anula una línea mal ingresada: queda tachada y el repuesto vuelve a su ubicación.
  /// Desde el panel se puede incluso con la OT cerrada, para corregir lo que el mecánico no alcanzó;
  /// en ese caso el servidor exige el motivo y queda en el historial.
  Future<void> _anularLinea(dynamic linea) async {
    final ruta = '/api/insumos/orden/${widget.orden['id']}/linea/${linea['id']}/anular';
    const advertencia = 'La línea queda tachada, el repuesto vuelve a su ubicación y deja de contar como gasto del equipo. '
        'No se puede deshacer.';

    Future<void> enviar(Map<String, String> motivo) async {
      try {
        await ApiClient.instance.post(ruta, {...motivo});
        if (mounted) await _refrescarTrasCambio();
      } on ApiException catch (e) {
        if (e.statusCode == 409 || e.statusCode == 400) unawaited(_cargarOrden());
        rethrow;
      }
    }

    if (_cerrada) {
      await mostrarCambioConMotivo(
        context,
        titulo: '¿Anular esta línea?',
        resumen: '${_nombreLinea(linea)}\n\n$advertencia',
        textoAccion: 'Anular línea',
        alEnviar: enviar,
      );
      return;
    }
    final confirmado = await mostrarConfirmacion(
      context,
      titulo: '¿Anular esta línea?',
      mensaje: '${_nombreLinea(linea)}\n\n$advertencia',
      textoAccion: 'Anular línea',
      peligro: true,
    );
    if (!confirmado) return;
    setState(() => _cargandoAccion = true);
    try {
      await enviar(const {});
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo anular la línea: ${e.message}')));
    } catch (_) {
      _avisoRed();
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  /// Cierra el cuadro, o en la página recarga la orden y su historial, y avisa en ambos casos.
  String? _errorRecarga;

  Future<void> _reintentarRecarga() async {
    if (await _cargarOrden() && mounted) {
      setState(() => _errorRecarga = null);
      final auth = context.read<AuthService>();
      if (auth.esAdministrativo || auth.esGerente) unawaited(_cargarHistorial());
    }
  }

  Future<void> _terminarAccion(String mensaje) async {
    if (!mounted) return;
    final mensajero = ScaffoldMessenger.of(context);
    if (widget.enPagina) {
      final recargada = await _cargarOrden();
      if (!mounted) return;
      if (!recargada) {
        // la acción se hizo pero no se pudo traer la orden al día: se muestra el error con Reintentar
        // en vez de dejar a la vista, por ejemplo, 'Asignar mecánico' en una orden ya asignada
        setState(() => _errorRecarga = 'La acción quedó hecha, pero no se pudo actualizar la orden.');
      } else if (context.read<AuthService>().esAdministrativo || context.read<AuthService>().esGerente) {
        await _cargarHistorial();
      }
    } else {
      Navigator.pop(context);
    }
    mensajero.showSnackBar(SnackBar(content: Text(mensaje)));
  }

  Future<void> _asignar() async {
    if (_mecanicoSeleccionado == null) {
      setState(() => _errorMecanico = 'Elige el mecánico al que se asigna la orden.');
      return;
    }
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/asignar', {'mecanico_id': _mecanicoSeleccionado});
      widget.onCambio();
      await _terminarAccion('Orden asignada');
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo asignar la orden: ${e.message}')));
    } catch (_) {
      _avisoRed();
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  /// Cambia el mecánico de una orden ya asignada y no finalizada. Con la orden en viaje o en trabajo
  /// pide confirmación antes, porque lo que el mecánico anterior no envió se rechaza en su teléfono.
  Future<void> _reasignar() async {
    if (reasignacionPideConfirmar(_orden['estado'])) {
      final confirmado = await mostrarConfirmacion(
        context,
        titulo: '¿Reasignar la orden?',
        mensaje: 'Lo que el mecánico anterior tenga sin enviar quedará rechazado en su teléfono.',
        textoAccion: 'Reasignar',
        peligro: true,
      );
      if (!confirmado || !mounted) return;
    }
    final reasignada = await abrirAsignarMecanico(
      context,
      Map<String, dynamic>.from(_orden),
      reasignar: true,
      mecanicoActualId: _orden['mecanico_id'],
    );
    if (!reasignada || !mounted) return;
    widget.onCambio();
    await _refrescarTrasCambio();
  }

  Future<void> _aprobarValorizacion() async {
    // "18.500" son dieciocho mil quinientos: leido con tryParse era 18,5 pesos
    final monto = parsearMonto(_valorizacionCtrl.text);
    if (monto == null || monto <= 0) {
      setState(() => _errorValorizacion = 'Escribe un monto válido, por ejemplo 249.900.');
      return;
    }
    final sinDecidir = repuestosSinDecidir(_lineas);
    if (sinDecidir > 0) {
      final seguir = await mostrarConfirmacion(
        context,
        titulo: '¿Aprobar con repuestos sin decidir?',
        mensaje: textoConfirmarValorizacion(sinDecidir),
        textoAccion: 'Aprobar igual',
      );
      if (!seguir || !mounted) return;
    }
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/valorizacion', {'valorizacion': monto});
      widget.onCambio();
      await _terminarAccion('Valorización aprobada');
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo aprobar la valorización: ${e.message}')));
    } catch (_) {
      _avisoRed();
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  final _folioCtrl = TextEditingController();

  Future<void> _subirFactura() async {
    if (_folioCtrl.text.trim().isEmpty) {
      setState(() => _errorFolio = 'Escribe el folio de la factura.');
      return;
    }
    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado == null || resultado.files.single.bytes == null) return;
    final archivo = resultado.files.single;

    setState(() => _cargandoAccion = true);
    try {
      final factura = await ApiClient.instance.postMultipart(
        '/api/ordenes-trabajo/${widget.orden['id']}/factura',
        bytes: archivo.bytes!,
        filename: archivo.name,
        fields: {'folio': _folioCtrl.text.trim()},
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Factura subida correctamente')));
        // desde ahora la orden no admite cambios de líneas: se muestra el aviso y el historial al día
        if (factura is Map) setState(() => _orden = {..._orden, 'factura_id': factura['id'], 'factura_folio': factura['folio']});
        unawaited(_cargarHistorial());
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo subir la factura: ${e.message}')));
      // 409: ya tenía su factura (subida desde otra pantalla)
      if (e.statusCode == 409) unawaited(_cargarOrden());
    } catch (_) {
      _avisoRed();
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  /// Anula una factura subida por error: el servidor la borra del registro (el PDF queda de respaldo),
  /// deja el motivo en el historial y la orden vuelve a admitir cambios. Pide el mismo motivo que los
  /// cambios de líneas. La factura real se anula en el SII con una nota de crédito.
  Future<void> _anularFactura() async {
    final facturaId = _orden['factura_id'];
    if (facturaId == null) return;
    final cambio = 'anular-factura:$facturaId';
    var yaNoEstaba = false;
    await mostrarCambioConMotivo(
      context,
      titulo: '¿Anular la factura folio $_folioFactura?',
      subtitulo: 'Se borra del registro de GOMAQ',
      resumen: 'Esto solo corrige el registro en GOMAQ. La factura también debe anularse en el SII con una '
          'nota de crédito. El PDF queda guardado como respaldo y la orden vuelve a admitir cambios.',
      textoAccion: 'Anular factura',
      alEnviar: (motivo) async {
        try {
          await ApiClient.instance.post(
            '/api/ordenes-trabajo/${widget.orden['id']}/factura/$facturaId/anular',
            {...motivo},
            cabeceras: {'Idempotency-Key': _llavePara(cambio)},
          );
          _renovarLlave();
          if (mounted) {
            setState(() => _orden = {..._orden, 'factura_id': null, 'factura_folio': null});
            await _refrescarTrasCambio();
          }
        } on ApiException catch (e) {
          if (e.statusCode == 404) {
            // la factura ya no estaba (la anuló otra persona): no hay nada que reintentar, el cuadro
            // se cierra y se actualiza la orden
            yaNoEstaba = true;
            if (mounted) await _refrescarTrasCambio();
            return;
          }
          // 400/409: el cuadro sigue abierto con el mensaje; se actualiza la orden por si cambió
          if (e.statusCode == 409 || e.statusCode == 400) unawaited(_cargarOrden());
          rethrow;
        }
      },
    );
    if (yaNoEstaba && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Esa factura ya había sido anulada por otra persona. Se actualizó la orden.')),
      );
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
    if (_lineas.isEmpty && _cargandoLineas) {
      return const Padding(
        padding: EdgeInsets.only(bottom: 16),
        child: Center(child: SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))),
      );
    }
    if (_lineas.isEmpty) {
      return const Padding(
        padding: EdgeInsets.only(bottom: 16),
        child: Text('Sin repuestos registrados', style: TextStyle(color: Colors.black54)),
      );
    }
    // con la orden facturada las líneas no se tocan: para dejar de cobrar hay que emitir una nota
    // de crédito en el SII (el servidor también lo rechaza con un 409)
    final puedeResolver = (auth.esGerente || auth.esAdministrativo) && !_facturada;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Repuestos utilizados', style: TextStyle(fontWeight: FontWeight.bold)),
        if (_facturada) ...[
          const SizedBox(height: 8),
          LineaInfo(icono: Icons.receipt_long, texto: avisoOrdenFacturada(_folioFactura!)),
          const SizedBox(height: 4),
        ],
        for (final l in _lineas)
          if (l['anulada_at'] != null)
            // tachada, como en el talonario: queda la constancia de que se anuló
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(
                '${l['insumo_nombre'] ?? l['descripcion'] ?? 'Repuesto'} · ${cantidadLineaRepuesto(l)}',
                style: const TextStyle(decoration: TextDecoration.lineThrough, color: Colors.black54),
              ),
              subtitle: const Text('Anulada', style: TextStyle(fontSize: 12, color: Colors.black54)),
            )
          else
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('${l['insumo_nombre'] ?? l['descripcion'] ?? 'Repuesto'} · ${cantidadLineaRepuesto(l)}'),
              subtitle: Text(
                Formato.clp(num.tryParse('${l['precio_unitario']}'), siVacio: 'Sin precio'),
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
                          onChanged: _cargandoAccion ? null : (v) => _resolverLinea(l, v!),
                        ),
                        IconButton(
                          tooltip: 'Anular línea',
                          icon: const Icon(Icons.remove_circle_outline, color: GomaqColors.estadoNegativo),
                          onPressed: _cargandoAccion ? null : () => _anularLinea(l),
                        ),
                      ],
                    )
                  : Text(_etiquetaFacturable(l['facturable']?.toString() ?? 'pendiente'), style: const TextStyle(fontSize: 13)),
            ),
        const Divider(height: 32),
      ],
    );
  }

  /// Línea de tiempo de la orden: qué pasó, quién y cuándo. Los eventos que viajaron por la cola
  /// offline y llegaron tarde dicen a qué hora se sincronizaron.
  Widget _seccionHistorial() {
    final Widget contenido;
    if (_cargandoHistorial) {
      contenido = const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: Center(child: CircularProgressIndicator()));
    } else if (_errorHistorial != null) {
      // el diálogo ya hace scroll: EstadoError necesita un alto fijo
      contenido = SizedBox(
        height: 240,
        child: EstadoError(titulo: 'No se pudo cargar el historial', mensaje: _errorHistorial!, onReintentar: _cargarHistorial),
      );
    } else if (_historial.isEmpty) {
      contenido = const Text('Sin eventos registrados', style: TextStyle(color: Colors.black54));
    } else {
      contenido = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [for (final e in _historial) _eventoHistorial(e as Map<String, dynamic>)],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Divider(height: 32),
        const TituloSeccion('Historial'),
        contenido,
      ],
    );
  }

  Widget _eventoHistorial(Map<String, dynamic> e) {
    const apagado = TextStyle(fontSize: 12, color: Colors.black54);
    final quien = quienHizoEventoOt(e);
    final sincronizado = textoSincronizacionOt(e);
    final detalle = [
      Formato.fechaHora(e['ocurrio_en']),
      ?quien,
      ?sincronizado,
      if (e['hora_dudosa'] == true) 'hora dudosa',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 5, right: 12),
            child: Icon(Icons.circle, size: 10, color: e['aplicado'] == false ? Colors.black38 : GomaqColors.primario),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(textoEventoOt(e), style: const TextStyle(fontSize: 14)),
                Text(detalle, style: apagado),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Una fila de dato: la etiqueta apagada a la izquierda y el valor a su lado.
  Widget _fila(String etiqueta, Widget valor) {
    const estiloEtiqueta = TextStyle(fontSize: 13, color: Colors.black54);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      // Con 170 px para la etiqueta, en un teléfono el valor quedaba en ~100 px: bajo 420 px
      // la etiqueta pasa encima del valor.
      child: LayoutBuilder(
        builder: (context, c) {
          if (c.maxWidth < 420) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [Text(etiqueta, style: estiloEtiqueta), valor],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 170, child: Text(etiqueta, style: estiloEtiqueta)),
              Expanded(child: valor),
            ],
          );
        },
      ),
    );
  }

  Widget _texto(dynamic valor, {String siVacio = '-'}) {
    final t = valor?.toString().trim() ?? '';
    return Text(t.isEmpty ? siVacio : t, style: TextStyle(fontSize: 14, color: t.isEmpty ? Colors.black54 : Colors.black87));
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final o = _orden;
    final valorizacion = o['valorizacion'];
    // bajo 600 px el campo del folio y su botón se apilan: en 375 px no caben uno al lado del otro
    final apilar = MediaQuery.sizeOf(context).width < 600;

    final cuerpo = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          _fila('Estado', Align(alignment: Alignment.centerLeft, child: EstadoChip(estado: o['estado']))),
          _fila('Cliente', _texto(o['cliente_nombre'])),
          _fila(
            'Destino',
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              children: [
                _texto(textoDestinoOt(o), siVacio: 'Sin destino'),
                if (hayDestinoOt(o))
                  TextButton(
                    onPressed: () {
                      if (!widget.enPagina) Navigator.pop(context);
                      context.go('/mapa');
                    },
                    child: const Text('Ver en el mapa'),
                  ),
              ],
            ),
          ),
          if (horaLlegadaEstimada(o) != null) _fila('Llegada estimada', _texto(horaLlegadaEstimada(o))),
          _fila('Tipo de servicio', _texto(_etiquetaTipoServicio(o['tipo_servicio']))),
          _fila('Motivo', _texto(o['motivo'])),
          // el talonario separa lo que se encontró al llegar de lo que se hizo
          _fila('Observaciones iniciales', _texto(o['diagnostico'], siVacio: 'Sin registrar')),
          _fila('Observaciones finales', _texto(o['observacion_final'], siVacio: 'Sin registrar')),
          if (o['folio_papel'] != null) _fila('OT en papel', _texto('N° ${o['folio_papel']}')),
          _fila('Facturable', _texto(o['facturable'] == true ? 'Sí' : 'No')),
          _fila('Valorización', _texto(valorizacion == null ? null : Formato.clp(num.tryParse('$valorizacion')), siVacio: 'Sin aprobar')),
          const Divider(height: 32),

          _seccionLineas(auth),

          if (auth.esAdministrativo && o['mecanico_id'] == null) ...[
            const TituloSeccion('Asignar mecánico'),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: DropdownButtonFormField<int>(
                    isExpanded: true,
                    decoration: decoracionCampo('Mecánico').copyWith(errorText: _errorMecanico),
                    items: mecanicosAsignables(_mecanicos).map<DropdownMenuItem<int>>((m) => DropdownMenuItem(value: m['id'], child: Text(m['nombre']))).toList(),
                    onChanged: (v) => setState(() {
                      _mecanicoSeleccionado = v;
                      _errorMecanico = null;
                    }),
                  ),
                ),
                const SizedBox(width: 12),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: FilledButton(onPressed: _cargandoAccion ? null : _asignar, child: const Text('Asignar')),
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],

          if (puedeReasignar(esAdministrativo: auth.esAdministrativo, orden: o)) ...[
            const TituloSeccion('Mecánico'),
            // Wrap: bajo 600 px el botón baja debajo del nombre en vez de desbordar
            Wrap(
              spacing: 16,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(textoMecanicoOrden(o), style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                OutlinedButton.icon(
                  onPressed: _cargandoAccion ? null : _reasignar,
                  icon: const Icon(Icons.swap_horiz, size: 18),
                  label: const Text('Reasignar'),
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],

          if (auth.esGerente && o['facturable'] == true && o['valorizacion'] == null && !_cerrada) ...[
            // el servidor solo valoriza una orden finalizada (si no, responde 409)
            const TituloSeccion('Aprobar valorización'),
            const Padding(
              padding: EdgeInsets.only(bottom: 20),
              child: Text('Se valoriza cuando la orden esté finalizada.', style: TextStyle(fontSize: 14, color: Colors.black87)),
            ),
          ],

          if (puedeAprobarValorizacion(esGerente: auth.esGerente, orden: o, cerrada: _cerrada)) ...[
            const TituloSeccion('Aprobar valorización'),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _valorizacionCtrl,
                    keyboardType: TextInputType.number,
                    decoration: decoracionCampo('Monto', prefijo: r'$ ', ayuda: 'En pesos, por ejemplo 249.900.').copyWith(errorText: _errorValorizacion),
                    onChanged: (_) {
                      if (_errorValorizacion != null) setState(() => _errorValorizacion = null);
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: FilledButton(onPressed: _cargandoAccion ? null : _aprobarValorizacion, child: const Text('Aprobar')),
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],

          if ((auth.esAdministrativo || auth.esGerente) && _facturada) ...[
            const TituloSeccion('Factura'),
            LineaInfo(icono: Icons.receipt_long, texto: 'Factura folio $_folioFactura cargada'),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: _cargandoAccion ? null : _anularFactura,
                icon: const Icon(Icons.cancel_outlined),
                label: const Text('Anular factura'),
              ),
            ),
          ] else if (auth.esAdministrativo && o['facturable'] == true && _cerrada) ...[
            const TituloSeccion('Factura'),
            Flex(
              direction: apilar ? Axis.vertical : Axis.horizontal,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Ajustable(
                  expandir: !apilar,
                  child: TextFormField(
                    controller: _folioCtrl,
                    decoration: decoracionCampo('Folio SII').copyWith(errorText: _errorFolio),
                    onChanged: (_) {
                      if (_errorFolio != null) setState(() => _errorFolio = null);
                    },
                  ),
                ),
                SizedBox(width: apilar ? 0 : 12, height: apilar ? 8 : 0),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: OutlinedButton.icon(
                    onPressed: _cargandoAccion ? null : _subirFactura,
                    icon: const Icon(Icons.upload_file),
                    label: const Text('Subir PDF de factura'),
                  ),
                ),
              ],
            ),
          ],

          if (auth.esAdministrativo || auth.esGerente) _seccionHistorial(),
        ],
      );
    final titulo = 'OT #${o['id']} · ${o['maquinaria_codigo'] ?? ''}';

    if (widget.enPagina && _errorRecarga != null) {
      return EstadoError(titulo: 'No se pudo actualizar la orden', mensaje: _errorRecarga!, onReintentar: _reintentarRecarga);
    }

    if (widget.enPagina) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => context.canPop() ? context.pop() : context.go('/ordenes'),
              icon: const Icon(Icons.arrow_back),
              label: const Text('Volver a las órdenes'),
            ),
          ),
          Text(titulo, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          const Text('Detalle de la orden de trabajo'),
          const SizedBox(height: 16),
          Card(child: Padding(padding: const EdgeInsets.all(16), child: cuerpo)),
        ],
      );
    }

    return CuadroDialogo(
      icono: Icons.assignment,
      titulo: titulo,
      subtitulo: 'Detalle de la orden de trabajo',
      ancho: 620,
      cuerpo: cuerpo,
      acciones: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar'))],
    );
  }
}

/// Página de detalle (/ordenes/:id): carga la orden por su id, con error y reintento.
class OrdenDetalleScreen extends StatefulWidget {
  /// null o menor que 1: el enlace no corresponde a una orden.
  final int? id;
  const OrdenDetalleScreen({super.key, required this.id});

  @override
  State<OrdenDetalleScreen> createState() => _OrdenDetalleScreenState();
}

class _OrdenDetalleScreenState extends State<OrdenDetalleScreen> {
  Map<String, dynamic>? _orden;
  String? _error;
  bool _cargando = true;
  bool _noExiste = false;

  bool get _idValido => widget.id != null && widget.id! > 0;

  @override
  void initState() {
    super.initState();
    if (_idValido) WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/${widget.id}');
      if (!mounted) return;
      setState(() => _orden = Map<String, dynamic>.from(data as Map));
    } on ApiException catch (e) {
      // 404: la orden no existe; reintentar no sirve. Los demás errores sí se pueden reintentar.
      if (mounted) setState(() => e.statusCode == 404 ? _noExiste = true : _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_idValido || _noExiste) {
      return const EstadoVacio(
        icono: Icons.search_off,
        titulo: 'No encontramos esa orden',
        mensaje: 'El enlace no corresponde a una orden. Vuelve a Órdenes y elígela de la lista.',
      );
    }
    if (_cargando && _orden == null) return const Center(child: CircularProgressIndicator());
    if (_orden == null) {
      return EstadoError(titulo: 'No se pudo abrir la orden', mensaje: _error ?? 'Intenta de nuevo.', onReintentar: _cargar);
    }
    return DetalleOrden(key: ValueKey(widget.id), orden: _orden!, onCambio: () {}, enPagina: true);
  }
}

/// Hace expandible al hijo solo cuando la fila está en horizontal (en vertical un Expanded no cabe).
class _Ajustable extends StatelessWidget {
  final bool expandir;
  final Widget child;
  const _Ajustable({required this.expandir, required this.child});

  @override
  Widget build(BuildContext context) => expandir ? Expanded(child: child) : child;
}
