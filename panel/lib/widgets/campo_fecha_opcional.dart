import 'package:flutter/material.dart';
import '../utils/cobranza.dart';
import 'dialogos.dart';

/// Un día opcional (emisión, vencimiento, pago) escrito como dd-mm-aaaa, con un botón para elegirlo en
/// el calendario y otro para quitarlo. `valor` es AAAA-MM-DD o null.
///
/// Los dos botones se alcanzan con Tab y se activan con Enter o Espacio, y cada uno dice a qué fecha
/// se refiere para el lector de pantalla.
class CampoFechaOpcional extends StatelessWidget {
  final String etiqueta;
  final String? valor;
  final ValueChanged<String?> onChanged;
  final String? error;
  final DateTime? primera;
  final DateTime? ultima;
  final bool opcional;

  const CampoFechaOpcional({
    super.key,
    required this.etiqueta,
    required this.valor,
    required this.onChanged,
    this.error,
    this.primera,
    this.ultima,
    this.opcional = true,
  });

  Future<void> _elegir(BuildContext context) async {
    final actual = diaDesdeIso(valor) ?? DateTime.now();
    final primero = primera ?? DateTime(2000);
    final ultimo = ultima ?? DateTime.now().add(const Duration(days: 800));
    final inicial = actual.isBefore(primero) ? primero : (actual.isAfter(ultimo) ? ultimo : actual);
    final elegida = await showDatePicker(context: context, initialDate: inicial, firstDate: primero, lastDate: ultimo);
    if (elegida != null) onChanged(diaIso(elegida));
  }

  @override
  Widget build(BuildContext context) {
    final texto = valor == null ? (opcional ? 'Sin fecha' : 'Elige una fecha') : fechaGuiones(valor);
    return InputDecorator(
      decoration: decoracionCampo(etiqueta).copyWith(
        errorText: error,
        suffixIcon: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              icon: const Icon(Icons.calendar_today, size: 20),
              tooltip: 'Elegir $etiqueta',
              onPressed: () => _elegir(context),
            ),
            if (valor != null && opcional)
              IconButton(
                icon: const Icon(Icons.close, size: 20),
                tooltip: 'Quitar $etiqueta',
                onPressed: () => onChanged(null),
              ),
          ],
        ),
      ),
      child: Text(texto, style: TextStyle(color: valor == null ? Colors.black54 : null)),
    );
  }
}
