import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import 'dialogos.dart';

/// Cerrar sesión estaba a un clic, sin confirmación, junto a otros íconos de la barra.
///
/// Ofrece cerrar solo este equipo o todos los dispositivos de la cuenta (por si se perdió un teléfono o
/// se dejó la sesión abierta en un computador ajeno).
Future<void> confirmarCerrarSesion(BuildContext context, AuthService auth) async {
  final opcion = await showDialog<_OpcionCierre>(
    context: context,
    builder: (dialogContext) => CuadroDialogo(
      icono: Icons.logout,
      titulo: '¿Cerrar sesión?',
      ancho: 420,
      cuerpo: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'Tendrás que ingresar de nuevo con tu correo y contraseña.',
            style: TextStyle(fontSize: 14, height: 1.4),
          ),
          const SizedBox(height: 12),
          const Text(
            '¿Dejaste tu sesión abierta en otro equipo o perdiste un teléfono?',
            style: TextStyle(fontSize: 13, color: Colors.black54, height: 1.4),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => Navigator.of(dialogContext).pop(_OpcionCierre.todos),
              icon: const Icon(Icons.devices_other, size: 18),
              label: const Text('Cerrar sesión en todos los dispositivos'),
            ),
          ),
        ],
      ),
      acciones: [
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Cancelar')),
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(_OpcionCierre.este),
          child: const Text('Cerrar sesión'),
        ),
      ],
    ),
  );
  if (opcion == null) return;
  await auth.cerrarSesion(todosLosDispositivos: opcion == _OpcionCierre.todos);
}

enum _OpcionCierre { este, todos }
