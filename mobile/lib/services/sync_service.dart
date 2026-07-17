import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import 'api_client.dart';

/// Fallo que jamas va a resolverse reintentando (ej. el archivo local ya no existe):
/// la tarea pasa a error de inmediato con un mensaje entendible, sin quemar reintentos.
class ErrorPermanenteSync implements Exception {
  final String mensaje;
  ErrorPermanenteSync(this.mensaje);
  @override
  String toString() => mensaje;
}

class SyncService extends ChangeNotifier {
  bool _sincronizando = false;
  bool get sincronizando => _sincronizando;

  // true cuando el servidor rechazo el token (401/403): la cola queda pausada
  // sin consumir reintentos hasta que el mecanico vuelva a iniciar sesion
  bool _sesionExpirada = false;
  bool get sesionExpirada => _sesionExpirada;

  /// Llamar tras un login exitoso: limpia el aviso de sesion expirada aunque la
  /// cola este vacia (antes el banner quedaba pegado para siempre tras re-loguearse,
  /// porque solo se limpiaba cuando una tarea de la cola sincronizaba con exito).
  void reiniciarSesion() {
    if (_sesionExpirada) {
      _sesionExpirada = false;
      notifyListeners();
    }
  }

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
    // incluye tambien las tareas en error: no pueden quedar invisibles para el mecanico
    final result = await db.rawQuery(
      "SELECT COUNT(*) as n FROM cola_sincronizacion WHERE estado IN ('pendiente', 'error')",
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  Future<int> contarEnError() async {
    final db = await _db;
    final result = await db.rawQuery(
      "SELECT COUNT(*) as n FROM cola_sincronizacion WHERE estado = 'error'",
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  Future<List<Map<String, dynamic>>> tareasEnError() async {
    final db = await _db;
    return db.query('cola_sincronizacion', where: "estado = 'error'", orderBy: 'creado_en ASC');
  }

  /// Devuelve las tareas en error al estado pendiente (con reintentos en cero)
  /// y dispara una sincronizacion inmediata.
  Future<void> reintentarErrores() async {
    final db = await _db;
    await db.update(
      'cola_sincronizacion',
      {'intentos': 0, 'estado': 'pendiente', 'ultimo_error': null},
      where: "estado = 'error'",
    );
    notifyListeners();
    await sincronizar();
  }

  // ---------- Sincronizacion ----------

  Future<void> sincronizar() async {
    if (_sincronizando) return;
    _sincronizando = true;
    notifyListeners();
    try {
      await _push();
      await _pull();
      // el pull respondio autorizado: si habia un aviso de sesion expirada, ya no aplica
      reiniciarSesion();
      await _pullCatalogoInsumos();
    } finally {
      _sincronizando = false;
      notifyListeners();
    }
  }

  Future<void> _pull() async {
    final data = await ApiClient.instance.get('/api/ordenes-trabajo');
    final db = await _db;

    // OT con tareas aun pendientes o en error no se sobreescriben con la version
    // del servidor, para no perder el cambio local todavia sin sincronizar.
    final pendientesRows = await db.rawQuery(
      "SELECT DISTINCT orden_trabajo_id FROM cola_sincronizacion WHERE estado IN ('pendiente', 'error')",
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

  // Clasificacion de errores (practica estandar de colas offline-first):
  // - Errores de red/timeout: NO consumen reintentos (la tarea no fallo, no hubo red)
  //   y abortan el resto del push - se reintenta completo cuando vuelva la senal.
  // - 401/403: NO consumen reintentos; pausan la cola y marcan sesionExpirada para
  //   que la UI pida volver a iniciar sesion. El trabajo local queda intacto.
  // - Otros errores del servidor (rechazo real de negocio): consumen un reintento,
  //   y tras maxIntentos la tarea pasa a 'error' - visible en la UI con reintento manual.
  Future<void> _push() async {
    final db = await _db;
    const maxIntentos = 5;
    final pendientes = await db.query(
      'cola_sincronizacion',
      where: 'estado = ? AND intentos < ?',
      whereArgs: ['pendiente', maxIntentos],
      orderBy: 'creado_en ASC',
    );

    // OTs con una tarea rechazada en ESTE ciclo: sus tareas posteriores se saltan
    // para preservar el orden causal (ej. que "finalizar" no se ejecute si la
    // evidencia anterior de la misma OT fue rechazada) - quedan para el proximo push
    final otsConFallo = <int>{};

    for (final tarea in pendientes) {
      final otId = tarea['orden_trabajo_id'] as int;
      if (otsConFallo.contains(otId)) continue;
      try {
        await _ejecutarTarea(tarea);
        await db.delete('cola_sincronizacion', where: 'id = ?', whereArgs: [tarea['id']]);
        if (_sesionExpirada) {
          _sesionExpirada = false;
          notifyListeners();
        }
      } on SocketException {
        return; // sin red: abortar sin castigar la tarea
      } on TimeoutException {
        return;
      } on http.ClientException {
        return;
      } on ErrorPermanenteSync catch (err) {
        // irrecuperable (ej. foto borrada del telefono): a error de inmediato,
        // con mensaje entendible, sin quemar reintentos que no sirven
        otsConFallo.add(otId);
        await db.update(
          'cola_sincronizacion',
          {'intentos': maxIntentos, 'ultimo_error': err.mensaje, 'estado': 'error'},
          where: 'id = ?',
          whereArgs: [tarea['id']],
        );
      } on ApiException catch (err) {
        if (err.statusCode == 401 || err.statusCode == 403) {
          _sesionExpirada = true;
          notifyListeners();
          return; // token invalido: pausar toda la cola sin consumir reintentos
        }
        otsConFallo.add(otId);
        final intentos = (tarea['intentos'] as int) + 1;
        await db.update(
          'cola_sincronizacion',
          {
            'intentos': intentos,
            'ultimo_error': err.message,
            'estado': intentos >= maxIntentos ? 'error' : 'pendiente',
          },
          where: 'id = ?',
          whereArgs: [tarea['id']],
        );
      } catch (err) {
        otsConFallo.add(otId);
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
    if (!await archivo.exists()) {
      throw ErrorPermanenteSync('La foto ya no esta en el telefono (fue borrada o se limpiaron los datos de la app)');
    }
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
