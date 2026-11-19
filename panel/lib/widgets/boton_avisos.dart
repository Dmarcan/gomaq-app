import 'package:flutter/material.dart';
import '../services/avisos_locales_service.dart';
import '../services/push_service.dart';
import '../utils/navegador_avisos.dart';

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
      EstadoAvisos.soloPanelAbierto => 'Avisos activados con el panel abierto',
      EstadoAvisos.bloqueados => 'Avisos bloqueados por el navegador o el sistema',
      EstadoAvisos.noDisponible => 'Avisos no disponibles en este dispositivo',
    };

/// Une las dos capas de avisos de la web en lo que ve la persona:
/// - capa 1 (local, con el panel abierto): [local];
/// - capa 2 (Firebase, con el navegador cerrado): [push].
/// Sin capa 1 (Android, o un navegador sin notificaciones) manda solo el push, como antes.
EstadoAvisos estadoCombinado({required EstadoAvisos push, required EstadoLocal local}) => switch (local) {
      EstadoLocal.noSoportado => push,
      EstadoLocal.bloqueados => EstadoAvisos.bloqueados,
      EstadoLocal.porActivar => EstadoAvisos.porActivar,
      EstadoLocal.activados => push == EstadoAvisos.activados ? EstadoAvisos.activados : EstadoAvisos.soloPanelAbierto,
    };

/// Texto del dialogo de cada estado. [motivo] es el motivo tecnico corto de que el push no ande (si lo hay);
/// [navegador] elige las instrucciones para recibir avisos con el navegador cerrado.
String explicacionAvisos(EstadoAvisos e, {String? motivo, Navegador navegador = Navegador.otro}) {
  final detalle = motivo == null ? '' : '\n\nMotivo técnico: $motivo.';
  return switch (e) {
    EstadoAvisos.porActivar => 'Recibirás avisos de lo que requiere tu atención.',
    EstadoAvisos.activados => 'Este equipo recibe avisos. Se desactivan al cerrar sesión.',
    EstadoAvisos.soloPanelAbierto =>
      'Recibirás avisos mientras tengas el panel abierto en el navegador. Con el navegador cerrado no llegan.'
          '\n\n${instruccionesAvisos(navegador)}$detalle',
    EstadoAvisos.bloqueados =>
      'Los avisos están bloqueados. Para recibirlos, permite las notificaciones de GOMAQ en la '
          'configuración del navegador o del teléfono y vuelve a abrir el panel.',
    EstadoAvisos.noDisponible => 'Este navegador no permite avisos.\n\n${instruccionesAvisos(navegador)}$detalle',
  };
}

/// Boton de campana para activar los avisos. NUNCA pide permiso por si solo: solo al tocarlo, y solo
/// cuando el estado es "por activar". No se dibuja si no hay ninguna capa disponible (sin config de
/// Firebase y con un navegador sin notificaciones). Con [color] se adapta al fondo de la barra.
class BotonAvisos extends StatelessWidget {
  final PushService? servicio;
  final AvisosLocalesService? locales;
  final Color? color;
  final double? tamano;
  const BotonAvisos({super.key, this.servicio, this.locales, this.color, this.tamano});

  @override
  Widget build(BuildContext context) {
    final s = servicio ?? PushService.instancia;
    final l = locales ?? AvisosLocalesService.instancia;
    if (!s.configurado && !l.soportado) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: Listenable.merge([s.estado, l.estado]),
      builder: (context, _) {
        final estado = estadoCombinado(push: s.estado.value, local: l.estado.value);
        final etiqueta = etiquetaAvisos(estado);
        final icono = switch (estado) {
          EstadoAvisos.porActivar => Icons.notifications_none,
          EstadoAvisos.activados || EstadoAvisos.soloPanelAbierto => Icons.notifications_active,
          EstadoAvisos.bloqueados => Icons.notifications_off,
          EstadoAvisos.noDisponible => Icons.notifications_off_outlined,
        };
        return IconButton(
          icon: Icon(icono, color: color, size: tamano),
          tooltip: etiqueta,
          onPressed: () async {
            if (estado == EstadoAvisos.porActivar) {
              await activarAvisos(s, l);
              return;
            }
            final navegador = detectarNavegador(l.plataforma.userAgent, esBrave: l.plataforma.esBrave);
            await showDialog<void>(
              context: context,
              builder: (c) => AlertDialog(
                title: Semantics(header: true, child: Text(etiqueta)),
                content: SingleChildScrollView(
                  child: Text(explicacionAvisos(estado,
                      motivo: s.motivoNoDisponible, navegador: navegador)),
                ),
                actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Entendido'))],
              ),
            );
          },
        );
      },
    );
  }
}

/// Accion de la persona (campana o banner): pide el permiso al navegador una sola vez, empieza los avisos
/// con el panel abierto (capa 1) y, si Firebase esta configurado, registra tambien el push (capa 2).
/// Si el push falla, la capa 1 sigue andando y el motivo queda en [PushService.motivoNoDisponible].
Future<void> activarAvisos(PushService push, AvisosLocalesService locales) async {
  if (locales.soportado) await locales.activar();
  await push.activar();
}

/// Invitacion despues de iniciar sesion (web): un banner propio, antes del permiso del navegador. El
/// permiso solo se pide si la persona pulsa "Activar". Los botones van debajo del texto para que se lea
/// bien desde 375 px.
MaterialBanner bannerInvitacionAvisos({required VoidCallback alActivar, required VoidCallback alDescartar}) =>
    MaterialBanner(
      forceActionsBelow: true,
      leading: const Icon(Icons.notifications_none),
      content: Semantics(
        liveRegion: true,
        child: const Text('¿Quieres recibir avisos de órdenes y pendientes? Te avisaremos con el panel abierto.'),
      ),
      actions: [
        TextButton(onPressed: alDescartar, child: const Text('Ahora no')),
        FilledButton(onPressed: alActivar, child: const Text('Activar')),
      ],
    );
