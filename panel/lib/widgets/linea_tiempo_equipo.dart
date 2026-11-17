import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import '../utils/formato.dart';
import 'estado_vacio.dart';

/// Carga la línea de tiempo (para pruebas: por defecto pide `GET /api/maquinarias/:id/linea-tiempo`).
typedef CargarLineaTiempo = Future<Map<String, dynamic>> Function();

/// Línea de tiempo de un equipo: guías, órdenes de trabajo, facturas y lecturas de horómetro, del
/// evento más reciente al más antiguo, agrupados en tramos de un mismo cliente.
///
/// Cada evento es una fila clicable y operable con teclado: una orden lleva a su pantalla
/// (`/ordenes/:id`); una guía o una factura no tienen pantalla propia y llevan a la pestaña
/// Documentos del equipo, donde se abre el archivo. Muestra montos por evento y no totales: el total
/// del equipo vive en la pestaña Costos.
class LineaTiempoEquipo extends StatefulWidget {
  final int maquinariaId;
  final CargarLineaTiempo? cargar;

  /// Abre la orden de trabajo. Por defecto navega a `/ordenes/:id`.
  final void Function(int ordenId)? onAbrirOrden;

  /// Abre la pestaña Documentos del equipo. Por defecto navega a `/flota/:id?pestana=documentos`.
  final VoidCallback? onIrADocumentos;

  const LineaTiempoEquipo({super.key, required this.maquinariaId, this.cargar, this.onAbrirOrden, this.onIrADocumentos});

  @override
  State<LineaTiempoEquipo> createState() => _LineaTiempoEquipoState();
}

class _LineaTiempoEquipoState extends State<LineaTiempoEquipo> {
  Map<String, dynamic>? _datos;
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final datos = widget.cargar != null
          ? await widget.cargar!()
          : Map<String, dynamic>.from(await ApiClient.instance.get('/api/maquinarias/${widget.maquinariaId}/linea-tiempo') as Map);
      if (mounted) setState(() => _datos = datos);
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  void _abrirOrden(int id) {
    if (widget.onAbrirOrden != null) {
      widget.onAbrirOrden!(id);
    } else {
      context.push('/ordenes/$id');
    }
  }

  void _irADocumentos() {
    if (widget.onIrADocumentos != null) {
      widget.onIrADocumentos!();
    } else {
      context.go('/flota/${widget.maquinariaId}?pestana=documentos');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) {
      return Semantics(
        liveRegion: true,
        label: 'Cargando la línea de tiempo',
        child: const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
      );
    }
    if (_error != null) {
      return EstadoError(titulo: 'No se pudo cargar la línea de tiempo', mensaje: _error!, onReintentar: _cargar);
    }
    final tramos = [for (final t in (_datos?['tramos'] as List? ?? const [])) Map<String, dynamic>.from(t as Map)];
    if (tramos.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 32),
        child: Center(child: Text('Este equipo todavía no tiene movimientos registrados.', textAlign: TextAlign.center)),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final t in tramos) _Tramo(tramo: t, onOrden: _abrirOrden, onDocumentos: _irADocumentos),
        if (_datos?['hay_mas'] == true)
          Semantics(
            liveRegion: true,
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Se muestran los ${_datos?['tope'] ?? 500} eventos más recientes. Los anteriores no aparecen aquí.',
                style: const TextStyle(fontSize: 12, color: GomaqColors.advertenciaFuerte),
              ),
            ),
          ),
      ],
    );
  }
}

/// Color de borde de cada cliente: ayuda a ver el cambio de cliente de un vistazo, pero el nombre
/// va siempre escrito en el encabezado del tramo (el cliente nunca se distingue solo por color).
Color colorDeCliente(int? clienteId) {
  const paleta = [
    Color(0xFFC2410C),
    Color(0xFF1F6B8A),
    Color(0xFF5B4A9A),
    Color(0xFF1F6B38),
    Color(0xFF8A5A00),
    Color(0xFF8A2D5E),
  ];
  if (clienteId == null) return GomaqColors.grisApagado;
  return paleta[clienteId % paleta.length];
}

class _Tramo extends StatelessWidget {
  final Map<String, dynamic> tramo;
  final void Function(int ordenId) onOrden;
  final VoidCallback onDocumentos;
  const _Tramo({required this.tramo, required this.onOrden, required this.onDocumentos});

  @override
  Widget build(BuildContext context) {
    final clienteId = tramo['cliente_id'] as int?;
    final nombre = clienteId == null ? 'En bodega o sin cliente' : '${tramo['cliente_nombre'] ?? 'Cliente $clienteId'}';
    final desde = Formato.fecha(tramo['desde']);
    final hasta = Formato.fecha(tramo['hasta']);
    final rango = desde == hasta ? desde : '$desde al $hasta';
    final eventos = [for (final e in (tramo['eventos'] as List)) Map<String, dynamic>.from(e as Map)];
    final color = colorDeCliente(clienteId);
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            label: '$nombre, $rango, ${eventos.length} ${eventos.length == 1 ? 'evento' : 'eventos'}',
            excludeSemantics: true,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.08),
                border: Border(left: BorderSide(color: color, width: 4)),
              ),
              child: Wrap(
                spacing: 12,
                runSpacing: 2,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Icon(clienteId == null ? Icons.warehouse_outlined : Icons.business_outlined, size: 18, color: color),
                  Text(nombre, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                  Text(rango, style: const TextStyle(fontSize: 12, color: Colors.black87)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          for (final e in eventos) _FilaEvento(evento: e, color: color, onOrden: onOrden, onDocumentos: onDocumentos),
        ],
      ),
    );
  }
}

class _FilaEvento extends StatelessWidget {
  final Map<String, dynamic> evento;
  final Color color;
  final void Function(int ordenId) onOrden;
  final VoidCallback onDocumentos;
  const _FilaEvento({required this.evento, required this.color, required this.onOrden, required this.onDocumentos});

  static const _titulos = {
    'guia_despacho': 'Guía de despacho',
    'guia_recepcion': 'Guía de recepción',
    'orden_trabajo': 'Orden de trabajo',
    'factura': 'Factura',
    'lectura_horometro': 'Lectura de horómetro',
  };

  static const _iconos = {
    'guia_despacho': Icons.local_shipping_outlined,
    'guia_recepcion': Icons.assignment_return_outlined,
    'orden_trabajo': Icons.build_outlined,
    'factura': Icons.receipt_long_outlined,
    'lectura_horometro': Icons.speed_outlined,
  };

  static String _estado(dynamic e) {
    final t = '$e'.replaceAll('_', ' ');
    return t.isEmpty ? t : '${t[0].toUpperCase()}${t.substring(1)}';
  }

  static const _tiposServicio = {
    'preventivo': 'Preventivo',
    'reparacion': 'Reparación',
    'garantia_full_mantencion': 'Garantía full mantención',
    'correctivo': 'Correctivo',
    'bateria_cargador': 'Batería y cargador',
    'administrativo': 'Administrativo',
  };

  String get _titulo {
    final tipo = '${evento['tipo']}';
    final base = _titulos[tipo] ?? 'Evento';
    return switch (tipo) {
      'orden_trabajo' => '$base #${evento['id']}',
      'factura' => evento['folio'] == null ? base : '$base ${evento['folio']}',
      _ => base,
    };
  }

  /// Líneas de detalle, ya en texto: el estado nunca va solo en color.
  List<String> get _detalle {
    final tipo = '${evento['tipo']}';
    final l = <String>[];
    switch (tipo) {
      case 'guia_despacho':
        if (evento['inicio_cobro'] != null) l.add('Inicio del arriendo: ${Formato.fecha(evento['inicio_cobro'])}');
      case 'guia_recepcion':
        if (evento['fin_cobro'] != null) l.add('Término del arriendo: ${Formato.fecha(evento['fin_cobro'])}');
      case 'orden_trabajo':
        final motivo = '${evento['motivo'] ?? ''}'.trim();
        if (motivo.isNotEmpty) l.add(motivo);
        l.add([
          'Estado: ${_estado(evento['estado'])}',
          if (evento['tipo_servicio'] != null) _tiposServicio['${evento['tipo_servicio']}'] ?? '${evento['tipo_servicio']}',
        ].join(' · '));
        final costo = evento['costo_repuestos'];
        if (costo is num && costo > 0) l.add('Repuestos: ${Formato.clp(costo)}');
        final sinPrecio = evento['lineas_sin_precio'];
        if (sinPrecio is num && sinPrecio > 0) {
          l.add('$sinPrecio línea${sinPrecio == 1 ? '' : 's'} de repuesto sin precio cargado');
        }
      case 'factura':
        final monto = evento['monto'];
        l.add(monto is num ? 'Monto: ${Formato.clp(monto)}' : 'Sin monto registrado');
        final traslado = evento['monto_traslado'];
        if (traslado is num && traslado > 0) l.add('Traslado: ${Formato.clp(traslado)}');
        final ingreso = evento['ingreso'];
        if (ingreso is num && traslado is num && traslado > 0) l.add('Arriendo: ${Formato.clp(ingreso)}');
        if (evento['periodo_desde'] != null && evento['periodo_hasta'] != null) {
          l.add('Período ${Formato.fecha(evento['periodo_desde'])} al ${Formato.fecha(evento['periodo_hasta'])}');
        }
      case 'lectura_horometro':
        final valor = evento['valor'];
        final partes = <String>[if (valor is num) Formato.medida(valor, 'h')];
        final horas = evento['horas_desde_anterior'];
        if (horas is num) partes.add('${Formato.medida(horas, 'h')} desde la lectura anterior');
        if (partes.isNotEmpty) l.add(partes.join(' · '));
    }
    if (evento['fallido'] == true) l.add('Intento fallido');
    if (evento['sin_documento'] == true) l.add('Sin documento adjunto');
    return l;
  }

  @override
  Widget build(BuildContext context) {
    final tipo = '${evento['tipo']}';
    final esOrden = tipo == 'orden_trabajo';
    final detalle = _detalle;
    final fecha = Formato.fecha(evento['fecha']);
    final mantencion = evento['es_mantencion'] == true;
    final destino = esOrden ? 'Abre la orden de trabajo' : 'Abre los documentos del equipo';
    return FilaEnlaceEquipo(
      icono: _iconos[tipo] ?? Icons.event_outlined,
      color: color,
      titulo: _titulo,
      fecha: fecha,
      detalle: detalle,
      etiqueta: mantencion ? 'Mantención' : null,
      semantica: '$_titulo, $fecha${mantencion ? ', mantención' : ''}. ${detalle.join('. ')}. $destino',
      onTap: esOrden ? () => onOrden(evento['id'] as int) : onDocumentos,
    );
  }
}

/// Fila clicable de un evento o de una línea de costo: toda la fila se toca, se enfoca con Tab y se
/// activa con Enter o Espacio, y el lector de pantalla la lee como un botón con su texto completo.
class FilaEnlaceEquipo extends StatelessWidget {
  final IconData icono;
  final Color color;
  final String titulo;
  final String? fecha;
  final List<String> detalle;

  /// Marca de texto con ícono (por ejemplo "Mantención"), para no depender del color.
  final String? etiqueta;
  final String semantica;
  final VoidCallback onTap;

  const FilaEnlaceEquipo({
    super.key,
    required this.icono,
    required this.color,
    required this.titulo,
    this.fecha,
    this.detalle = const [],
    this.etiqueta,
    required this.semantica,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6, left: 4),
      child: Semantics(
        button: true,
        label: semantica,
        excludeSemantics: true,
        child: Material(
          color: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
            side: BorderSide(color: Colors.grey.shade300),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            focusColor: GomaqColors.primario.withValues(alpha: 0.18),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(icono, size: 20, color: color),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 10,
                          runSpacing: 2,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(titulo, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                            if (fecha != null) Text(fecha!, style: const TextStyle(fontSize: 12, color: Colors.black87)),
                            if (etiqueta != null)
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.handyman_outlined, size: 14, color: GomaqColors.advertenciaFuerte),
                                  const SizedBox(width: 3),
                                  Text(etiqueta!, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: GomaqColors.advertenciaFuerte)),
                                ],
                              ),
                          ],
                        ),
                        for (final d in detalle)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(d, style: const TextStyle(fontSize: 12, color: Colors.black87)),
                          ),
                      ],
                    ),
                  ),
                  const Padding(
                    padding: EdgeInsets.only(left: 8, top: 2),
                    child: Icon(Icons.chevron_right, size: 18, color: GomaqColors.grisApagado),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
