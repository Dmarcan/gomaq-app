import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Una pestaña: `id` es lo que se devuelve al elegirla, `cantidad` (opcional) se muestra al lado.
typedef ItemPestana = ({String id, String etiqueta, int? cantidad});

/// Fila de pestañas para separar una pantalla en secciones o en categorías (Flota, perfil).
///
/// El TabBar de Material exige un TabController y un TabBarView con todo el contenido montado;
/// aquí la pantalla decide qué mostrar según la pestaña, que además es lo que necesita Flota
/// (cada pestaña es un filtro que recarga la lista, no un contenido distinto ya cargado).
class Pestanas extends StatelessWidget {
  final List<ItemPestana> items;
  final String seleccionada;
  final ValueChanged<String> onSeleccionar;

  const Pestanas({
    super.key,
    required this.items,
    required this.seleccionada,
    required this.onSeleccionar,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: Colors.grey.shade300))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final item in items) _Pestana(item: item, activa: item.id == seleccionada, onTap: () => onSeleccionar(item.id)),
          ],
        ),
      ),
    );
  }
}

class _Pestana extends StatefulWidget {
  final ItemPestana item;
  final bool activa;
  final VoidCallback onTap;
  const _Pestana({required this.item, required this.activa, required this.onTap});

  @override
  State<_Pestana> createState() => _PestanaState();
}

class _PestanaState extends State<_Pestana> {
  ItemPestana get item => widget.item;
  bool get activa => widget.activa;
  VoidCallback get onTap => widget.onTap;

  @override
  void initState() {
    super.initState();
    _mostrarSiActiva();
  }

  @override
  void didUpdateWidget(covariant _Pestana anterior) {
    super.didUpdateWidget(anterior);
    if (widget.activa && !anterior.activa) _mostrarSiActiva();
  }

  /// En un teléfono la fila se desplaza: la pestaña elegida no debe quedar cortada al borde.
  void _mostrarSiActiva() {
    if (!widget.activa) return;
    // en el primer cuadro la fila aún no conoce su ancho total: se espera un cuadro más
    WidgetsBinding.instance.addPostFrameCallback((_) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        Scrollable.ensureVisible(context, duration: const Duration(milliseconds: 200), alignment: 0.5);
      });
      WidgetsBinding.instance.scheduleFrame();
    });
  }

  @override
  Widget build(BuildContext context) {
    final cantidad = item.cantidad;
    // El InkWell va por fuera y la etiqueta por dentro: así el nodo de accesibilidad conserva el
    // foco de teclado y la acción de tocar del InkWell. Al revés (Semantics > ExcludeSemantics >
    // InkWell) el lector la leía pero no se podía enfocar con Tab ni activar.
    return InkWell(
      onTap: onTap,
      focusColor: GomaqColors.accion.withValues(alpha: 0.12),
      child: Semantics(
        button: true,
        selected: activa,
        label: cantidad == null ? item.etiqueta : '${item.etiqueta}, $cantidad',
        excludeSemantics: true,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: activa ? GomaqColors.accion : Colors.transparent, width: 3)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                item.etiqueta,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: activa ? FontWeight.w700 : FontWeight.w500,
                  color: activa ? Colors.black87 : Colors.black54,
                ),
              ),
              if (cantidad != null) ...[
                const SizedBox(width: 6),
                Text('$cantidad', style: const TextStyle(fontSize: 13, color: Colors.black54)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
