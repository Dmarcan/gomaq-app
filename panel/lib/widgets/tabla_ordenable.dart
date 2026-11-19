import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Una columna de una tabla del panel. `orden` es el nombre que entiende el servidor (null = no
/// ordenable); `minAncho` la oculta cuando el panel está angosto, en vez de apretar todas.
typedef ColumnaTabla = ({String id, String titulo, int flex, String? orden, double minAncho});

const estiloEncabezadoTabla = TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.black54);

/// Fila de encabezados de una tabla con orden del lado del servidor. Las columnas con `orden`
/// se pueden tocar (lleva la flecha de la dirección) y avisan con `alOrdenar`.
class EncabezadoTablaOrdenable extends StatelessWidget {
  final List<ColumnaTabla> columnas;
  final String? ordenActual;
  final bool ascendente;
  final ValueChanged<String> alOrdenar;

  /// Margen horizontal de toda la fila (la tabla de flota va con sangría; la de rentabilidad, no).
  final EdgeInsetsGeometry margen;

  /// Columnas de cifras: el título se alinea a la derecha, junto a ellas.
  final bool Function(ColumnaTabla) alinearDerecha;

  const EncabezadoTablaOrdenable({
    super.key,
    required this.columnas,
    required this.ordenActual,
    required this.ascendente,
    required this.alOrdenar,
    this.margen = EdgeInsets.zero,
    this.alinearDerecha = _ninguna,
  });

  static bool _ninguna(ColumnaTabla c) => false;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: margen,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: Colors.grey.shade300))),
      child: Row(
        children: [
          for (final c in columnas)
            Expanded(
              flex: c.flex,
              child: c.orden == null
                  ? Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(c.titulo, style: estiloEncabezadoTabla))
                  : _encabezadoOrdenable(c),
            ),
        ],
      ),
    );
  }

  Widget _encabezadoOrdenable(ColumnaTabla c) {
    final activo = ordenActual == c.orden;
    final derecha = alinearDerecha(c);
    return InkWell(
      onTap: () => alOrdenar(c.orden!),
      focusColor: GomaqColors.accion.withValues(alpha: 0.12),
      child: Semantics(
        button: true,
        label: 'Ordenar por ${c.titulo}${activo ? (ascendente ? ', de menor a mayor' : ', de mayor a menor') : ''}',
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Row(
            mainAxisAlignment: derecha ? MainAxisAlignment.end : MainAxisAlignment.start,
            children: [
              Flexible(
                child: Text(
                  c.titulo,
                  style: estiloEncabezadoTabla,
                  overflow: TextOverflow.ellipsis,
                  textAlign: derecha ? TextAlign.right : TextAlign.left,
                ),
              ),
              if (activo) Icon(ascendente ? Icons.arrow_upward : Icons.arrow_downward, size: 14, color: Colors.black87),
            ],
          ),
        ),
      ),
    );
  }
}
