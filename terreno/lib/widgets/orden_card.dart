import 'package:flutter/material.dart';
import '../models/orden_trabajo.dart';
import '../theme/gomaq_theme.dart';
import 'estado_chip.dart';

class OrdenCard extends StatelessWidget {
  final OrdenTrabajo orden;
  final VoidCallback onAbrir;
  /// El telefono la cerro pero el cierre sigue en la cola: para la oficina sigue abierta.
  final bool cierreSinEnviar;

  const OrdenCard({super.key, required this.orden, required this.onAbrir, this.cierreSinEnviar = false});

  /// Una OT asignada o pendiente aún no se ha empezado: "Ver orden". "Continuar" es para las ya
  /// aceptadas en adelante.
  static String textoBoton(String estado) =>
      estado == 'asignada' || estado == 'pendiente' ? 'Ver orden' : 'Continuar';

  bool get _activa => const ['asignada', 'aceptada', 'en_camino', 'en_terreno', 'en_reparacion'].contains(orden.estado);

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
                    etiquetaOt(orden.id),
                    style: const TextStyle(
                      color: GomaqColors.primario,
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                    ),
                  ),
                  if (cierreSinEnviar) const _ChipCierreSinEnviar() else EstadoChip(estado: orden.estado),
                ],
              ),
              if (cierreSinEnviar) ...[
                const SizedBox(height: 8),
                const Text(
                  'La cerraste en el teléfono, pero el cierre aún no llega a la oficina.',
                  style: TextStyle(color: GomaqColors.textoSecundario, fontSize: 12),
                ),
              ],
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
                        label: Text(textoBoton(orden.estado), style: const TextStyle(fontSize: 14)),
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

/// Marca de una OT cerrada en el telefono cuyo cierre no se ha enviado: icono y texto, no solo color.
class _ChipCierreSinEnviar extends StatelessWidget {
  const _ChipCierreSinEnviar();

  @override
  Widget build(BuildContext context) {
    const color = GomaqColors.estadoAdvertencia;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.6)),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.cloud_upload_outlined, size: 14, color: color),
          SizedBox(width: 4),
          Text(
            'CIERRE SIN ENVIAR',
            style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.8),
          ),
        ],
      ),
    );
  }
}
