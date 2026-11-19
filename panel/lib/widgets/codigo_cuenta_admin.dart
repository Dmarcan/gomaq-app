import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import '../theme/gomaq_theme.dart';
import 'dialogos.dart';

/// Cómo le llega a la persona el código de su invitación o de restablecer la contraseña: por correo o en
/// un mensaje que quien administra copia y manda a mano (por el medio que prefiera). El correo se deshabilita
/// si el servidor no puede enviarlo (sin clave de Resend o con el remitente de pruebas).
class SelectorCanalCodigo extends StatelessWidget {
  final String canal;
  final bool correoDisponible;
  final String? motivoSinCorreo;
  final ValueChanged<String> alCambiar;

  const SelectorCanalCodigo({
    super.key,
    required this.canal,
    required this.correoDisponible,
    required this.motivoSinCorreo,
    required this.alCambiar,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: const Text('¿Cómo le llega el código?', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        ),
        const SizedBox(height: 6),
        SegmentedButton<String>(
          segments: [
            const ButtonSegment(value: 'manual', label: Text('Copiar mensaje'), icon: Icon(Icons.content_copy, size: 18)),
            ButtonSegment(
              value: 'correo',
              label: const Text('Enviar por correo'),
              icon: const Icon(Icons.email_outlined, size: 18),
              enabled: correoDisponible,
            ),
          ],
          selected: {canal},
          onSelectionChanged: (s) => alCambiar(s.first),
        ),
        const SizedBox(height: 6),
        Text(
          canal == 'manual'
              ? 'Verás un mensaje con el código para copiarlo y enviarlo por mensaje o correo. Se muestra una sola vez. '
                  'Sirve también si la persona no tiene un correo real.'
              : 'Se envía al correo de acceso de la cuenta.',
          style: const TextStyle(fontSize: 12, color: Colors.black54),
        ),
        if (!correoDisponible)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              'Envío por correo no disponible: ${motivoSinCorreo ?? 'falta configurarlo.'}',
              style: const TextStyle(fontSize: 12, color: GomaqColors.advertenciaFuerte),
            ),
          ),
      ],
    );
  }
}

/// Muestra UNA vez el mensaje con el código para que quien administra lo copie y lo envíe. El servidor
/// guarda solo el HMAC del código: cerrado este cuadro, no hay forma de volver a verlo.
Future<void> mostrarMensajeParaCopiar(BuildContext context, {required String titulo, required String mensaje}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => _MensajeParaCopiar(titulo: titulo, mensaje: mensaje),
  );
}

class _MensajeParaCopiar extends StatefulWidget {
  final String titulo;
  final String mensaje;
  const _MensajeParaCopiar({required this.titulo, required this.mensaje});

  @override
  State<_MensajeParaCopiar> createState() => _MensajeParaCopiarState();
}

class _MensajeParaCopiarState extends State<_MensajeParaCopiar> {
  bool _copiado = false;

  Future<void> _copiar() async {
    await Clipboard.setData(ClipboardData(text: widget.mensaje));
    if (mounted) setState(() => _copiado = true);
  }

  @override
  Widget build(BuildContext context) {
    return CuadroDialogo(
      icono: Icons.forward_to_inbox,
      titulo: widget.titulo,
      ancho: 500,
      cerrable: false,
      cuerpo: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'Cópialo y envíaselo a la persona. Este mensaje no se vuelve a mostrar: si se pierde, genera un código nuevo. '
            'No lo reenvíes a nadie más: con el código se elige la contraseña de la cuenta.',
            style: TextStyle(fontSize: 13, color: GomaqColors.advertenciaFuerte, height: 1.4),
          ),
          separadorCampos,
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: GomaqColors.fondoCalido,
              border: Border.all(color: Colors.black26),
              borderRadius: BorderRadius.circular(8),
            ),
            child: SelectableText(widget.mensaje, style: const TextStyle(fontSize: 13, height: 1.4)),
          ),
          if (_copiado)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Semantics(
                liveRegion: true,
                child: const Text('Mensaje copiado', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              ),
            ),
        ],
      ),
      acciones: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Listo')),
        FilledButton.icon(
          onPressed: _copiar,
          icon: const Icon(Icons.content_copy, size: 18),
          label: Text(_copiado ? 'Copiar de nuevo' : 'Copiar mensaje'),
        ),
      ],
    );
  }
}
