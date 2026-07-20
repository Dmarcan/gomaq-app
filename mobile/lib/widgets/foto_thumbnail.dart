import 'dart:io';
import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Miniatura de evidencia con timestamp sobreimpreso y badge de sincronizacion.
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
    return ClipRRect(
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
          if (_timestamp != null)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 2),
                color: Colors.black.withValues(alpha: 0.6),
                child: Text(
                  _timestamp!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 9, color: Colors.white),
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
    );
  }
}
