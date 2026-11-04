import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import 'dialogos.dart';
import 'estado_vacio.dart';

/// Fotos de una orden de trabajo (antes y después) para la vista previa de la factura.
///
/// Las URLs vienen firmadas por una hora: si una vence mientras el cuadro sigue abierto, la miniatura
/// muestra un ícono en vez de romperse y el botón Recargar pide URLs nuevas. Las fotos NO se adjuntan
/// al correo (todavía no hay proveedor de correo con adjuntos); aquí solo las ve el administrativo.
class FotosOrden extends StatefulWidget {
  final Object ordenId;

  /// Cómo se piden las fotos; por defecto el servidor. Se puede reemplazar en las pruebas.
  final Future<List<dynamic>> Function()? cargador;
  const FotosOrden({super.key, required this.ordenId, this.cargador});

  @override
  State<FotosOrden> createState() => _FotosOrdenState();
}

class _FotosOrdenState extends State<FotosOrden> {
  List<Map<String, dynamic>> _fotos = [];
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
      final data = widget.cargador != null
          ? await widget.cargador!()
          : await ApiClient.instance.get('/api/ordenes-trabajo/${widget.ordenId}/evidencia') as List;
      if (!mounted) return;
      setState(() => _fotos = [for (final f in data) Map<String, dynamic>.from(f as Map)]);
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  void _ampliar(Map<String, dynamic> foto) {
    final url = foto['url'] as String?;
    if (url == null) return;
    showDialog<void>(
      context: context,
      builder: (_) => Dialog(
        child: InteractiveViewer(
          child: Image.network(
            url,
            fit: BoxFit.contain,
            errorBuilder: (_, _, _) => const Padding(
              padding: EdgeInsets.all(24),
              child: Text('La foto no se pudo cargar. Cierra y usa Recargar.'),
            ),
          ),
        ),
      ),
    );
  }

  Widget _miniatura(Map<String, dynamic> foto) {
    final url = foto['url'] as String?;
    return InkWell(
      onTap: url == null ? null : () => _ampliar(foto),
      child: Container(
        width: 72,
        height: 72,
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey.shade300),
          borderRadius: BorderRadius.circular(8),
        ),
        clipBehavior: Clip.antiAlias,
        child: url == null
            ? const Icon(Icons.broken_image_outlined, color: GomaqColors.estadoNeutro)
            : Image.network(
                url,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const Tooltip(
                  message: 'La foto no se pudo cargar (el enlace puede haber vencido)',
                  child: Icon(Icons.broken_image_outlined, color: GomaqColors.estadoNeutro),
                ),
              ),
      ),
    );
  }

  Widget _grupo(String titulo, List<Map<String, dynamic>> fotos) {
    if (fotos.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(titulo, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          const SizedBox(height: 6),
          Wrap(spacing: 8, runSpacing: 8, children: [for (final f in fotos) _miniatura(f)]),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final antes = [for (final f in _fotos) if (f['tipo'] != 'despues') f];
    final despues = [for (final f in _fotos) if (f['tipo'] == 'despues') f];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Expanded(child: TituloSeccion('Fotos de la orden')),
            if (!_cargando) TextButton.icon(onPressed: _cargar, icon: const Icon(Icons.refresh, size: 16), label: const Text('Recargar')),
          ],
        ),
        if (_cargando)
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator())
        else if (_error != null)
          Text('No se pudieron cargar las fotos: $_error', style: const TextStyle(color: GomaqColors.estadoNegativo))
        else if (_fotos.isEmpty)
          const Text('Esta orden no tiene fotos.')
        else ...[
          _grupo('Antes', antes),
          _grupo('Después', despues),
        ],
        const SizedBox(height: 4),
        const Text('Las fotos no se adjuntan al correo.', style: TextStyle(fontSize: 12, color: Colors.black54)),
      ],
    );
  }
}
