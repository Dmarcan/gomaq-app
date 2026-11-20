import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Titulo de una seccion de la orden. Si `completa` no es null, agrega al final un "Listo" (verde) o un
/// "Falta" (amarillo): se usa en las secciones que el mecanico tiene que llenar, y se omite cuando la seccion
/// es opcional o la orden ya esta cerrada. Ademas del color lleva texto e icono, para que no dependa solo del color.
class TituloSeccion extends StatelessWidget {
  final IconData icono;
  final String texto;
  final bool? completa;
  const TituloSeccion(this.icono, this.texto, {super.key, this.completa});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icono, size: 18, color: GomaqColors.primario),
        const SizedBox(width: 8),
        Expanded(child: Text(texto, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
        if (completa != null) ...[
          Icon(
            completa! ? Icons.check_circle : Icons.pending_outlined,
            size: 16,
            color: completa! ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia,
          ),
          const SizedBox(width: 4),
          Text(
            completa! ? 'Listo' : 'Falta',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: completa! ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia,
            ),
          ),
        ],
      ],
    );
  }
}

/// Tarjeta de seccion que se tine segun este completa (verde) o falte (amarillo); sin `completa`, una
/// tarjeta normal.
class TarjetaSeccion extends StatelessWidget {
  final Widget child;
  final bool? completa;
  const TarjetaSeccion({super.key, required this.child, this.completa});

  @override
  Widget build(BuildContext context) {
    if (completa == null) return Card(child: child);
    final color = completa! ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia;
    return Card(
      color: color.withValues(alpha: 0.08),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: color.withValues(alpha: 0.6)),
      ),
      child: child,
    );
  }
}
