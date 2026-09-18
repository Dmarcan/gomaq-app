import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/estado_chip.dart';

class ClienteSeguimientoScreen extends StatefulWidget {
  const ClienteSeguimientoScreen({super.key});

  @override
  State<ClienteSeguimientoScreen> createState() => _ClienteSeguimientoScreenState();
}

class _ClienteSeguimientoScreenState extends State<ClienteSeguimientoScreen> {
  List<dynamic> _solicitudes = [];
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
      final data = await ApiClient.instance.get('/api/solicitudes/mias');
      if (!mounted) return;
      setState(() => _solicitudes = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text('Error: $_error'));
    if (_solicitudes.isEmpty) return const Center(child: Text('No tienes solicitudes registradas'));

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _solicitudes.length,
        itemBuilder: (context, i) {
          final s = _solicitudes[i];
          return Card(
            child: ListTile(
              title: Text('${s['maquinaria_codigo']} · Solicitud #SOL-${s['id']}'),
              subtitle: Text(s['descripcion']),
              trailing: EstadoChip(estado: s['ot_estado'] ?? s['estado']),
              onTap: () => showDialog(context: context, builder: (_) => _SeguimientoDialog(solicitud: s)),
            ),
          );
        },
      ),
    );
  }
}

class _SeguimientoDialog extends StatelessWidget {
  final Map<String, dynamic> solicitud;
  const _SeguimientoDialog({required this.solicitud});

  static const _pasos = [
    'Solicitud recibida',
    'Técnico asignado',
    'En camino a terreno',
    'En reparación',
    'Finalizada',
  ];

  int _pasoActual() {
    final estado = solicitud['ot_estado'];
    if (estado == null) return 0; // solicitud creada, aun sin OT/mecanico
    switch (estado) {
      case 'asignada':
        return 1;
      case 'en_terreno':
        return 2;
      case 'en_reparacion':
        return 3;
      case 'finalizada':
        return 4;
      default:
        return 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    final paso = _pasoActual();
    final mecanico = solicitud['mecanico_nombre'];

    return AlertDialog(
      title: Text('Seguimiento de Solicitud'),
      content: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Solicitud #SOL-${solicitud['id']} · ${solicitud['maquinaria_codigo']}', style: const TextStyle(color: Colors.black54)),
            const SizedBox(height: 16),
            for (var i = 0; i < _pasos.length; i++) _pasoTimeline(i, i <= paso, i == paso),
            if (mecanico != null) ...[
              const SizedBox(height: 12),
              const Text('TÉCNICO ASIGNADO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: GomaqColors.primario.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(8)),
                child: Row(
                  children: [
                    CircleAvatar(backgroundColor: GomaqColors.accion, child: Text((mecanico as String).substring(0, 1), style: const TextStyle(color: Colors.white))),
                    const SizedBox(width: 12),
                    Text(mecanico, style: const TextStyle(fontWeight: FontWeight.bold)),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('El contacto directo por WhatsApp estará disponible cuando se active WhatsApp Business')),
                  );
                },
                child: const Text('Contactar por WhatsApp'),
              ),
            ),
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
            color: completado ? GomaqColors.primario : Colors.grey.shade400,
            size: 20,
          ),
          const SizedBox(width: 12),
          Text(
            _pasos[i],
            style: TextStyle(
              fontWeight: completado ? FontWeight.bold : FontWeight.normal,
              color: completado ? Colors.black : Colors.grey,
            ),
          ),
        ],
      ),
    );
  }
}
