import 'package:flutter/material.dart';

/// Texto que se suma al aviso de desactivar cuando la cuenta tiene órdenes abiertas.
/// `ot_abiertas` llega como número o como texto (el conteo de Postgres viaja como texto).
String? avisoOtAbiertas(Object? otAbiertas) {
  final n = int.tryParse('${otAbiertas ?? 0}') ?? 0;
  if (n <= 0) return null;
  final ordenes = n == 1 ? '1 orden abierta' : '$n órdenes abiertas';
  return 'Tiene $ordenes: reasígnalas antes o después de desactivar.';
}

/// Acciones de una fila de "Cuentas del equipo". En la propia cuenta no se ofrece restablecer la
/// contraseña ni desactivar: queda el texto "(tu cuenta)". Una cuenta invitada que aún no acepta
/// ofrece un código nuevo (reenviar o copiar otro mensaje) y revocar la invitación.
class AccionesCuentaEquipo extends StatelessWidget {
  final Map<String, dynamic> usuario;
  final bool esPropia;
  final VoidCallback onClave;
  final VoidCallback onDesactivar;
  final VoidCallback onReactivar;
  final VoidCallback? onNuevaInvitacion;
  final VoidCallback? onRevocar;

  const AccionesCuentaEquipo({
    super.key,
    required this.usuario,
    required this.esPropia,
    required this.onClave,
    required this.onDesactivar,
    required this.onReactivar,
    this.onNuevaInvitacion,
    this.onRevocar,
  });

  @override
  Widget build(BuildContext context) {
    if (esPropia) {
      return const Text('(tu cuenta)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.black87));
    }
    final colorPeligro = Theme.of(context).colorScheme.error;
    if (usuario['estado_cuenta'] == 'pendiente') {
      return Wrap(
        spacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Semantics(
            label: 'Nuevo código de invitación para ${usuario['nombre']}',
            excludeSemantics: true,
            child: TextButton(onPressed: onNuevaInvitacion, child: const Text('Nuevo código')),
          ),
          Semantics(
            label: 'Revocar la invitación de ${usuario['nombre']}',
            excludeSemantics: true,
            child: TextButton(onPressed: onRevocar, child: Text('Revocar', style: TextStyle(color: colorPeligro))),
          ),
        ],
      );
    }
    final activa = (usuario['estado_cuenta'] ?? 'activo') == 'activo';
    return Wrap(
      spacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        // el código de restablecer solo se genera para una cuenta activa (una desactivada se reactiva)
        if (activa)
          Semantics(
            label: 'Restablecer contraseña de ${usuario['nombre']}',
            excludeSemantics: true,
            child: TextButton(onPressed: onClave, child: const Text('Contraseña')),
          ),
        if (activa)
          TextButton(
            onPressed: onDesactivar,
            child: Text('Desactivar', style: TextStyle(color: colorPeligro)),
          )
        else
          TextButton(onPressed: onReactivar, child: const Text('Reactivar')),
      ],
    );
  }
}
