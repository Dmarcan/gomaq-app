import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/formato.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/pestanas.dart';
import '../../widgets/selector_plazo_pago.dart';

/// Tiene URL propia (/clientes/:id). Bajo 600 px las tres secciones se apilan; desde 600 px van en
/// pestañas. Cada fila es un enlace: el equipo abre `/flota/:id` y la orden `/ordenes/:id`. No muestra
/// documentos: se abren desde el perfil del equipo o la orden.
class HistorialDeClienteScreen extends StatefulWidget {
  final int? id;

  /// Para pruebas: reemplaza la llamada al servidor.
  final Future<Map<String, dynamic>> Function(int id)? cargar;

  const HistorialDeClienteScreen({super.key, required this.id, this.cargar});

  @override
  State<HistorialDeClienteScreen> createState() => _HistorialDeClienteScreenState();
}

class _HistorialDeClienteScreenState extends State<HistorialDeClienteScreen> {
  Map<String, dynamic>? _datos;
  bool _cargando = true;
  String? _error;
  String _pestana = 'arriendos';

  int? get _id => (widget.id != null && widget.id! > 0) ? widget.id : null;

  @override
  void initState() {
    super.initState();
    if (_id == null) {
      _cargando = false;
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
    }
  }

  Future<void> _cargar() async {
    final id = _id;
    if (id == null) return;
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final datos = widget.cargar != null
          ? await widget.cargar!(id)
          : Map<String, dynamic>.from(await ApiClient.instance.get('/api/clientes/$id/historial') as Map);
      if (mounted) setState(() => _datos = datos);
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException && e.statusCode == 404 ? 'No encontramos a ese cliente.' : mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  List<dynamic> _lista(String clave) => (_datos?[clave] as List?) ?? const [];

  @override
  Widget build(BuildContext context) {
    if (_id == null) {
      return const EstadoVacio(
        icono: Icons.search_off,
        titulo: 'No encontramos ese cliente',
        mensaje: 'El enlace no corresponde a un cliente. Vuelve a Clientes y elígelo de la lista.',
      );
    }
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return EstadoError(titulo: 'No se pudo cargar el historial', mensaje: _error!, onReintentar: _cargar);
    }
    final datos = _datos!;
    final cliente = Map<String, dynamic>.from(datos['cliente'] as Map);
    final hayMas = Map<String, dynamic>.from((datos['hay_mas'] as Map?) ?? const {});

    final secciones = <String, Widget>{
      'arriendos': _Seccion(
        titulo: 'Arriendos',
        vacio: 'Este cliente aún no tiene arriendos registrados.',
        hayMas: hayMas['arriendos'] == true,
        filas: [for (final a in _lista('arriendos')) _filaArriendo(context, Map<String, dynamic>.from(a as Map))],
      ),
      'facturas': _Seccion(
        titulo: 'Facturas',
        vacio: 'Este cliente aún no tiene facturas.',
        hayMas: hayMas['facturas'] == true,
        filas: [for (final f in _lista('facturas')) _filaFactura(context, Map<String, dynamic>.from(f as Map))],
      ),
      'ordenes': _Seccion(
        titulo: 'Órdenes de trabajo',
        vacio: 'Este cliente aún no tiene órdenes de trabajo.',
        hayMas: hayMas['ordenes'] == true,
        filas: [for (final o in _lista('ordenes')) _filaOrden(context, Map<String, dynamic>.from(o as Map))],
      ),
    };

    return LayoutBuilder(builder: (context, caja) {
      final apilado = caja.maxWidth < 600;
      return RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () => context.go('/clientes'),
                icon: const Icon(Icons.arrow_back),
                label: const Text('Clientes'),
              ),
            ),
            _Cabecera(cliente: cliente, resumen: Map<String, dynamic>.from((datos['resumen'] as Map?) ?? const {})),
            const SizedBox(height: 16),
            if (apilado)
              for (final s in secciones.values) ...[s, const SizedBox(height: 16)]
            else ...[
              Pestanas(
                items: [
                  (id: 'arriendos', etiqueta: 'Arriendos', cantidad: _lista('arriendos').length),
                  (id: 'facturas', etiqueta: 'Facturas', cantidad: _lista('facturas').length),
                  (id: 'ordenes', etiqueta: 'Órdenes', cantidad: _lista('ordenes').length),
                ],
                seleccionada: _pestana,
                onSeleccionar: (p) => setState(() => _pestana = p),
              ),
              const SizedBox(height: 12),
              secciones[_pestana]!,
            ],
          ],
        ),
      );
    });
  }

  Widget _filaArriendo(BuildContext context, Map<String, dynamic> a) {
    final enCurso = a['en_curso'] == true;
    final desde = Formato.fecha(a['inicio_cobro']);
    final texto = enCurso ? 'Desde $desde, sigue en curso' : 'Del $desde al ${Formato.fecha(a['fin'])}';
    final codigo = '${a['maquinaria_codigo'] ?? 'Equipo'}';
    return _Fila(
      icono: enCurso ? Icons.play_circle_outline : Icons.check_circle_outline,
      titulo: codigo,
      detalle: a['falta_recepcion'] == true ? '$texto. Falta registrar la recepción.' : texto,
      etiquetaEstado: enCurso ? 'En curso' : 'Terminado',
      colorEstado: enCurso ? GomaqColors.estadoPositivo : GomaqColors.grisApagado,
      semantica: 'Arriendo del equipo $codigo. $texto. Abre el perfil del equipo.',
      onTap: a['maquinaria_id'] == null ? null : () => context.push('/flota/${a['maquinaria_id']}'),
    );
  }

  Widget _filaFactura(BuildContext context, Map<String, dynamic> f) {
    final folio = '${f['folio'] ?? ''}';
    final monto = Formato.clp(f['monto'] is num ? f['monto'] as num : num.tryParse('${f['monto']}'));
    final partes = <String>[
      if (f['fecha_emision'] != null) 'Emitida ${Formato.fecha(f['fecha_emision'])}',
      if (f['periodo_desde'] != null && f['periodo_hasta'] != null)
        'Período ${Formato.fecha(f['periodo_desde'])} al ${Formato.fecha(f['periodo_hasta'])}',
      if (f['maquinaria_codigo'] != null) 'Equipo ${f['maquinaria_codigo']}',
      if (f['orden_trabajo_id'] != null) 'Orden ${f['orden_trabajo_id']}',
    ];
    final detalle = partes.isEmpty ? 'Sin más datos' : partes.join(' | ');
    // la factura abre su orden si es de reparación, o el equipo si es de arriendo
    final VoidCallback? onTap = f['orden_trabajo_id'] != null
        ? () => context.push('/ordenes/${f['orden_trabajo_id']}')
        : f['maquinaria_id'] != null
            ? () => context.push('/flota/${f['maquinaria_id']}')
            : null;
    return _Fila(
      icono: Icons.receipt_long_outlined,
      titulo: 'Factura $folio',
      trailing: monto,
      detalle: detalle,
      semantica: 'Factura $folio por $monto. $detalle.',
      onTap: onTap,
    );
  }

  Widget _filaOrden(BuildContext context, Map<String, dynamic> o) {
    final estado = '${o['estado']}';
    final codigo = '${o['maquinaria_codigo'] ?? 'Equipo'}';
    final detalle = 'Creada ${Formato.fecha(o['fecha_creacion'])}'
        '${o['fecha_cierre'] != null ? ', cerrada ${Formato.fecha(o['fecha_cierre'])}' : ''}';
    return _Fila(
      icono: Icons.assignment_outlined,
      titulo: 'Orden ${o['id']}, $codigo',
      detalle: detalle,
      etiquetaEstado: GomaqColors.etiquetaEstado(estado),
      colorEstado: GomaqColors.textoEstado(estado),
      semantica: 'Orden ${o['id']} del equipo $codigo, ${GomaqColors.etiquetaEstado(estado)}. $detalle. Abre la orden.',
      onTap: () => context.push('/ordenes/${o['id']}'),
    );
  }
}

class _Cabecera extends StatelessWidget {
  final Map<String, dynamic> cliente;
  final Map<String, dynamic> resumen;
  const _Cabecera({required this.cliente, required this.resumen});

  @override
  Widget build(BuildContext context) {
    final plazo = cliente['plazo_pago_dias'] is int ? cliente['plazo_pago_dias'] as int : int.tryParse('${cliente['plazo_pago_dias'] ?? ''}');
    final datos = <(IconData, String)>[
      if (cliente['rut'] != null) (Icons.badge_outlined, 'RUT ${cliente['rut']}'),
      if (cliente['giro'] != null) (Icons.business_center_outlined, 'Giro: ${cliente['giro']}'),
      if (cliente['direccion'] != null) (Icons.place_outlined, '${cliente['direccion']}'),
      if (cliente['email'] != null) (Icons.mail_outline, '${cliente['email']}'),
      if (cliente['telefono'] != null) (Icons.phone_outlined, '${cliente['telefono']}'),
    ];
    final total = resumen['total_facturado'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: Text('${cliente['nombre']}', style: Theme.of(context).textTheme.titleLarge),
            ),
            const SizedBox(height: 8),
            for (final d in datos)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ExcludeSemantics(child: Icon(d.$1, size: 18, color: Colors.grey.shade700)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(d.$2)),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  Icon(
                    plazo == null ? Icons.warning_amber_rounded : Icons.event_available_outlined,
                    size: 18,
                    color: plazo == null ? GomaqColors.advertenciaFuerte : Colors.grey.shade700,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      plazo == null ? 'Sin plazo de pago' : 'Plazo de pago: ${etiquetaPlazoPago(plazo)}',
                      style: plazo == null ? const TextStyle(color: GomaqColors.advertenciaFuerte, fontWeight: FontWeight.w600) : null,
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 24),
            Wrap(
              spacing: 24,
              runSpacing: 12,
              children: [
                _Cifra(valor: '${resumen['equipos_arrendados_hoy'] ?? 0}', etiqueta: 'Equipos arrendados hoy'),
                _Cifra(valor: '${resumen['arriendos'] ?? 0}', etiqueta: 'Arriendos'),
                _Cifra(valor: '${resumen['facturas'] ?? 0}', etiqueta: 'Facturas'),
                _Cifra(valor: Formato.clp(total is num ? total : num.tryParse('$total')), etiqueta: 'Total facturado'),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Cifra extends StatelessWidget {
  final String valor;
  final String etiqueta;
  const _Cifra({required this.valor, required this.etiqueta});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '$etiqueta: $valor',
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(valor, style: Theme.of(context).textTheme.titleLarge),
          Text(etiqueta, style: TextStyle(color: Colors.grey.shade700, fontSize: 12)),
        ],
      ),
    );
  }
}

class _Seccion extends StatelessWidget {
  final String titulo;
  final String vacio;
  final bool hayMas;
  final List<Widget> filas;
  const _Seccion({required this.titulo, required this.vacio, required this.hayMas, required this.filas});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(header: true, child: Text('$titulo (${filas.length}${hayMas ? '+' : ''})', style: Theme.of(context).textTheme.titleMedium)),
        const SizedBox(height: 8),
        if (filas.isEmpty)
          Text(vacio, style: TextStyle(color: Colors.grey.shade700))
        else
          Card(margin: EdgeInsets.zero, child: Column(children: filas)),
        if (hayMas)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('Se muestran los 200 más recientes.', style: TextStyle(color: Colors.grey.shade700, fontSize: 12)),
          ),
      ],
    );
  }
}

class _Fila extends StatelessWidget {
  final IconData icono;
  final String titulo;
  final String detalle;
  final String? trailing;
  final String? etiquetaEstado;
  final Color? colorEstado;
  final String semantica;
  final VoidCallback? onTap;
  const _Fila({
    required this.icono,
    required this.titulo,
    required this.detalle,
    required this.semantica,
    this.trailing,
    this.etiquetaEstado,
    this.colorEstado,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: onTap != null,
      label: semantica,
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Icon(icono, color: Colors.grey.shade700),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(titulo, style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(detalle, style: TextStyle(color: Colors.grey.shade700, fontSize: 13)),
                      // el estado va siempre como texto (y con punto), nunca solo en color
                      if (etiquetaEstado != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text('Estado: $etiquetaEstado', style: TextStyle(color: colorEstado, fontWeight: FontWeight.w700, fontSize: 12)),
                        ),
                    ],
                  ),
                ),
                if (trailing != null) Text(trailing!, style: const TextStyle(fontWeight: FontWeight.w600)),
                if (onTap != null) Icon(Icons.chevron_right, color: Colors.grey.shade600),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
