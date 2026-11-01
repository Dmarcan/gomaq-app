import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_vacio.dart';

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
        _abiertos = [
          // una asistencia ya convertida aparece como su orden de trabajo, no dos veces
          for (final a in asistencias)
            if (a['orden_trabajo_id'] == null && a['estado'] == 'pendiente')
              {
                'titulo': 'Asistencia #${a['id']} · ${a['maquinaria_codigo']}',
                'detalle': a['descripcion'],
                'estado': null,
                'mecanico_nombre': null,
              },
          for (final o in ordenes)
            if (o['estado'] != 'finalizada')
              {
                'titulo': 'OT #${o['id']} · ${o['maquinaria_codigo']}',
                'detalle': o['motivo'],
                'estado': o['estado'],
                'mecanico_nombre': o['mecanico_nombre'],
              },
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
        itemCount: _abiertos.length,
        itemBuilder: (context, i) {
          final item = _abiertos[i];
          return Card(
            child: ListTile(
              title: Text(item['titulo']),
              subtitle: Text(item['detalle'] ?? ''),
              trailing: EstadoChip(estado: item['estado'] ?? 'pendiente', etiqueta: etiquetaParaCliente(item['estado'])),
              onTap: () => showDialog(context: context, builder: (_) => _SeguimientoDialog(item: item)),
            ),
          );
        },
      ),
    );
  }
}

/// Estados contados desde el lado del cliente.
String etiquetaParaCliente(String? estado) => switch (estado) {
      null => 'Recibida',
      'pendiente' => 'Recibida',
      'asignada' => 'Técnico asignado',
      'aceptada' => 'Técnico aceptó',
      'en_camino' => 'Técnico en camino',
      'en_terreno' || 'en_reparacion' => 'Trabajando en tu equipo',
      'finalizada' => 'Finalizada',
      _ => GomaqColors.etiquetaEstado(estado),
    };

/// Pasos del seguimiento tal como los ve el cliente, en orden.
const pasosParaCliente = [
  'Solicitud recibida',
  'Técnico asignado',
  'Técnico aceptó',
  'Técnico en camino',
  'Trabajando en tu equipo',
  'Finalizada',
];

/// Índice en [pasosParaCliente] de un estado de la orden. En terreno y en reparación son un
/// solo paso para el cliente; una asistencia sin orden (estado nulo) es la solicitud recibida.
int pasoParaCliente(String? estado) => switch (estado) {
      'asignada' => 1,
      'aceptada' => 2,
      'en_camino' => 3,
      'en_terreno' || 'en_reparacion' => 4,
      'finalizada' => 5,
      _ => 0,
    };

class _SeguimientoDialog extends StatelessWidget {
  final Map<String, dynamic> item;
  const _SeguimientoDialog({required this.item});

  int _pasoActual() => pasoParaCliente(item['estado'] as String?);

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
              for (var i = 0; i < pasosParaCliente.length; i++) _pasoTimeline(i, i <= paso, i == paso),
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
                      Text(mecanico, style: const TextStyle(fontWeight: FontWeight.bold)),
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

  Widget _pasoTimeline(int i, bool completado, bool actual) {
    final estado = actual ? 'actual' : (completado ? 'completado' : 'pendiente');
    return Semantics(
      label: 'Paso ${i + 1} de ${pasosParaCliente.length}, $estado: ${pasosParaCliente[i]}',
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
                pasosParaCliente[i],
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
