import 'dart:io';
import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Miniatura de evidencia con timestamp sobreimpreso y badge de sincronizacion. Al tocarla se ve
/// grande: con 92 px no se puede revisar si la foto salio movida o si se lee la placa del equipo.
class FotoThumbnail extends StatelessWidget {
  final String rutaLocal;
  final bool sincronizada;
  final String? creadoEn; // ISO-8601 guardado por sqflite

  const FotoThumbnail({
    super.key,
    required this.rutaLocal,
    required this.sincronizada,
    this.creadoEn,
  });

  String? get _timestamp {
    if (creadoEn == null) return null;
    final fecha = DateTime.tryParse(creadoEn!);
    if (fecha == null) return null;
    String dos(int n) => n.toString().padLeft(2, '0');
    return '${dos(fecha.hour)}:${dos(fecha.minute)} ${dos(fecha.day)}/${dos(fecha.month)}';
  }

  @override
  Widget build(BuildContext context) {
    final hora = _timestamp;
    return Semantics(
      button: true,
      excludeSemantics: true,
      label: 'Foto${hora == null ? '' : ' de las $hora'}, ${sincronizada ? 'enviada' : 'pendiente de envío'}. Toca para ampliar',
      child: InkWell(
        onTap: () => _ampliar(context),
        borderRadius: BorderRadius.circular(10),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Stack(
            children: [
              Image.file(
                File(rutaLocal),
                width: 92,
                height: 92,
                fit: BoxFit.cover,
                // la foto local pudo borrarse (limpieza de datos): placeholder en vez de excepcion
                errorBuilder: (_, _, _) => Container(
                  width: 92,
                  height: 92,
                  color: GomaqColors.superficieElevada,
                  child: const Icon(Icons.broken_image, color: GomaqColors.textoSecundario),
                ),
              ),
              if (hora != null)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    color: Colors.black.withValues(alpha: 0.6),
                    child: Text(
                      hora,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 11, color: Colors.white),
                    ),
                  ),
                ),
              if (!sincronizada)
                Positioned(
                  right: 3,
                  top: 3,
                  child: Container(
                    padding: const EdgeInsets.all(2),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.5),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: const Icon(Icons.cloud_upload, size: 14, color: GomaqColors.estadoAdvertencia),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _ampliar(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(
          children: [
            InteractiveViewer(
              child: Image.file(
                File(rutaLocal),
                fit: BoxFit.contain,
                errorBuilder: (_, _, _) => const SizedBox(
                  height: 200,
                  child: Center(child: Icon(Icons.broken_image, color: GomaqColors.textoSecundario)),
                ),
              ),
            ),
            Positioned(
              right: 4,
              top: 4,
              child: IconButton(
                tooltip: 'Cerrar',
                onPressed: () => Navigator.pop(dialogContext),
                icon: const Icon(Icons.close, color: Colors.white),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
