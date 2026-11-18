import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Etiqueta de estado (equipo, orden, solicitud, notificacion). Muestra un nombre legible y no el
/// valor de la base ("en_terreno"); el texto usa la variante oscura del color porque el ambar claro
/// no llega al contraste minimo.
class EstadoChip extends StatelessWidget {
  final String? estado;

  /// Texto a mostrar en vez del nombre genérico del estado (el portal del cliente, por
  /// ejemplo, habla de "Técnico en terreno").
  final String? etiqueta;

  const EstadoChip({super.key, required this.estado, this.etiqueta});

  @override
  Widget build(BuildContext context) {
    final valor = estado ?? 'pendiente';
    return Chip(
      label: Text(etiqueta ?? GomaqColors.etiquetaEstado(valor)),
      backgroundColor: GomaqColors.fondoChip(valor),
      labelStyle: TextStyle(color: GomaqColors.textoEstado(valor), fontWeight: FontWeight.w600),
    );
  }
}
