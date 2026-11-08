import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../utils/formato.dart';

/// Última lectura de horómetro del equipo, o null si no tiene o no se pudo consultar.
Future<num?> _ultimaLectura(int maquinariaId) async {
  try {
    final equipo = await ApiClient.instance.get('/api/maquinarias/$maquinariaId');
    final mantencion = equipo is Map ? equipo['mantencion'] : null;
    final ultima = mantencion is Map ? mantencion['ultima_lectura'] : null;
    return ultima is num ? ultima : num.tryParse('${ultima ?? ''}');
  } catch (_) {
    // sin dato no se bloquea: el servidor sigue aceptando la lectura
    return null;
  }
}

/// Un horómetro no baja, salvo que lo hayan cambiado: un error de tipeo (25 en vez de 250)
/// escondería una mantención. Si [valor] es menor que la última lectura del equipo, pregunta antes
/// de guardar. Devuelve true si se puede seguir. [leerUltima] existe para las pruebas.
Future<bool> confirmarHorometroMenor(
  BuildContext context, {
  required int maquinariaId,
  required num? valor,
  Future<num?> Function(int maquinariaId)? leerUltima,
}) async {
  if (valor == null) return true;
  final anterior = await (leerUltima ?? _ultimaLectura)(maquinariaId);
  if (anterior == null || valor >= anterior) return true;
  if (!context.mounted) return false;
  final seguir = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('La lectura es menor'),
      content: Text('Es menor que la última registrada (${Formato.medida(anterior, 'h')}). ¿Guardarla de todos modos?'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Revisar')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Guardar igual')),
      ],
    ),
  );
  return seguir == true;
}
