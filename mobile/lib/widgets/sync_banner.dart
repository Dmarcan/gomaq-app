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
              'Tu sesion expiro - vuelve a iniciar sesion para sincronizar (tu trabajo esta guardado)',
              style: TextStyle(fontSize: 13, color: GomaqColors.textoPrimario),
            ),
          ),
          TextButton(
            onPressed: onIniciarSesion,
            child: const Text('Iniciar sesion', style: TextStyle(fontSize: 12)),
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
  final VoidCallback? onTapErrores;

  const SyncBanner({
    super.key,
    required this.online,
    required this.sincronizando,
    required this.pendientes,
    required this.enError,
    this.onTapErrores,
  });

  @override
  Widget build(BuildContext context) {
    final color = enError > 0
        ? GomaqColors.estadoNegativo
        : online
            ? GomaqColors.estadoPositivo
            : GomaqColors.estadoAdvertencia;
    final icono = enError > 0
        ? Icons.sync_problem
        : online
            ? Icons.cloud_done
            : Icons.cloud_off;
    final texto = sincronizando
        ? 'Sincronizando...'
        : enError > 0
            ? '$enError cambios no se pudieron sincronizar - toca para reintentar'
            : online
                ? (pendientes > 0 ? '$pendientes cambios pendientes de sincronizar' : 'Todo sincronizado')
                : 'Sin conexion - los cambios se guardan localmente';

    return InkWell(
      onTap: enError > 0 ? onTapErrores : null,
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
}
