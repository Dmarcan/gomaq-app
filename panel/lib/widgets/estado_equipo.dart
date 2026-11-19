import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Estado de un equipo (operativa / en mantención / fuera de servicio) con ícono y texto.
///
/// El color solo no alcanza para distinguir estados: quien no ve bien el verde del ámbar, o
/// imprime la pantalla en blanco y negro, pierde la diferencia. El ícono y el nombre la
/// mantienen, y en Flota este es el dato que más se escanea.
class EstadoEquipo extends StatelessWidget {
  final String? estado;

  /// Versión más grande para la cabecera del perfil.
  final bool grande;

  const EstadoEquipo({super.key, required this.estado, this.grande = false});

  static IconData icono(String? estado) => switch (estado) {
        'operativa' => Icons.check_circle_outline,
        'en_mantencion' => Icons.build_outlined,
        'parcialmente_operativa' => Icons.warning_amber_outlined,
        'asistencia_pedida' => Icons.support_agent,
        'fuera_de_servicio' => Icons.error_outline,
        _ => Icons.help_outline,
      };

  @override
  Widget build(BuildContext context) {
    final valor = estado ?? 'pendiente';
    final color = GomaqColors.textoEstado(valor);
    final tamanio = grande ? 14.0 : 12.0;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: grande ? 12 : 8, vertical: grande ? 6 : 3),
      decoration: BoxDecoration(
        color: GomaqColors.fondoChip(valor),
        borderRadius: BorderRadius.circular(99),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ExcludeSemantics(child: Icon(icono(estado), size: tamanio + 3, color: color)),
          const SizedBox(width: 5),
          Text(
            GomaqColors.etiquetaEstado(valor),
            style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: tamanio),
          ),
        ],
      ),
    );
  }
}
