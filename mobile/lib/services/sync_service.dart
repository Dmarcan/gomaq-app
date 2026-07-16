import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import 'api_client.dart';

class SyncService extends ChangeNotifier {
  bool _sincronizando = false;
  bool get sincronizando => _sincronizando;

  Future<Database> get _db async => LocalDatabase.instance.database;

  // ---------- Encolar acciones del mecanico (siempre escriben local primero) ----------

  Future<void> encolarDiagnostico(int ordenId, {String? diagnostico, String? estado}) async {
    final db = await _db;
    await db.update(
      'ordenes_locales',
      {
        if (diagnostico != null) 'diagnostico': diagnostico,
        if (estado != null) 'estado': estado,
        'actualizado_en': DateTime.now().toIso8601String(),
      },
      where: 'id = ?',
      whereArgs: [ordenId],
    );
    await _encolar(ordenId, 'diagnostico', {
      if (diagnostico != null) 'diagnostico': diagnostico,
      if (estado != null) 'estado': estado,
    });
    notifyListeners();
  }

  Future<void> encolarFinalizar(int ordenId, {bool facturable = false}) async {
    final db = await _db;
    await db.update(
      'ordenes_locales',
      {'estado': 'finalizada', 'facturable': facturable ? 1 : 0, 'actualizado_en': DateTime.now().toIso8601String()},
      where: 'id = ?',
      whereArgs: [ordenId],
    );
    await _encolar(ordenId, 'finalizar', {'facturable': facturable});
    notifyListeners();
  }

  Future<void> encolarEvidencia(int ordenId, String rutaLocal) async {
    final db = await _db;
    final evidenciaId = await db.insert('evidencias_locales', {
      'orden_trabajo_id': ordenId,
      'ruta_local': rutaLocal,
      'sincronizado': 0,
      'creado_en': DateTime.now().toIso8601String(),
    });
    await _encolar(ordenId, 'evidencia', {'evidencia_local_id': evidenciaId, 'ruta_local': rutaLocal});
    notifyListeners();
  }

  Future<void> encolarInsumo(int ordenId, int insumoId, String insumoNombre, double cantidad) async {
    final db = await _db;
    final insumoLocalId = await db.insert('insumos_locales', {
      'orden_trabajo_id': ordenId,
      'insumo_id': insumoId,
      'insumo_nombre': insumoNombre,
      'cantidad': cantidad,
      'sincronizado': 0,
      'creado_en': DateTime.now().toIso8601String(),
    });
    await _encolar(ordenId, 'insumo', {
      'insumo_local_id': insumoLocalId,
      'insumo_id': insumoId,
      'cantidad': cantidad,
    });
    notifyListeners();
  }

  Future<void> _encolar(int ordenId, String tipo, Map<String, dynamic> payload) async {
    final db = await _db;
    await db.insert('cola_sincronizacion', {
      'tipo': tipo,
      'orden_trabajo_id': ordenId,
      'payload': jsonEncode(payload),
      'estado': 'pendiente',
      'intentos': 0,
      'creado_en': DateTime.now().toIso8601String(),
    });
  }

  Future<int> contarPendientes() async {
    final db = await _db;
    final result = await db.rawQuery(
      "SELECT COUNT(*) as n FROM cola_sincronizacion WHERE estado = 'pendiente'",
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  // ---------- Sincronizacion ----------

  Future<void> sincronizar() async {
    if (_sincronizando) return;
    _sincronizando = true;
    notifyListeners();
    try {
      await _push();
      await _pull();
      await _pullCatalogoInsumos();
    } finally {
      _sincronizando = false;
      notifyListeners();
    }
  }

  Future<void> _pull() async {
    final data = await ApiClient.instance.get('/api/ordenes-trabajo');
    final db = await _db;

    // OT con tareas aun pendientes (ej. porque el push fallo) no se sobreescriben
    // con la version del servidor, para no perder el cambio local todavia sin sincronizar.
    final pendientesRows = await db.rawQuery(
      "SELECT DISTINCT orden_trabajo_id FROM cola_sincronizacion WHERE estado = 'pendiente'",
    );
    final idsConPendientes = pendientesRows.map((r) => r['orden_trabajo_id'] as int).toSet();

    for (final item in (data as List)) {
      final orden = OrdenTrabajo.fromApiJson(item);
      if (idsConPendientes.contains(orden.id)) continue;
      await db.insert('ordenes_locales', orden.toLocalMap(), conflictAlgorithm: ConflictAlgorithm.replace);
    }
  }

  Future<void> _pullCatalogoInsumos() async {
    final data = await ApiClient.instance.get('/api/insumos');
    final db = await _db;
    for (final item in (data as List)) {
      await db.insert(
        'insumos_catalogo_local',
        {'id': item['id'], 'nombre': item['nombre'], 'unidad_medida': item['unidad_medida']},
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
  }

  Future<void> _push() async {
    final db = await _db;
    const maxIntentos = 5;
    final pendientes = await db.query(
      'cola_sincronizacion',
      where: 'estado = ? AND intentos < ?',
      whereArgs: ['pendiente', maxIntentos],
      orderBy: 'creado_en ASC',
    );

    for (final tarea in pendientes) {
      try {
        await _ejecutarTarea(tarea);
        await db.delete('cola_sincronizacion', where: 'id = ?', whereArgs: [tarea['id']]);
      } catch (err) {
        final intentos = (tarea['intentos'] as int) + 1;
        await db.update(
          'cola_sincronizacion',
          {
            'intentos': intentos,
            'ultimo_error': err.toString(),
            'estado': intentos >= maxIntentos ? 'error' : 'pendiente',
          },
          where: 'id = ?',
          whereArgs: [tarea['id']],
        );
      }
    }
  }

  Future<void> _ejecutarTarea(Map<String, dynamic> tarea) async {
    final tipo = tarea['tipo'] as String;
    final ordenId = tarea['orden_trabajo_id'] as int;
    final payload = jsonDecode(tarea['payload'] as String) as Map<String, dynamic>;

    switch (tipo) {
      case 'diagnostico':
        await ApiClient.instance.patch('/api/ordenes-trabajo/$ordenId/diagnostico', payload);
        break;
      case 'finalizar':
        await ApiClient.instance.patch('/api/ordenes-trabajo/$ordenId/finalizar', payload);
        break;
      case 'evidencia':
        await _subirEvidencia(ordenId, payload);
        break;
      case 'insumo':
        await _registrarInsumo(ordenId, payload);
        break;
      default:
        throw Exception('Tipo de tarea desconocido: $tipo');
    }
  }

  Future<void> _subirEvidencia(int ordenId, Map<String, dynamic> payload) async {
    final rutaLocal = payload['ruta_local'] as String;
    final archivo = File(rutaLocal);
    final nombreArchivo = rutaLocal.split(Platform.pathSeparator).last;

    final solicitud = await ApiClient.instance.post(
      '/api/ordenes-trabajo/$ordenId/evidencia/solicitar-upload',
      {'nombre_archivo': nombreArchivo},
    );

    final signedUrl = solicitud['signedUrl'] as String;
    final resp = await http
        .put(
          Uri.parse(signedUrl),
          headers: {'Content-Type': 'image/jpeg'},
          body: await archivo.readAsBytes(),
        )
        .timeout(const Duration(seconds: 20));
    if (resp.statusCode >= 300) {
      throw Exception('Fallo la subida a Supabase Storage: ${resp.statusCode}');
    }

    await ApiClient.instance.post(
      '/api/ordenes-trabajo/$ordenId/evidencia/confirmar',
      {'path': solicitud['path']},
    );

    final db = await _db;
    final evidenciaLocalId = payload['evidencia_local_id'];
    if (evidenciaLocalId != null) {
      await db.update(
        'evidencias_locales',
        {'sincronizado': 1},
        where: 'id = ?',
        whereArgs: [evidenciaLocalId],
      );
    }
  }

  Future<void> _registrarInsumo(int ordenId, Map<String, dynamic> payload) async {
    await ApiClient.instance.post('/api/insumos/orden/$ordenId', {
      'insumo_id': payload['insumo_id'],
      'cantidad': payload['cantidad'],
    });

    final db = await _db;
    final insumoLocalId = payload['insumo_local_id'];
    if (insumoLocalId != null) {
      await db.update(
        'insumos_locales',
        {'sincronizado': 1},
        where: 'id = ?',
        whereArgs: [insumoLocalId],
      );
    }
  }
}
