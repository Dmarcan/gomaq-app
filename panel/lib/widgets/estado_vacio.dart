import 'package:flutter/material.dart';

/// Pantalla o lista sin datos: qué es, por qué está vacía y cómo empezar.
///
/// Antes varias secciones (Asistencias, el catálogo de Insumos) quedaban completamente en
/// blanco cuando no había datos, y no se distinguía de una pantalla que no cargó.
class EstadoVacio extends StatelessWidget {
  final IconData icono;
  final String titulo;
  final String mensaje;
  final String? textoAccion;
  final VoidCallback? onAccion;

  const EstadoVacio({
    super.key,
    required this.icono,
    required this.titulo,
    required this.mensaje,
    this.textoAccion,
    this.onAccion,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icono, size: 56, color: Colors.grey.shade500),
              const SizedBox(height: 16),
              Text(titulo,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text(mensaje, textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade700)),
              if (textoAccion != null && onAccion != null) ...[
                const SizedBox(height: 20),
                FilledButton(onPressed: onAccion, child: Text(textoAccion!)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
