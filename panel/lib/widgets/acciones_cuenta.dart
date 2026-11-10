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
/// contraseña ni desactivar: queda el texto "(tu cuenta)".
class AccionesCuentaEquipo extends StatelessWidget {
  final Map<String, dynamic> usuario;
  final bool esPropia;
  final VoidCallback onClave;
  final VoidCallback onDesactivar;
  final VoidCallback onReactivar;

  const AccionesCuentaEquipo({
    super.key,
    required this.usuario,
    required this.esPropia,
    required this.onClave,
    required this.onDesactivar,
    required this.onReactivar,
  });

  @override
  Widget build(BuildContext context) {
    if (esPropia) {
      return const Text('(tu cuenta)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.black87));
    }
    final activa = (usuario['estado_cuenta'] ?? 'activo') == 'activo';
    return Wrap(
      spacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Semantics(
          label: 'Restablecer contraseña de ${usuario['nombre']}',
          excludeSemantics: true,
          child: TextButton(onPressed: onClave, child: const Text('Contraseña')),
        ),
        if (activa)
          TextButton(
            onPressed: onDesactivar,
            child: Text('Desactivar', style: TextStyle(color: Theme.of(context).colorScheme.error)),
          )
        else
          TextButton(onPressed: onReactivar, child: const Text('Reactivar')),
      ],
    );
  }
}
