import 'package:flutter/material.dart';
import '../db/local_database.dart';
import 'dialogo_texto.dart';

/// Ultima lectura de horometro que el telefono conoce de un equipo, o null si no hay ninguna.
Future<double?> ultimaLecturaLocal(int maquinariaId) async {
  final db = await LocalDatabase.instance.database;
  final filas = await db.query(
    'horometro_local',
    where: 'maquinaria_id = ?',
    whereArgs: [maquinariaId],
    orderBy: 'fecha DESC',
    limit: 1,
  );
  return filas.isEmpty ? null : (filas.first['valor'] as num?)?.toDouble();
}

String _formatoHoras(double h) => h.toStringAsFixed(h % 1 == 0 ? 0 : 1);

/// Pide la lectura actual del horometro de un equipo. Muestra la ultima conocida y, si la nueva es
/// menor, pregunta antes de aceptarla (un horometro no baja, salvo que lo hayan cambiado).
/// Devuelve las horas, o null si se cancela o no se ingresa un valor valido.
Future<double?> pedirLecturaHorometro(
  BuildContext context, {
  required String codigo,
  required int maquinariaId,
}) async {
  final ultima = await ultimaLecturaLocal(maquinariaId);
  if (!context.mounted) return null;

  final texto = await pedirTexto(
    context,
    titulo: 'Horómetro de $codigo',
    etiqueta: 'Lectura actual',
    sufijo: 'h',
    numerico: true,
    ayuda: ultima == null ? null : 'Última lectura registrada: ${_formatoHoras(ultima)} h',
  );
  if (texto == null || !context.mounted) return null;
  final valor = double.tryParse(texto.trim().replaceAll(',', '.'));
  if (valor == null || valor < 0) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ingresa una lectura válida')));
    return null;
  }
  if (ultima != null && valor < ultima) {
    final seguir = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('La lectura es menor'),
        content: Text('Es menor que la última registrada (${_formatoHoras(ultima)} h). ¿Guardarla de todos modos?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Revisar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Guardar igual')),
        ],
      ),
    );
    if (seguir != true) return null;
  }
  return valor;
}

String formatoHoras(double h) => _formatoHoras(h);
