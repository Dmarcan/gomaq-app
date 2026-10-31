import 'package:flutter/material.dart';

/// Pide un texto en un diálogo y devuelve lo escrito, o null si se cancela.
///
/// El controlador del campo vive dentro del diálogo y se libera cuando este desaparece. Crearlo
/// afuera y liberarlo apenas el diálogo devuelve su resultado (patrón que había antes) rompe en
/// depuración: el diálogo todavía se está animando hacia afuera y su campo sigue usando el
/// controlador ya liberado, lo que deja el árbol de widgets en un estado inconsistente.
Future<String?> pedirTexto(
  BuildContext context, {
  required String titulo,
  required String etiqueta,
  String? ayuda,
  String? sufijo,
  bool numerico = false,
  String confirmar = 'Guardar',
}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _DialogoTexto(
      titulo: titulo,
      etiqueta: etiqueta,
      ayuda: ayuda,
      sufijo: sufijo,
      numerico: numerico,
      confirmar: confirmar,
    ),
  );
}

class _DialogoTexto extends StatefulWidget {
  final String titulo;
  final String etiqueta;
  final String? ayuda;
  final String? sufijo;
  final bool numerico;
  final String confirmar;

  const _DialogoTexto({
    required this.titulo,
    required this.etiqueta,
    required this.ayuda,
    required this.sufijo,
    required this.numerico,
    required this.confirmar,
  });

  @override
  State<_DialogoTexto> createState() => _DialogoTextoState();
}

class _DialogoTextoState extends State<_DialogoTexto> {
  final _ctrl = TextEditingController();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.titulo),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (widget.ayuda != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(widget.ayuda!, style: const TextStyle(fontSize: 12)),
            ),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: widget.numerico ? const TextInputType.numberWithOptions(decimal: true) : TextInputType.text,
            decoration: InputDecoration(labelText: widget.etiqueta, suffixText: widget.sufijo),
            onSubmitted: (_) => Navigator.pop(context, _ctrl.text),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(context, _ctrl.text), child: Text(widget.confirmar)),
      ],
    );
  }
}
