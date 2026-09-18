import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/estado_chip.dart';
import '../widgets/estado_vacio.dart';

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
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text('No se pudo cargar el seguimiento: $_error'));
    if (_abiertos.isEmpty) {
      return const EstadoVacio(
        icono: Icons.timeline,
        titulo: 'No tienes asistencias abiertas',
        mensaje: 'Para reportar una falla o pedir una mantención, toca «Solicitar asistencia» '
            'en uno de tus equipos.',
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
      'en_terreno' => 'Técnico en terreno',
      'en_reparacion' => 'En reparación',
      'finalizada' => 'Finalizada',
      _ => GomaqColors.etiquetaEstado(estado),
    };

class _SeguimientoDialog extends StatelessWidget {
  final Map<String, dynamic> item;
  const _SeguimientoDialog({required this.item});

  static const _pasos = [
    'Asistencia recibida',
    'Técnico asignado',
    'Técnico en terreno',
    'En reparación',
    'Finalizada',
  ];

  int _pasoActual() => switch (item['estado']) {
        'asignada' => 1,
        'en_terreno' => 2,
        'en_reparacion' => 3,
        'finalizada' => 4,
        _ => 0,
      };

  @override
  Widget build(BuildContext context) {
    final paso = _pasoActual();
    final mecanico = item['mecanico_nombre'] as String?;

    return AlertDialog(
      title: const Text('Seguimiento'),
      content: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(item['titulo'], style: TextStyle(color: Colors.grey.shade700)),
              const SizedBox(height: 16),
              for (var i = 0; i < _pasos.length; i++) _pasoTimeline(i, i <= paso, i == paso),
              if (mecanico != null && mecanico.isNotEmpty) ...[
                const SizedBox(height: 12),
                const Text('TÉCNICO ASIGNADO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
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
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
      ],
    );
  }

  Widget _pasoTimeline(int i, bool completado, bool actual) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            completado ? (actual ? Icons.radio_button_checked : Icons.check_circle) : Icons.circle_outlined,
            color: completado ? GomaqColors.accion : Colors.grey.shade500,
            size: 20,
          ),
          const SizedBox(width: 12),
          Text(
            _pasos[i],
            style: TextStyle(
              fontWeight: completado ? FontWeight.bold : FontWeight.normal,
              color: completado ? Colors.black87 : Colors.grey.shade700,
            ),
          ),
        ],
      ),
    );
  }
}
