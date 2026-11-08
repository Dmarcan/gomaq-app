import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';
import '../utils/ubicacion.dart';

/// "Usar mi ubicación actual": marca la ubicación de la empresa con un toque. Es opcional y
/// complementa la dirección escrita, que sigue siendo la referencia para el técnico.
class CampoUbicacion extends StatefulWidget {
  final Coordenada? valor;
  final ValueChanged<Coordenada?> onChanged;

  /// Se puede reemplazar en las pruebas; por defecto pide el GPS o el navegador.
  final ObtenerUbicacion obtener;

  const CampoUbicacion({
    super.key,
    required this.valor,
    required this.onChanged,
    this.obtener = obtenerUbicacionActual,
  });

  @override
  State<CampoUbicacion> createState() => _CampoUbicacionState();
}

class _CampoUbicacionState extends State<CampoUbicacion> {
  bool _buscando = false;
  String? _error;

  Future<void> _usarUbicacionActual() async {
    setState(() {
      _buscando = true;
      _error = null;
    });
    try {
      final c = await widget.obtener();
      if (!mounted) return;
      widget.onChanged(c);
    } on UbicacionException catch (e) {
      if (mounted) setState(() => _error = mensajeUbicacion(e.motivo));
    } catch (_) {
      if (mounted) setState(() => _error = mensajeUbicacion(MotivoUbicacion.otro));
    } finally {
      if (mounted) setState(() => _buscando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final valor = widget.valor;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (valor == null)
          OutlinedButton.icon(
            onPressed: _buscando ? null : _usarUbicacionActual,
            icon: _buscando
                ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.my_location),
            label: Text(_buscando ? 'Buscando tu ubicación…' : 'Usar mi ubicación actual'),
          )
        else
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            children: [
              const Icon(Icons.check_circle, color: GomaqColors.estadoPositivo, size: 20),
              const Text('Ubicación marcada'),
              TextButton(
                onPressed: _buscando ? null : _usarUbicacionActual,
                child: const Text('Actualizar'),
              ),
              TextButton(
                onPressed: _buscando ? null : () => widget.onChanged(null),
                child: const Text('Quitar'),
              ),
            ],
          ),
        const SizedBox(height: 4),
        const Text(
          'Opcional. Sirve para calcular la hora de llegada del técnico. Debes estar en la empresa al marcarla.',
          style: TextStyle(color: Colors.black54, fontSize: 12),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Semantics(
              liveRegion: true,
              child: Text(_error!, style: const TextStyle(color: GomaqColors.estadoNegativo, fontSize: 13)),
            ),
          ),
      ],
    );
  }
}
