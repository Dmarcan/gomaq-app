import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import 'dialogos.dart';

/// Cerrar sesión estaba a un clic, sin confirmación, junto a otros íconos de la barra.
Future<void> confirmarCerrarSesion(BuildContext context, AuthService auth) async {
  final confirmado = await mostrarConfirmacion(
    context,
    icono: Icons.logout,
    titulo: '¿Cerrar sesión?',
    mensaje: 'Tendrás que ingresar de nuevo con tu correo y contraseña.',
    textoAccion: 'Cerrar sesión',
  );
  if (confirmado) await auth.logout();
}
