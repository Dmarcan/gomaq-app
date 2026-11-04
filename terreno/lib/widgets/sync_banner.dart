import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';

/// Banner de sesion expirada (rojo, sobre el de sync).
class SesionExpiradaBanner extends StatelessWidget {
  final VoidCallback onIniciarSesion;
  const SesionExpiradaBanner({super.key, required this.onIniciarSesion});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: GomaqColors.estadoNegativo.withValues(alpha: 0.15),
      padding: const EdgeInsets.all(8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.lock_outline, size: 18, color: GomaqColors.estadoNegativo),
          const SizedBox(width: 6),
          const Flexible(
            child: Text(
              'Tu sesión expiró. Vuelve a iniciar sesión para enviar tus cambios: están guardados en el teléfono.',
              style: TextStyle(fontSize: 13, color: GomaqColors.textoPrimario),
            ),
          ),
          TextButton(
            onPressed: onIniciarSesion,
            child: const Text('Iniciar sesión', style: TextStyle(fontSize: 13)),
          ),
        ],
      ),
    );
  }
}

/// Banner de estado de sincronizacion: rojo con errores, verde online, naranja offline.
class SyncBanner extends StatelessWidget {
  final bool online;
  final bool sincronizando;
  final int pendientes;
  final int enError;
  /// Motivo del ultimo fallo de un cambio que sigue pendiente (null si no hay).
  final String? problema;
  final VoidCallback? onTapErrores;

  const SyncBanner({
    super.key,
    required this.online,
    required this.sincronizando,
    required this.pendientes,
    required this.enError,
    this.problema,
    this.onTapErrores,
  });

  @override
  Widget build(BuildContext context) {
    // pendientes que ya fallaron al menos una vez: se muestran como aviso, con su motivo
    final conProblema = enError == 0 && online && pendientes > 0 && problema != null;
    final color = enError > 0
        ? GomaqColors.estadoNegativo
        : conProblema
            ? GomaqColors.estadoAdvertencia
            : online
            ? GomaqColors.estadoPositivo
            : GomaqColors.estadoAdvertencia;
    final icono = sincronizando
        ? Icons.sync
        : enError > 0 || conProblema
            ? Icons.sync_problem
            : online
                ? Icons.cloud_done
                : Icons.cloud_off;
    final texto = sincronizando
        ? 'Enviando cambios…'
        : enError > 0
            ? '${_cambios(enError)} no se ${enError == 1 ? 'pudo' : 'pudieron'} enviar. Toca para ver cuál y reintentar.'
            : conProblema
                ? '${_cambios(pendientes)} por enviar. $problema Toca para ver el detalle.'
                : online
                    ? (pendientes > 0 ? '${_cambios(pendientes)} por enviar' : 'Todo enviado')
                    : 'Sin conexión. Tus cambios se guardan en el teléfono.';

    return InkWell(
      onTap: enError > 0 || conProblema ? onTapErrores : null,
      child: Container(
        width: double.infinity,
        color: color.withValues(alpha: 0.15),
        padding: const EdgeInsets.all(8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icono, size: 18, color: color),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                texto,
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: color),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _cambios(int n) => n == 1 ? '1 cambio' : '$n cambios';
}
