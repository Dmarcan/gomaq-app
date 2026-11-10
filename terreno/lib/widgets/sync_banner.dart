import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';
import '../utils/cambios.dart';

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
  /// Cambios sin enviar, contando tambien los que estan en error.
  final int pendientes;
  final int enError;
  /// Cambios pendientes frenados detras de uno en error (de la misma OT).
  final int enEspera;
  /// Motivo del ultimo fallo de un cambio que sigue pendiente (null si no hay).
  final String? problema;
  final VoidCallback? onTapErrores;
  /// Sincronizar a mano. Se ofrece cuando no hay errores que mostrar y hay senal.
  final VoidCallback? onActualizar;

  const SyncBanner({
    super.key,
    required this.online,
    required this.sincronizando,
    required this.pendientes,
    required this.enError,
    this.enEspera = 0,
    this.problema,
    this.onTapErrores,
    this.onActualizar,
  });

  /// Texto mientras corre una sincronizacion: si no hay nada que enviar, solo se esta bajando lo
  /// nuevo del servidor. Lo usa tambien el indicador de la pantalla de la OT.
  static String textoSincronizando({required int pendientes, required int enError}) =>
      pendientes - enError > 0 ? 'Enviando cambios…' : 'Actualizando…';

  /// Franja sin señal: dice cuántos cambios esperan en el teléfono (si hay).
  static String textoSinConexion(int pendientes) => pendientes > 0
      ? 'Sin conexión. ${_cambios(pendientes)} ${pendientes == 1 ? 'guardado' : 'guardados'} en el teléfono.'
      : 'Sin conexión. Tus cambios se guardan en el teléfono.';

  /// "1 cambio no se pudo enviar y 3 esperan detrás".
  static String textoErrores(int enError, int enEspera) {
    final base = '${_cambios(enError)} no se ${enError == 1 ? 'pudo' : 'pudieron'} enviar';
    if (enEspera <= 0) return base;
    return '$base y $enEspera ${enEspera == 1 ? 'espera' : 'esperan'} detrás';
  }

  @override
  Widget build(BuildContext context) {
    // pendientes que ya fallaron al menos una vez: se muestran como aviso, con su motivo
    final conProblema = enError == 0 && online && pendientes > 0 && problema != null;
    final puedeActualizar = !sincronizando && enError == 0 && !conProblema && online && onActualizar != null;
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
        ? textoSincronizando(pendientes: pendientes, enError: enError)
        : enError > 0
            ? '${textoErrores(enError, enEspera)}. Toca para ver cuál y reintentar.'
            : conProblema
                ? '${_cambios(pendientes)} por enviar. $problema Toca para ver el detalle.'
                : online
                    ? (pendientes > 0 ? '${_cambios(pendientes)} por enviar' : 'Todo enviado')
                    : textoSinConexion(pendientes);

    return Semantics(
      button: enError > 0 || conProblema || puedeActualizar,
      hint: puedeActualizar ? 'Toca para actualizar' : null,
      child: InkWell(
        onTap: enError > 0 || conProblema
            ? onTapErrores
            : puedeActualizar
                ? onActualizar
                : null,
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
              // se ve que la franja se puede tocar para actualizar, no solo por el color
              if (puedeActualizar) ...[
                const SizedBox(width: 6),
                Icon(Icons.refresh, size: 18, color: color),
              ],
            ],
          ),
        ),
      ),
    );
  }

  static String _cambios(int n) => textoCambios(n);
}
