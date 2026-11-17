import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/gomaq_theme.dart';

/// Plazos habituales de pago, en días. 0 es contado.
const plazosRapidosPago = <int>[0, 5, 15, 30, 45, 60, 90];

/// Texto de un plazo: "Contado" o "30 días".
String etiquetaPlazoPago(int? dias) {
  if (dias == null) return 'Sin plazo de pago';
  if (dias == 0) return 'Contado';
  return dias == 1 ? '1 día' : '$dias días';
}

/// Plazo habitual de pago de un cliente: botones Contado, 5, 15, 30, 45, 60, 90 y "Otro" (0 a 365).
///
/// No hay opción elegida de entrada: la persona tiene que decidirlo. Dentro de un [Form] es obligatorio
/// y, si falta, muestra "Elige el plazo de pago". Cada botón se alcanza con Tab y se activa con Enter o
/// Espacio, y el elegido se distingue por marca y borde, no solo por color.
class SelectorPlazoPago extends FormField<int?> {
  SelectorPlazoPago({
    super.key,
    int? valor,
    ValueChanged<int?>? onChanged,
    super.validator = _validarObligatorio,
  }) : super(
          initialValue: valor,
          builder: (estado) => _CuerpoSelector(
            estado: estado,
            onChanged: onChanged,
          ),
        );

  static String? _validarObligatorio(int? v) => v == null ? 'Elige el plazo de pago' : null;
}

class _CuerpoSelector extends StatefulWidget {
  final FormFieldState<int?> estado;
  final ValueChanged<int?>? onChanged;
  const _CuerpoSelector({required this.estado, this.onChanged});

  @override
  State<_CuerpoSelector> createState() => _CuerpoSelectorState();
}

class _CuerpoSelectorState extends State<_CuerpoSelector> {
  late bool _otro;
  late final TextEditingController _ctrl;

  @override
  void initState() {
    super.initState();
    final v = widget.estado.value;
    // un valor que no es de los botones (por ejemplo 20) abre "Otro" con el número escrito
    _otro = v != null && !plazosRapidosPago.contains(v);
    _ctrl = TextEditingController(text: _otro ? '$v' : '');
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _elegir(int? v) {
    widget.estado.didChange(v);
    widget.onChanged?.call(v);
  }

  void _elegirRapido(int dias) {
    setState(() => _otro = false);
    _elegir(dias);
  }

  void _elegirOtro() {
    setState(() => _otro = true);
    _elegir(_leerOtro());
  }

  int? _leerOtro() {
    final t = _ctrl.text.trim();
    if (!RegExp(r'^\d{1,3}$').hasMatch(t)) return null;
    final n = int.parse(t);
    return n <= 365 ? n : null;
  }

  @override
  Widget build(BuildContext context) {
    final valor = widget.estado.value;
    final error = widget.estado.errorText;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          container: true,
          label: 'Plazo de pago habitual',
          child: Text('Plazo de pago habitual *', style: Theme.of(context).textTheme.labelLarge),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final d in plazosRapidosPago)
              _OpcionPlazo(
                etiqueta: d == 0 ? 'Contado' : '$d',
                nombre: d == 0 ? 'Contado' : '$d días',
                elegida: !_otro && valor == d,
                onTap: () => _elegirRapido(d),
              ),
            _OpcionPlazo(etiqueta: 'Otro', nombre: 'Otro plazo', elegida: _otro, onTap: _elegirOtro),
          ],
        ),
        if (_otro) ...[
          const SizedBox(height: 10),
          SizedBox(
            width: 220,
            child: TextField(
              controller: _ctrl,
              autofocus: true,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(3)],
              decoration: const InputDecoration(
                labelText: 'Días de plazo',
                helperText: 'Un número de 0 a 365.',
                suffixText: 'días',
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => _elegir(_leerOtro()),
            ),
          ),
        ],
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Semantics(
              liveRegion: true,
              child: Row(
                children: [
                  const Icon(Icons.error_outline, size: 16, color: GomaqColors.estadoNegativo),
                  const SizedBox(width: 6),
                  Expanded(child: Text(error, style: const TextStyle(color: GomaqColors.estadoNegativo, fontSize: 12))),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// Un botón del selector. Se alcanza con Tab y se activa con Enter o Espacio (InkWell). El elegido lleva
/// una marca y el borde más grueso, además del color.
class _OpcionPlazo extends StatelessWidget {
  final String etiqueta;
  final String nombre;
  final bool elegida;
  final VoidCallback onTap;
  const _OpcionPlazo({required this.etiqueta, required this.nombre, required this.elegida, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final color = elegida ? GomaqColors.accion : Colors.grey.shade700;
    return Semantics(
      button: true,
      selected: elegida,
      label: nombre,
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: elegida ? GomaqColors.accion.withValues(alpha: 0.10) : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: BorderSide(color: elegida ? GomaqColors.accion : Colors.grey.shade500, width: elegida ? 2 : 1),
        ),
        child: InkWell(
          onTap: onTap,
          customBorder: const StadiumBorder(),
          focusColor: GomaqColors.accion.withValues(alpha: 0.2),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44, minWidth: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (elegida) ...[Icon(Icons.check, size: 18, color: color), const SizedBox(width: 4)],
                  Text(etiqueta, style: TextStyle(color: color, fontWeight: elegida ? FontWeight.w700 : FontWeight.w500)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
