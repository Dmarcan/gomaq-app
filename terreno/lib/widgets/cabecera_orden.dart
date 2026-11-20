import 'package:flutter/material.dart';
import '../models/orden_trabajo.dart';
import '../screens/maquinaria_historial_screen.dart';
import '../theme/gomaq_theme.dart';
import 'estado_chip.dart';
import 'foto_del_cliente.dart';

/// Lo de arriba del detalle de una orden: estado, numero, equipo (con su historial), motivo, la foto
/// que mando el cliente, el cliente y, mientras la orden siga abierta, el acceso a la lectura de horometro.
class CabeceraOrden extends StatelessWidget {
  final OrdenTrabajo orden;
  final VoidCallback alRegistrarHorometro;
  const CabeceraOrden({super.key, required this.orden, required this.alRegistrarHorometro});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                EstadoChip(estado: orden.estado),
                Text(
                  etiquetaOt(orden.id),
                  style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 12),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Text(
                    orden.maquinariaCodigo ?? 'Sin código',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                  ),
                ),
                TextButton.icon(
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => MaquinariaHistorialScreen(
                        maquinariaId: orden.maquinariaId,
                        codigo: orden.maquinariaCodigo ?? '',
                      ),
                    ),
                  ),
                  icon: const Icon(Icons.history, size: 16),
                  label: const Text('Historial', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            if (orden.motivo != null && orden.motivo!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(orden.motivo!, style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 13)),
            ],
            FotoDelCliente(ordenId: orden.id),
            if (orden.clienteNombre != null) ...[
              const SizedBox(height: 8),
              Text.rich(
                TextSpan(
                  style: const TextStyle(fontSize: 13),
                  children: [
                    const TextSpan(text: 'Cliente: ', style: TextStyle(color: GomaqColors.textoSecundario)),
                    TextSpan(text: orden.clienteNombre!),
                  ],
                ),
              ),
            ],
            if (orden.estado != 'finalizada') ...[
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: alRegistrarHorometro,
                icon: const Icon(Icons.speed, size: 18),
                label: const Text('Agregar lectura de horómetro'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
