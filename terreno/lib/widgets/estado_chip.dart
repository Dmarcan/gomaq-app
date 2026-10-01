import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

class EstadoChip extends StatelessWidget {
  final String estado;
  const EstadoChip({super.key, required this.estado});

  @override
  Widget build(BuildContext context) {
    final color = GomaqColors.colorEstado(estado);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      decoration: BoxDecoration(
        color: GomaqColors.fondoChip(estado),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        GomaqColors.etiquetaEstado(estado).toUpperCase(),
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.bold,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}
