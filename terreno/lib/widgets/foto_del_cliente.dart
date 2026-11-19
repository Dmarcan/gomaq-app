import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

/// Foto que el cliente adjuntó al pedir la asistencia. Se pide al servidor cada vez que se abre la orden
/// (la URL firmada dura una hora, no sirve guardarla) y solo con señal: sin red o sin foto no se muestra nada,
/// y el resto de la orden sigue igual. No pasa por la cola ni por la base local.
class FotoDelCliente extends StatefulWidget {
  final int ordenId;
  const FotoDelCliente({super.key, required this.ordenId});

  @override
  State<FotoDelCliente> createState() => _FotoDelClienteState();
}

class _FotoDelClienteState extends State<FotoDelCliente> {
  String? _url;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    // una orden creada sin señal tiene id negativo hasta sincronizar: no nació de una asistencia
    if (widget.ordenId <= 0) return;
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/${widget.ordenId}/foto-solicitud');
      final url = data is Map ? data['url'] : null;
      if (mounted && url is String && url.isNotEmpty) setState(() => _url = url);
    } catch (_) {
      // sin foto (404), sin señal o sin permiso: la orden se ve igual
    }
  }

  void _ampliar() {
    showDialog<void>(
      context: context,
      builder: (_) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(8),
        child: Stack(
          children: [
            InteractiveViewer(child: Image.network(_url!, fit: BoxFit.contain)),
            Positioned(
              top: 0,
              right: 0,
              child: IconButton(
                tooltip: 'Cerrar',
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.pop(context),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final url = _url;
    if (url == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Foto del cliente', style: TextStyle(color: GomaqColors.textoSecundario, fontSize: 13)),
          const SizedBox(height: 6),
          Semantics(
            button: true,
            label: 'Foto que adjuntó el cliente. Toca para ampliar',
            child: InkWell(
              onTap: _ampliar,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.network(
                  url,
                  height: 160,
                  width: double.infinity,
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => const SizedBox.shrink(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
