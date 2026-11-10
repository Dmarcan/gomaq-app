import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Lista de ordenes vacia. Antes era un texto fijo sin forma de actualizar: si la oficina asignaba
/// una orden con la app abierta, el mecanico no tenia como traerla. Ahora se puede deslizar hacia
/// abajo (la lista es desplazable aunque no tenga nada) o tocar "Actualizar".
class ListaVaciaOrdenes extends StatelessWidget {
  final Future<void> Function() onActualizar;

  const ListaVaciaOrdenes({super.key, required this.onActualizar});

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onActualizar,
      child: ListView(
        // sin esto, una lista mas corta que la pantalla no se deja deslizar y el gesto no hace nada
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(32, 64, 32, 32),
        children: [
          const Icon(Icons.assignment_outlined, size: 56, color: GomaqColors.textoSecundario),
          const SizedBox(height: 12),
          const Text(
            'No tienes órdenes asignadas. Cuando el administrativo te asigne una, aparecerá aquí. '
            'También puedes crear una con el botón Nueva OT.',
            textAlign: TextAlign.center,
            style: TextStyle(color: GomaqColors.textoSecundario),
          ),
          const SizedBox(height: 20),
          Center(
            child: OutlinedButton.icon(
              onPressed: onActualizar,
              icon: const Icon(Icons.refresh),
              label: const Text('Actualizar'),
            ),
          ),
        ],
      ),
    );
  }
}
