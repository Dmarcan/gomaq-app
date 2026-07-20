import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Seccion atenuada con candado: comunica que se habilita en un paso posterior
/// del flujo (patron tomado del diseño Stitch y del proyecto PruebaMantencion).
class SeccionBloqueada extends StatelessWidget {
  final String titulo;
  final IconData icono;
  final String nota;

  const SeccionBloqueada({
    super.key,
    required this.titulo,
    required this.icono,
    this.nota = 'Se desbloquea al iniciar el trabajo',
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      color: GomaqColors.superficieTarjeta.withValues(alpha: 0.5),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icono, size: 18, color: GomaqColors.textoSecundario.withValues(alpha: 0.6)),
                const SizedBox(width: 8),
                Text(
                  titulo,
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: GomaqColors.textoSecundario.withValues(alpha: 0.6),
                  ),
                ),
                const Spacer(),
                Icon(Icons.lock_outline, size: 16, color: GomaqColors.estadoAdvertencia.withValues(alpha: 0.8)),
              ],
            ),
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: GomaqColors.estadoAdvertencia.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Icon(Icons.lock, size: 14, color: GomaqColors.estadoAdvertencia),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      nota,
                      style: const TextStyle(fontSize: 12, color: GomaqColors.estadoAdvertencia),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
