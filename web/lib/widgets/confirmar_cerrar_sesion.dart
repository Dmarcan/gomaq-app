import 'package:flutter/material.dart';
import '../services/auth_service.dart';

/// Cerrar sesión estaba a un clic, sin confirmación, junto a otros íconos de la barra.
Future<void> confirmarCerrarSesion(BuildContext context, AuthService auth) async {
  final confirmado = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('¿Cerrar sesión?'),
      content: const Text('Tendrás que ingresar de nuevo con tu correo y contraseña.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Cerrar sesión')),
      ],
    ),
  );
  if (confirmado == true) await auth.logout();
}
