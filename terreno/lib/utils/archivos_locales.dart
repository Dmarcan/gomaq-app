import 'dart:io';

import 'package:sqflite/sqflite.dart';

/// Fotos de evidencia (`ot<id>_<ms>.jpg`) y firmas de recepcion (`ot<id>_firma_<ms>.png`) que la app guarda
/// en la carpeta de documentos. El id puede ser negativo (OT creada en terreno sin senal).
final _nombreArchivoDeTrabajo = RegExp(r'^ot-?\d+_(firma_)?\d+\.(jpg|png)$');

/// Borra un archivo local de mejor esfuerzo. Nunca lanza: si no existe o no se puede borrar, la tarea
/// que lo pidio no debe fallar por eso (el archivo ya no hace falta). Devuelve si lo borro.
Future<bool> borrarArchivoLocal(String? ruta) async {
  if (ruta == null || ruta.isEmpty) return false;
  try {
    final archivo = File(ruta);
    if (!await archivo.exists()) return false;
    await archivo.delete();
    return true;
  } catch (_) {
    return false;
  }
}

/// Al cerrar sesion: borra las fotos y firmas guardadas en [carpeta] SOLO si la cola de sincronizacion
/// esta completamente vacia (ni pendientes ni en error). Con cualquier tarea en la cola no borra nada:
/// esos archivos pueden ser trabajo del mecanico todavia sin enviar.
///
/// Con la cola vacia, todo lo que se subio ya se borro al confirmarse; lo que queda son restos (fotos de
/// versiones anteriores, tareas descartadas). Se identifican por el patron del nombre y no por las filas
/// de `evidencias_locales`, porque las firmas no tienen fila. Las filas se conservan: la lista de
/// evidencias de cada OT sigue mostrando la foto como enviada. Devuelve cuantos archivos borro.
Future<int> limpiarArchivosLocalesSiColaVacia(Database db, Directory carpeta) async {
  final enCola = Sqflite.firstIntValue(await db.rawQuery('SELECT COUNT(*) FROM cola_sincronizacion')) ?? 0;
  if (enCola > 0) return 0;
  if (!await carpeta.exists()) return 0;
  var borrados = 0;
  await for (final entrada in carpeta.list(followLinks: false)) {
    if (entrada is! File) continue;
    final nombre = entrada.uri.pathSegments.last;
    if (!_nombreArchivoDeTrabajo.hasMatch(nombre)) continue;
    if (await borrarArchivoLocal(entrada.path)) borrados++;
  }
  return borrados;
}
