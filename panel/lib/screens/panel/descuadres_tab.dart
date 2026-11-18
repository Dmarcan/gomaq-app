import 'package:flutter/material.dart';
import '../../utils/unidades.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/formato.dart';
import '../../utils/motivo_cambio.dart' show nuevoUuid;
import '../../utils/numeros.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';

/// Un descuadre aparece cuando un mecánico registró el consumo de un repuesto que el sistema no
/// tenía en su furgón. El administrativo lo cuadra de dos maneras: traspasando desde la bodega lo
/// que faltaba cargar, o registrando el conteo físico (queda un ajuste con su motivo). El gerente
/// solo mira. Cada caso muestra desde cuándo está negativo y permite ver sus movimientos.
class DescuadresTab extends StatelessWidget {
  final List<dynamic> descuadres;
  final List<dynamic> catalogo;
  final List<dynamic> motivos;
  final bool puedeEscribir;
  final Future<void> Function() onRecargar;

  /// Si falló la carga de los descuadres o de los motivos: se muestra con Reintentar en vez de una lista vacía.
  final String? error;

  const DescuadresTab({
    super.key,
    required this.descuadres,
    required this.catalogo,
    required this.motivos,
    required this.puedeEscribir,
    required this.onRecargar,
    this.error,
  });

  double _stockBodega(Map<String, dynamic> d) {
    for (final i in catalogo) {
      if (i['id'] == d['insumo_id']) return parsearNumero('${i['stock_bodega'] ?? 0}') ?? 0;
    }
    return 0;
  }

  String _lugar(Map<String, dynamic> d) {
    final partes = <String>['${d['ubicacion_nombre']}'];
    if (d['patente'] != null) partes.add('${d['patente']}');
    if (d['mecanico_nombre'] != null) partes.add('${d['mecanico_nombre']}');
    return partes.join(' · ');
  }

  Future<void> _traspasar(BuildContext context, Map<String, dynamic> d) async {
    final unidad = '${d['unidad_medida']}';
    final falta = -(parsearNumero('${d['cantidad']}') ?? 0);
    final bodega = _stockBodega(d);
    final cantidadCtrl = TextEditingController(text: formatoCampo(falta));
    final llave = nuevoUuid();
    final hecho = await mostrarFormulario(
      context,
      icono: Icons.local_shipping_outlined,
      titulo: 'Traspasar desde bodega',
      subtitulo: '${d['insumo_nombre']} a ${_lugar(d)}',
      textoAccion: 'Traspasar',
      ancho: 440,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          LineaInfo(
            icono: Icons.inventory,
            texto: 'Falta ${medidaConUnidad(falta, unidad)} en el furgón. En bodega hay ${medidaConUnidad(bodega, unidad)}.',
          ),
          separadorCampos,
          TextFormField(
            controller: cantidadCtrl,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: decoracionCampo('Cantidad a traspasar', obligatorio: true, sufijo: unidad),
            validator: numeroPositivo('Escribe una cantidad mayor a cero.'),
          ),
          if (bodega < falta) ...[
            separadorCampos,
            const LineaInfo(
              icono: Icons.info_outline,
              texto: 'La bodega no alcanza. Si el repuesto ya se compró, registra primero el ingreso, '
                  'o cuadra el caso con un conteo.',
            ),
          ],
        ],
      ),
      alGuardar: () => ApiClient.instance.post('/api/insumos/transferencia', {
        'insumo_id': d['insumo_id'],
        'cantidad': parsearNumero(cantidadCtrl.text),
        'ubicacion_destino_id': d['ubicacion_id'],
        'motivo_codigo': 'traspaso_no_registrado',
        'uuid_cliente': llave,
      }),
    );
    cantidadCtrl.dispose();
    if (hecho && context.mounted) {
      await onRecargar();
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Traspaso registrado')));
      }
    }
  }

  Future<void> _contar(BuildContext context, Map<String, dynamic> d) async {
    final unidad = '${d['unidad_medida']}';
    final cantidadCtrl = TextEditingController();
    final notaCtrl = TextEditingController();
    final llave = nuevoUuid();
    String? motivo;
    String? obsoleto;
    final hecho = await mostrarFormulario(
      context,
      icono: Icons.fact_check_outlined,
      titulo: 'Registrar conteo',
      subtitulo: '${d['insumo_nombre']} en ${_lugar(d)}',
      textoAccion: 'Registrar conteo',
      ancho: 460,
      contenido: (context, redibujar) {
        final contada = parsearNumero(cantidadCtrl.text);
        final actual = parsearNumero('${d['cantidad']}') ?? 0;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            LineaInfo(
              icono: Icons.warning_amber_rounded,
              texto: 'Cuenta el furgón solo cuando el mecánico haya sincronizado todo (cola en 0): '
                  'un consumo hecho sin señal que llegue después se descontaría de nuevo.',
            ),
            if (d['ubicacion_tipo'] == 'furgon') ...[
              const SizedBox(height: 8),
              const LineaInfo(
                icono: Icons.local_shipping_outlined,
                texto: 'Si la pieza salió de la bodega, usa Traspasar: un conteo no descuenta la bodega.',
              ),
            ],
            separadorCampos,
            TextFormField(
              controller: cantidadCtrl,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              onChanged: (_) => redibujar(() {}),
              decoration: decoracionCampo(
                'Cantidad contada',
                obligatorio: true,
                sufijo: unidad,
                ayuda: 'El sistema tiene ${medidaConUnidad(actual, unidad)}.',
              ),
              validator: (v) => (parsearNumero(v ?? '') ?? -1) < 0 ? 'Escribe lo que contaste (0 o más).' : null,
            ),
            if (contada != null && contada >= 0) ...[
              const SizedBox(height: 8),
              Text(
                'Diferencia que se registrará: ${contada - actual >= 0 ? '+' : ''}${formatoCampo(contada - actual)} ${unidadSegunCantidad(contada - actual, unidad)}',
                style: const TextStyle(fontSize: 13),
              ),
            ],
            separadorCampos,
            DropdownButtonFormField<String>(
              initialValue: motivo,
              isExpanded: true,
              decoration: decoracionCampo('Motivo', obligatorio: true),
              items: [
                for (final m in motivos) DropdownMenuItem(value: '${m['codigo']}', child: Text('${m['nombre']}')),
              ],
              onChanged: (v) => motivo = v,
              validator: (v) => v == null ? 'Elige el motivo del ajuste.' : null,
            ),
            separadorCampos,
            TextFormField(
              controller: notaCtrl,
              maxLength: 500,
              maxLines: 2,
              decoration: decoracionCampo('Nota (opcional)'),
            ),
          ],
        );
      },
      alGuardar: () async {
        try {
          await ApiClient.instance.post('/api/insumos/ajuste', {
            'ubicacion_id': d['ubicacion_id'],
            'insumo_id': d['insumo_id'],
            'cantidad_contada': parsearNumero(cantidadCtrl.text),
            // lo que se vio al abrir el conteo: si el stock cambió mientras tanto, el servidor responde 409
            'cantidad_esperada': parsearNumero('${d['cantidad']}'),
            'motivo_codigo': motivo,
            if (notaCtrl.text.trim().isNotEmpty) 'nota': notaCtrl.text.trim(),
            'uuid_cliente': llave,
          });
        } on ApiException catch (e) {
          // el stock cambió mientras se contaba: el cuadro se cierra y la lista se recarga, para
          // volver a contar sobre el dato nuevo (seguir con el cuadro abierto no serviría)
          if (e.statusCode != 409) rethrow;
          obsoleto = e.message;
        }
      },
    );
    cantidadCtrl.dispose();
    notaCtrl.dispose();
    if (!context.mounted) return;
    if (obsoleto != null) {
      await onRecargar();
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$obsoleto Vuelve a contar.')));
      }
    } else if (hecho) {
      await onRecargar();
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Conteo registrado')));
      }
    }
  }

  Future<void> _verMovimientos(BuildContext context, Map<String, dynamic> d) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _MovimientosDelCaso(descuadre: d, lugar: _lugar(d)),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (error != null) {
      return EstadoError(titulo: 'No se pudieron cargar los descuadres', mensaje: error!, onReintentar: onRecargar);
    }
    if (descuadres.isEmpty) {
      return const EstadoVacio(
        icono: Icons.fact_check_outlined,
        titulo: 'Sin descuadres',
        mensaje: 'Aquí aparecen las ubicaciones con un repuesto en negativo: por ejemplo, cuando un mecánico '
            'instaló una pieza que el sistema no tenía en su furgón.',
      );
    }
    return RefreshIndicator(
      onRefresh: onRecargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: descuadres.length,
        itemBuilder: (context, i) {
          final d = Map<String, dynamic>.from(descuadres[i] as Map);
          final unidad = '${d['unidad_medida']}';
          final desde = d['negativo_desde'];
          final dias = d['dias'];
          final esFurgon = d['ubicacion_tipo'] == 'furgon';
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Text(
                          '${d['insumo_nombre']}',
                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        medidaConUnidad(parsearNumero('${d['cantidad']}'), unidad),
                        style: const TextStyle(color: GomaqColors.estadoNegativo, fontWeight: FontWeight.w700, fontSize: 15),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(_lugar(d)),
                  const SizedBox(height: 2),
                  Text(
                    d['sin_origen'] == true
                        ? 'Ningún movimiento explica este saldo negativo'
                        : desde != null
                            ? 'Negativo desde ${Formato.fecha(desde)}'
                                '${dias is num ? (dias == 0 ? ' (hoy)' : ' ($dias ${dias == 1 ? 'día' : 'días'})') : ''}'
                            : 'Sin movimientos registrados',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  if (d['ultimo_movimiento_at'] != null)
                    Text('Último movimiento: ${Formato.fechaHora(d['ultimo_movimiento_at'])}', style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      if (puedeEscribir && esFurgon)
                        OutlinedButton.icon(
                          onPressed: () => _traspasar(context, d),
                          icon: const Icon(Icons.local_shipping_outlined),
                          label: const Text('Traspasar'),
                        ),
                      if (puedeEscribir)
                        OutlinedButton.icon(
                          onPressed: () => _contar(context, d),
                          icon: const Icon(Icons.fact_check_outlined),
                          label: const Text('Registrar conteo'),
                        ),
                      TextButton.icon(
                        onPressed: () => _verMovimientos(context, d),
                        icon: const Icon(Icons.history),
                        label: const Text('Ver movimientos'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Texto de una cantidad en un campo: sin decimales de más ("3", "1,5").
String formatoCampo(double n) {
  final redondeado = (n * 100).round() / 100;
  return redondeado == redondeado.roundToDouble()
      ? redondeado.toStringAsFixed(0)
      : redondeado.toString().replaceAll('.', ',');
}

class _MovimientosDelCaso extends StatefulWidget {
  final Map<String, dynamic> descuadre;
  final String lugar;
  const _MovimientosDelCaso({required this.descuadre, required this.lugar});

  @override
  State<_MovimientosDelCaso> createState() => _MovimientosDelCasoState();
}

class _MovimientosDelCasoState extends State<_MovimientosDelCaso> {
  List<dynamic> _items = [];
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final d = widget.descuadre;
      final r = await ApiClient.instance.get('/api/insumos/movimientos?ubicacion_id=${d['ubicacion_id']}&insumo_id=${d['insumo_id']}');
      if (!mounted) return;
      setState(() => _items = r['items'] ?? []);
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  String _titulo(Map<String, dynamic> m) {
    final ubicacion = widget.descuadre['ubicacion_id'];
    final cantidad = medidaConUnidad(parsearNumero('${m['cantidad']}'), '${m['unidad_medida'] ?? ''}');
    switch ('${m['tipo']}') {
      case 'ingreso':
        return 'Ingreso de $cantidad';
      case 'ajuste':
        return m['ubicacion_destino_id'] == ubicacion ? 'Ajuste de conteo: +$cantidad' : 'Ajuste de conteo: -$cantidad';
      default:
        if (m['ubicacion_destino_id'] == ubicacion) return 'Carga desde bodega: +$cantidad';
        return m['orden_trabajo_id'] != null ? 'Consumo en OT #${m['orden_trabajo_id']}: -$cantidad' : 'Salida de $cantidad';
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.75),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Movimientos de ${widget.descuadre['insumo_nombre']}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
              Text(widget.lugar, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 8),
              if (_cargando)
                const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))
              else if (_error != null)
                EstadoError(titulo: 'No se pudieron cargar los movimientos', mensaje: _error!, onReintentar: _cargar)
              else if (_items.isEmpty)
                const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('Sin movimientos registrados')))
              else
                Flexible(
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: _items.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, i) {
                      final m = Map<String, dynamic>.from(_items[i] as Map);
                      final motivo = m['motivo_codigo'];
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(
                          _titulo(m),
                          style: m['anulada_at'] != null ? const TextStyle(decoration: TextDecoration.lineThrough) : null,
                        ),
                        subtitle: Text(
                          '${m['anulada_at'] != null ? 'Anulada · ' : ''}'
                          '${motivo != null ? '${_nombreMotivo('$motivo')} · ' : ''}'
                          '${m['usuario_nombre'] ?? '-'} · ${Formato.fechaHora(m['created_at'])}'
                          '${m['descripcion'] != null && m['tipo'] == 'ajuste' ? '\n${m['descripcion']}' : ''}',
                        ),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  String _nombreMotivo(String codigo) => const {
        'traspaso_no_registrado': 'Traspaso no registrado',
        'compra_no_ingresada': 'Compra no ingresada',
        'error_registro': 'Error de registro',
        'diferencia_conteo': 'Diferencia de conteo',
        'danio_merma': 'Daño o merma',
        'perdida_robo': 'Pérdida o robo',
      }[codigo] ?? codigo;
}
