import 'package:flutter/material.dart';

import '../utils/formato.dart';
import '../utils/iva.dart';
import '../utils/numeros.dart';
import 'dialogos.dart';

/// Campo "Costo unitario" con la casilla "El precio incluye IVA (19 %)".
///
/// El costo se guarda siempre sin IVA. Con la casilla marcada se muestra, en vivo, el neto que se va
/// a guardar (región viva para el lector de pantalla). Lo que se envía lo calcula
/// [costoNetoParaGuardar] con el mismo texto del campo.
class CampoCostoIva extends StatelessWidget {
  final TextEditingController controller;
  final bool incluyeIva;
  final ValueChanged<bool> onIvaChanged;

  /// Se avisa en cada cambio del texto, para que el cuadro redibuje el neto.
  final VoidCallback onTextoChanged;

  const CampoCostoIva({
    super.key,
    required this.controller,
    required this.incluyeIva,
    required this.onIvaChanged,
    required this.onTextoChanged,
  });

  @override
  Widget build(BuildContext context) {
    final monto = parsearMonto(controller.text);
    final neto = (monto == null || monto < 0 || monto != monto.truncateToDouble())
        ? null
        : costoNetoParaGuardar(monto, incluyeIva: true);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextFormField(
          controller: controller,
          keyboardType: TextInputType.number,
          onChanged: (_) => onTextoChanged(),
          decoration: decoracionCampo(
            'Costo unitario',
            prefijo: r'$ ',
            ayuda: 'En pesos. Se guarda sin IVA. Puedes dejarlo en blanco y cargarlo después.',
          ),
          validator: numeroOpcional('Escribe un monto válido, por ejemplo 18.500.', monto: true),
        ),
        CheckboxListTile(
          key: const Key('casilla_incluye_iva'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          dense: true,
          value: incluyeIva,
          onChanged: (v) => onIvaChanged(v ?? false),
          title: const Text('El precio incluye IVA (19 %)'),
        ),
        Semantics(
          liveRegion: true,
          child: incluyeIva
              ? LineaInfo(
                  icono: Icons.calculate_outlined,
                  texto: neto == null
                      ? 'Escribe el precio con IVA para ver el costo neto que se guardará.'
                      : 'Se guardará sin IVA: ${Formato.clp(neto)}',
                )
              : const SizedBox.shrink(),
        ),
      ],
    );
  }
}
