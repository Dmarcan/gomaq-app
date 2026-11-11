import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../utils/validadores_acceso.dart';
import 'dialogos.dart';

/// "Cambiar mi contraseña" con la sesión iniciada. Pide la actual; las demás sesiones de la cuenta se
/// cierran y esta sigue abierta (el servidor entrega un token nuevo).
Future<void> mostrarCambiarMiClave(BuildContext context) async {
  final auth = context.read<AuthService>();
  final actualCtrl = TextEditingController();
  final nuevaCtrl = TextEditingController();
  final repetirCtrl = TextEditingController();
  final hecho = await mostrarFormulario(
    context,
    icono: Icons.password,
    titulo: 'Cambiar mi contraseña',
    subtitulo: auth.nombre,
    textoAccion: 'Cambiar contraseña',
    ancho: 420,
    contenido: (context, redibujar) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Las sesiones abiertas en otros equipos se cierran; en este sigues conectado.',
          style: TextStyle(fontSize: 13, color: Colors.black54),
        ),
        separadorCampos,
        TextFormField(
          controller: actualCtrl,
          autofocus: true,
          obscureText: true,
          autofillHints: const [AutofillHints.password],
          decoration: decoracionCampo('Contraseña actual *'),
          validator: (v) => (v == null || v.isEmpty) ? 'Escribe tu contraseña actual.' : null,
        ),
        separadorCampos,
        TextFormField(
          controller: nuevaCtrl,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: decoracionCampo('Contraseña nueva *', ayuda: 'Mínimo $largoMinimoPassword caracteres.'),
          validator: (v) {
            final error = validarPasswordNueva(v);
            if (error != null) return error;
            return v == actualCtrl.text ? 'Debe ser distinta de la actual.' : null;
          },
        ),
        separadorCampos,
        TextFormField(
          controller: repetirCtrl,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: decoracionCampo('Repetir contraseña nueva *'),
          validator: (v) => validarConfirmacion(v, nuevaCtrl.text),
        ),
      ],
    ),
    alGuardar: () => auth.cambiarPassword(actualCtrl.text, nuevaCtrl.text),
  );
  actualCtrl.dispose();
  nuevaCtrl.dispose();
  repetirCtrl.dispose();
  if (hecho && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Contraseña cambiada')));
  }
}
