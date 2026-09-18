import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Etiqueta de estado (equipo, orden, solicitud, notificación).
///
/// Antes cada pantalla armaba su propio Chip con el valor de la base tal cual ("en_terreno") y
/// el color de estado como texto, que en ámbar no llegaba al contraste mínimo. Ahora el nombre
/// es legible y el texto usa la variante oscura del color.
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
