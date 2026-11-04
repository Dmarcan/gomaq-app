import 'package:flutter/material.dart';
import '../utils/motivo_cambio.dart';
import 'dialogos.dart';

/// Pide el motivo de un cambio a una orden cerrada y hace el envío dentro del mismo cuadro.
///
/// Se usa cuando la orden ya está cerrada: el servidor exige un motivo (una opción de la lista y
/// una explicación de al menos 10 caracteres) y deja el cambio en el historial de la orden. Los
/// avisos salen en cada campo; mientras se envía el botón queda deshabilitado, y si el servidor
/// rechaza el cambio (400 o 409) su mensaje queda dentro del cuadro con lo escrito intacto.
///
/// [alEnviar] recibe `motivo_codigo` y `motivo` listos para sumar al cuerpo de la llamada y debe
/// lanzar [ApiException] si el servidor lo rechaza. Devuelve `true` si el cambio se hizo.
Future<bool> mostrarCambioConMotivo(
  BuildContext context, {
  required String titulo,
  required String resumen,
  String subtitulo = 'La orden está cerrada: el cambio exige un motivo',
  required String textoAccion,
  required Future<void> Function(Map<String, String> motivo) alEnviar,
}) {
  String? codigo;
  final texto = TextEditingController();
  return mostrarFormulario(
    context,
    icono: Icons.edit_note,
    titulo: titulo,
    subtitulo: subtitulo,
    textoAccion: textoAccion,
    contenido: (context, redibujar) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(resumen, style: const TextStyle(fontSize: 14, height: 1.4)),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(
          isExpanded: true,
          initialValue: codigo,
          decoration: decoracionCampo('Motivo', obligatorio: true),
          items: [for (final m in motivosCambio) DropdownMenuItem(value: m.codigo, child: Text(m.etiqueta))],
          validator: validarCodigoMotivo,
          autovalidateMode: AutovalidateMode.onUserInteraction,
          onChanged: (v) => redibujar(() => codigo = v),
        ),
        separadorCampos,
        TextFormField(
          controller: texto,
          minLines: 2,
          maxLines: 4,
          maxLength: 500,
          textCapitalization: TextCapitalization.sentences,
          decoration: decoracionCampo('Explicación', obligatorio: true, ayuda: 'Al menos $minCaracteresMotivo caracteres.'),
          validator: validarTextoMotivo,
          autovalidateMode: AutovalidateMode.onUserInteraction,
        ),
      ],
    ),
    alGuardar: () => alEnviar({'motivo_codigo': codigo!, 'motivo': texto.text.trim()}),
  );
}
