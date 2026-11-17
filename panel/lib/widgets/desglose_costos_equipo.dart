import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../theme/gomaq_theme.dart';
import '../utils/formato.dart';
import 'linea_tiempo_equipo.dart';

/// Respaldo de las tres cifras de la pestaña Costos: cada línea de repuesto con su orden de trabajo y
/// cada factura con su folio, ambas con el cliente y con enlace.
///
/// No calcula nada: muestra lo que entrega `GET /api/rentabilidad/maquinaria/:id` (`lineas` y
/// `facturas`), de modo que los totales siguen saliendo de un solo lugar, el servidor.
class DesgloseCostosEquipo extends StatelessWidget {
  final int maquinariaId;
  final Map<String, dynamic> rentabilidad;

  /// Abre la orden de trabajo. Por defecto navega a `/ordenes/:id`.
  final void Function(int ordenId)? onAbrirOrden;

  /// Abre la pestaña Documentos del equipo (la factura no tiene pantalla propia).
  final VoidCallback? onIrADocumentos;

  const DesgloseCostosEquipo({super.key, required this.maquinariaId, required this.rentabilidad, this.onAbrirOrden, this.onIrADocumentos});

  void _orden(BuildContext context, int id) {
    if (onAbrirOrden != null) {
      onAbrirOrden!(id);
    } else {
      context.push('/ordenes/$id');
    }
  }

  void _documentos(BuildContext context) {
    if (onIrADocumentos != null) {
      onIrADocumentos!();
    } else {
      context.go('/flota/$maquinariaId?pestana=documentos');
    }
  }

  static String _cliente(Map<String, dynamic> f) {
    final nombre = f['cliente_nombre'];
    return nombre == null || '$nombre'.trim().isEmpty ? 'Sin cliente' : '$nombre';
  }

  @override
  Widget build(BuildContext context) {
    final lineas = [for (final l in (rentabilidad['lineas'] as List? ?? const [])) Map<String, dynamic>.from(l as Map)];
    final facturas = [for (final f in (rentabilidad['facturas'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 24),
        Semantics(
          header: true,
          child: const Text('Repuestos que componen el gasto', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 10),
        if (lineas.isEmpty)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('No hay repuestos usados en el período.', style: TextStyle(color: Colors.black87)),
          )
        else
          for (final l in lineas) _lineaRepuesto(context, l),
        const SizedBox(height: 18),
        Semantics(
          header: true,
          child: const Text('Facturas que componen lo facturado', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 10),
        if (facturas.isEmpty)
          const Text('No hay facturas en el período.', style: TextStyle(color: Colors.black87))
        else
          for (final f in facturas) _lineaFactura(context, f),
      ],
    );
  }

  Widget _lineaRepuesto(BuildContext context, Map<String, dynamic> l) {
    final nombre = '${l['insumo_nombre'] ?? l['descripcion'] ?? 'Repuesto'}';
    final cantidad = l['cantidad'];
    final precio = l['precio_unitario'];
    final ot = l['orden_trabajo_id'] as int?;
    final cliente = _cliente(l);
    final String monto;
    if (cantidad is num && precio is num) {
      monto = '${Formato.medida(cantidad, '').trim()} x ${Formato.clp(precio)} = ${Formato.clp(cantidad * precio)}';
    } else {
      monto = 'Sin precio cargado: no suma al gasto';
    }
    final detalle = ['Orden de trabajo #$ot', 'Cliente: $cliente', monto];
    return FilaEnlaceEquipo(
      icono: Icons.build_outlined,
      color: colorDeCliente(l['cliente_id'] as int?),
      titulo: nombre,
      fecha: Formato.fecha(l['created_at']),
      detalle: detalle,
      semantica: '$nombre, ${Formato.fecha(l['created_at'])}. ${detalle.join('. ')}. Abre la orden de trabajo',
      onTap: ot == null ? () {} : () => _orden(context, ot),
    );
  }

  Widget _lineaFactura(BuildContext context, Map<String, dynamic> f) {
    final folio = f['folio'] == null ? 'Factura' : 'Factura ${f['folio']}';
    final monto = f['monto'];
    final traslado = f['monto_traslado'];
    final cliente = _cliente(f);
    final detalle = [
      'Cliente: $cliente',
      monto is num ? 'Monto: ${Formato.clp(monto)}' : 'Sin monto registrado',
      if (traslado is num && traslado > 0) 'Traslado: ${Formato.clp(traslado)} (no cuenta como ingreso del equipo)',
    ];
    return FilaEnlaceEquipo(
      icono: Icons.receipt_long_outlined,
      color: f['cliente_id'] == null ? GomaqColors.grisApagado : colorDeCliente(f['cliente_id'] as int?),
      titulo: folio,
      fecha: Formato.fecha(f['created_at']),
      detalle: detalle,
      semantica: '$folio, ${Formato.fecha(f['created_at'])}. ${detalle.join('. ')}. Abre los documentos del equipo',
      onTap: () => _documentos(context),
    );
  }
}
