import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../utils/enlaces.dart';
import '../../utils/formato.dart';
import '../../utils/seguimiento_cliente.dart';
import '../../widgets/estado_vacio.dart';
import 'cliente_orden_detalle_screen.dart';

/// Trabajos terminados sobre los equipos del cliente; los que siguen en curso estan en Seguimiento.
class ClienteHistorialScreen extends StatefulWidget {
  /// Cómo se piden las órdenes y el detalle de una; por defecto el servidor. Se pueden reemplazar en las pruebas.
  final Future<List<dynamic>> Function()? cargador;
  final Future<Map<String, dynamic>> Function(int ordenId)? cargadorDetalle;
  const ClienteHistorialScreen({super.key, this.cargador, this.cargadorDetalle});

  @override
  State<ClienteHistorialScreen> createState() => _ClienteHistorialScreenState();
}

class _ClienteHistorialScreenState extends State<ClienteHistorialScreen> {
  List<dynamic> _ordenes = [];
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
      final data = widget.cargador != null
          ? await widget.cargador!()
          : await ApiClient.instance.get('/api/ordenes-trabajo/mias') as List;
      if (!mounted) return;
      setState(() => _ordenes = data.where((o) => o['estado'] == 'finalizada').toList());
    } catch (e) {
      // no solo ApiException: sin red ClienteApi deja pasar el error de socket o de timeout
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return EstadoRefrescable(
        onRefresh: _cargar,
        child: EstadoError(titulo: 'No se pudo cargar el historial', mensaje: _error!, onReintentar: _cargar),
      );
    }
    if (_ordenes.isEmpty) {
      return EstadoRefrescable(
        onRefresh: _cargar,
        child: const EstadoVacio(
          imagen: gGomaqGris,
          titulo: 'Aún no hay trabajos terminados',
          mensaje: 'Cuando GOMAQ cierre un trabajo sobre tus equipos, aparecerá aquí con su factura.',
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _ordenes.length,
        itemBuilder: (context, i) {
          final o = _ordenes[i];
          final facturaUrl = o['factura_url'] as String?;
          final comprobanteUrl = o['comprobante_url'] as String?;
          final cobro = etiquetaCobro(o['cobro'] as String?);
          final tieneMotivo = (o['motivo'] as String?)?.isNotEmpty ?? false;
          final tieneDiagnostico = (o['diagnostico'] as String?)?.isNotEmpty ?? false;
          return Card(
            child: ListTile(
              // abre el detalle con Navigator: el router devuelve al cliente a /portal con cualquier otra ruta
              onTap: o['id'] is int
                  ? () => Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => ClienteOrdenDetalleScreen(
                          ordenId: o['id'] as int,
                          cargador: widget.cargadorDetalle == null ? null : () => widget.cargadorDetalle!(o['id'] as int),
                        ),
                      ))
                  : null,
              isThreeLine: (tieneMotivo ? 1 : 0) + 1 + (tieneDiagnostico ? 1 : 0) + (explicacionCobro(o['cobro'] as String?) != null ? 1 : 0) >= 2,
              title: Text(tituloOrden(o)),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (tieneMotivo) Text(o['motivo']),
                  Text('Terminado el ${Formato.fecha(o['fecha_cierre'] ?? o['fecha_creacion'])}${cobro != null ? ' · $cobro' : ''}'),
                  if (explicacionCobro(o['cobro'] as String?) case final explicacion?) Text(explicacion),
                  if (tieneDiagnostico)
                    Text('Diagnóstico: ${o['diagnostico']}', maxLines: 3, overflow: TextOverflow.ellipsis),
                  if (comprobanteUrl != null)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: () => abrirEnlace(comprobanteUrl),
                        icon: const Icon(Icons.receipt_outlined, size: 18),
                        label: const Text('Ver comprobante de pago'),
                      ),
                    ),
                ],
              ),
              trailing: facturaUrl != null
                  ? TextButton.icon(
                      // la API ya entrega una URL firmada completa: no se le antepone la direccion
                      // del servidor
                      onPressed: () => abrirEnlace(facturaUrl),
                      icon: const Icon(Icons.picture_as_pdf, size: 18),
                      label: const Text('Factura'),
                    )
                  : null,
            ),
          );
        },
      ),
    );
  }
}
