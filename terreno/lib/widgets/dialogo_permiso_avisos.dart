import 'package:flutter/material.dart';

/// Explica para que se piden los avisos antes del permiso del sistema. Devuelve true si el mecanico
/// acepta. Si no acepta, la app sigue igual y no se vuelve a preguntar en cada arranque.
Future<bool> mostrarDialogoPermisoAvisos(BuildContext context) async {
  final r = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (c) => AlertDialog(
      title: Semantics(header: true, child: const Text('¿Activar avisos de órdenes?')),
      content: const Text(
        'Te avisaremos cuando te asignen una orden o haya una disponible para tomar, aunque la app '
        'esté cerrada. Es opcional: puedes seguir trabajando igual y revisar la lista cuando quieras.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Ahora no')),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Activar avisos')),
      ],
    ),
  );
  return r == true;
}

/// Aviso con la app abierta. Se anuncia solo al lector de pantalla (liveRegion).
SnackBar snackBarAviso(String texto) => SnackBar(
      content: Semantics(liveRegion: true, child: Text(texto)),
      duration: const Duration(seconds: 6),
    );
