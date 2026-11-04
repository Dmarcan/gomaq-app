import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/seguimiento_cliente.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_vacio.dart';

// Se reexportan para que las pantallas y pruebas que ya importaban estas funciones desde aquí sigan igual.
export '../../utils/seguimiento_cliente.dart';

/// Lo que el cliente tiene abierto con GOMAQ: sus asistencias todavía sin orden de trabajo y
/// todas sus órdenes en curso.
///
/// Antes solo mostraba las asistencias pedidas desde el portal: una OT creada por el
/// administrativo (la mayoría) no aparecía, y el cliente veía "No tienes solicitudes" con dos
/// trabajos en curso sobre sus equipos.
class ClienteSeguimientoScreen extends StatefulWidget {
  const ClienteSeguimientoScreen({super.key});

  @override
  State<ClienteSeguimientoScreen> createState() => _ClienteSeguimientoScreenState();
}

class _ClienteSeguimientoScreenState extends State<ClienteSeguimientoScreen> {
  List<Map<String, dynamic>> _abiertos = [];
  DateTime? _actualizado;
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
      final asistencias = (await ApiClient.instance.get('/api/solicitudes/mias') as List).cast<Map<String, dynamic>>();
      final ordenes = (await ApiClient.instance.get('/api/ordenes-trabajo/mias') as List).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() {
        _actualizado = DateTime.now();
        _abiertos = [
          // una asistencia ya convertida aparece como su orden de trabajo, no dos veces
          for (final a in asistencias)
            if (a['orden_trabajo_id'] == null && a['estado'] == 'pendiente')
              {
                'titulo': tituloAsistencia(a),
                'detalle': a['descripcion'],
                'estado': null,
                'mecanico_nombre': null,
                'fecha_creacion': a['fecha_creacion'] ?? a['created_at'],
              },
          for (final o in ordenes)
            if (o['estado'] != 'finalizada') {...o, 'titulo': tituloOrden(o), 'detalle': o['motivo']},
        ];
      });
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
        child: EstadoError(titulo: 'No se pudo cargar el seguimiento', mensaje: _error!, onReintentar: _cargar),
      );
    }
    if (_abiertos.isEmpty) {
      return EstadoRefrescable(
        onRefresh: _cargar,
        child: const EstadoVacio(
          icono: Icons.timeline,
          titulo: 'No tienes asistencias abiertas',
          mensaje: 'Para reportar una falla o pedir una mantención, toca «Solicitar asistencia» '
              'en uno de tus equipos.',
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _abiertos.length + 1,
        itemBuilder: (context, i) {
          if (i == 0) {
            // cuándo se leyó por última vez: el seguimiento cambia solo por fuera de la pantalla
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                'Actualizado a las ${horaCorta(_actualizado) ?? '--:--'}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            );
          }
          final item = _abiertos[i - 1];
          final lineas = _lineasResumen(item);
          return Card(
            child: ListTile(
              isThreeLine: lineas.length >= 2,
              title: Text(item['titulo']),
              subtitle: _resumen(lineas),
              trailing: EstadoChip(estado: item['estado'] ?? 'pendiente', etiqueta: etiquetaParaCliente(item['estado'])),
              onTap: () => showDialog(context: context, builder: (_) => _SeguimientoDialog(item: item)),
            ),
          );
        },
      ),
    );
  }

  /// Paso actual con su hora, lo que viene y quién atiende.
  List<String> _lineasResumen(Map<String, dynamic> item) {
    final proximo = proximoPaso(item['estado'] as String?);
    final tecnico = item['mecanico_nombre'] as String?;
    final vehiculo = descripcionVehiculo(item);
    final detalle = item['detalle'] as String?;
    return [
      resumenPaso(item),
      if (proximo != null) 'Siguiente: $proximo',
      if (tecnico != null && tecnico.isNotEmpty) (vehiculo == null ? 'Técnico: $tecnico' : 'Técnico: $tecnico · $vehiculo'),
      if (detalle != null && detalle.isNotEmpty) detalle,
    ];
  }

  Widget _resumen(List<String> lineas) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [for (final l in lineas) Text(l, maxLines: 2, overflow: TextOverflow.ellipsis)],
      );
}

class _SeguimientoDialog extends StatelessWidget {
  final Map<String, dynamic> item;
  const _SeguimientoDialog({required this.item});

  // null si el estado no está en la lista: el diálogo no marca ningún paso
  int? _pasoActual() => pasoParaCliente(item['estado'] as String?);

  @override
  Widget build(BuildContext context) {
    final paso = _pasoActual();
    final mecanico = item['mecanico_nombre'] as String?;

    return CuadroDialogo(
      icono: Icons.timeline,
      titulo: 'Seguimiento',
      subtitulo: '${item['titulo']}',
      ancho: 440,
      cuerpo: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < pasosParaCliente.length; i++) _pasoTimeline(i, paso != null && i <= paso, i == paso, horaConDia(horaDePaso(item, i))),
              if (mecanico != null && mecanico.isNotEmpty) ...[
                const SizedBox(height: 12),
                const TituloSeccion('Técnico asignado'),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: GomaqColors.primario.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      CircleAvatar(
                        backgroundColor: GomaqColors.accion,
                        child: Text(mecanico.substring(0, 1), style: const TextStyle(color: Colors.white)),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(mecanico, style: const TextStyle(fontWeight: FontWeight.bold)),
                            if (descripcionVehiculo(item) != null) Text(descripcionVehiculo(item)!),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              // El botón "Contactar por WhatsApp" que había acá no hacía nada: solo avisaba que
              // aún no estaba disponible. Vuelve cuando se active WhatsApp Business.
            ],
      ),
      acciones: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
      ],
    );
  }

  Widget _pasoTimeline(int i, bool completado, bool actual, String? hora) {
    final estado = actual ? 'actual' : (completado ? 'completado' : 'pendiente');
    return Semantics(
      label: 'Paso ${i + 1} de ${pasosParaCliente.length}, $estado: ${pasosParaCliente[i]}${completado && hora != null ? ', $hora' : ''}',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              completado ? (actual ? Icons.radio_button_checked : Icons.check_circle) : Icons.circle_outlined,
              // estadoNeutro llega a 4,9:1 sobre blanco; el gris 500 anterior daba cerca de 2,7:1
              color: completado ? GomaqColors.accion : GomaqColors.estadoNeutro,
              size: 20,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                completado && hora != null ? '${pasosParaCliente[i]} · $hora' : pasosParaCliente[i],
                style: TextStyle(
                  fontWeight: completado ? FontWeight.bold : FontWeight.normal,
                  color: completado ? Colors.black87 : Colors.grey.shade700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
