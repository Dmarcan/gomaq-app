import 'package:flutter/material.dart';
import '../services/push_service.dart';

/// Explica para que se piden los avisos antes del permiso del sistema (Android). Devuelve true si la
/// persona acepta. Si no acepta, el panel sigue igual y queda el boton de avisos para hacerlo despues.
Future<bool> mostrarDialogoPermisoAvisos(BuildContext context) async {
  final r = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (c) => AlertDialog(
      title: Semantics(header: true, child: const Text('¿Activar avisos?')),
      content: const Text(
        'Te avisaremos de lo que requiere tu atención, aunque la app esté cerrada. Es opcional: '
        'puedes activarlos o desactivarlos cuando quieras desde el icono de campana.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Ahora no')),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Activar avisos')),
      ],
    ),
  );
  return r == true;
}

/// Aviso con el panel abierto. Se anuncia solo al lector de pantalla (liveRegion).
SnackBar snackBarAviso(String texto) => SnackBar(
      content: Semantics(liveRegion: true, child: Text(texto)),
      duration: const Duration(seconds: 6),
    );

/// Texto corto de cada estado; sirve de tooltip y de etiqueta para el lector de pantalla.
String etiquetaAvisos(EstadoAvisos e) => switch (e) {
      EstadoAvisos.porActivar => 'Activar avisos',
      EstadoAvisos.activados => 'Avisos activados',
      EstadoAvisos.bloqueados => 'Avisos bloqueados por el navegador o el sistema',
      EstadoAvisos.noDisponible => 'Avisos no disponibles en este dispositivo',
    };

String _explicacion(EstadoAvisos e) => switch (e) {
      EstadoAvisos.porActivar => 'Recibirás avisos de lo que requiere tu atención.',
      EstadoAvisos.activados => 'Este equipo recibe avisos. Se desactivan al cerrar sesión.',
      EstadoAvisos.bloqueados =>
        'Los avisos están bloqueados. Para recibirlos, permite las notificaciones de GOMAQ en la '
            'configuración del navegador o del teléfono y vuelve a abrir el panel.',
      EstadoAvisos.noDisponible =>
        'Este navegador no admite avisos. En iPhone y iPad solo funcionan si instalas el panel en la pantalla '
            'de inicio (iOS 16.4 o superior).',
    };

/// Boton de campana para activar los avisos push. NUNCA pide permiso por si solo: solo al tocarlo, y solo
/// cuando el estado es "por activar". Sin config de Firebase no se dibuja nada. Con [color] se adapta al
/// fondo de la barra (oscura o clara).
class BotonAvisos extends StatelessWidget {
  final PushService? servicio;
  final Color? color;
  final double? tamano;
  const BotonAvisos({super.key, this.servicio, this.color, this.tamano});

  @override
  Widget build(BuildContext context) {
    final s = servicio ?? PushService.instancia;
    if (!s.configurado) return const SizedBox.shrink();
    return ValueListenableBuilder<EstadoAvisos>(
      valueListenable: s.estado,
      builder: (context, estado, _) {
        final etiqueta = etiquetaAvisos(estado);
        final icono = switch (estado) {
          EstadoAvisos.porActivar => Icons.notifications_none,
          EstadoAvisos.activados => Icons.notifications_active,
          EstadoAvisos.bloqueados => Icons.notifications_off,
          EstadoAvisos.noDisponible => Icons.notifications_off_outlined,
        };
        return IconButton(
          icon: Icon(icono, color: color, size: tamano),
          tooltip: etiqueta,
          onPressed: () async {
            if (estado == EstadoAvisos.porActivar) {
              await s.activar();
              return;
            }
            await showDialog<void>(
              context: context,
              builder: (c) => AlertDialog(
                title: Semantics(header: true, child: Text(etiqueta)),
                content: Text(_explicacion(estado)),
                actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Entendido'))],
              ),
            );
          },
        );
      },
    );
  }
}
