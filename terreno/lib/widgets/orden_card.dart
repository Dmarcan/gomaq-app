import 'package:flutter/material.dart';
import '../models/orden_trabajo.dart';
import '../theme/gomaq_theme.dart';
import 'estado_chip.dart';

class OrdenCard extends StatelessWidget {
  final OrdenTrabajo orden;
  final VoidCallback onAbrir;

  const OrdenCard({super.key, required this.orden, required this.onAbrir});

  bool get _activa => orden.estado == 'asignada' || orden.estado == 'en_terreno' || orden.estado == 'en_reparacion';

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        onTap: onAbrir,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'OT-${orden.id}',
                    style: const TextStyle(
                      color: GomaqColors.primario,
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                    ),
                  ),
                  EstadoChip(estado: orden.estado),
                ],
              ),
              const SizedBox(height: 12),
              _fila(Icons.precision_manufacturing_outlined,
                  orden.maquinariaCodigo ?? 'Sin código', subtitulo: orden.motivo),
              if (orden.clienteNombre != null) ...[
                const SizedBox(height: 8),
                _fila(Icons.business_outlined, orden.clienteNombre!),
              ],
              const SizedBox(height: 14),
              // Un solo boton: antes "Ver detalles", "Continuar" y la tarjeta hacian lo mismo,
              // tres objetivos para una sola accion. La tarjeta entera sigue siendo tocable.
              SizedBox(
                width: double.infinity,
                child: _activa
                    ? FilledButton.icon(
                        onPressed: onAbrir,
                        icon: const Icon(Icons.play_arrow, size: 20),
                        label: const Text('Continuar', style: TextStyle(fontSize: 14)),
                      )
                    : OutlinedButton(
                        onPressed: onAbrir,
                        style: OutlinedButton.styleFrom(
                          side: const BorderSide(color: GomaqColors.bordeSutil),
                          foregroundColor: GomaqColors.textoPrimario,
                        ),
                        child: const Text('Ver detalles', style: TextStyle(fontSize: 14)),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _fila(IconData icono, String texto, {String? subtitulo}) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icono, size: 18, color: GomaqColors.textoSecundario),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                texto,
                style: const TextStyle(color: GomaqColors.textoPrimario, fontWeight: FontWeight.w600),
              ),
              if (subtitulo != null && subtitulo.isNotEmpty)
                Text(
                  subtitulo,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 12),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
