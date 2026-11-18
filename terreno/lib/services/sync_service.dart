import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../utils/archivos_locales.dart';
import '../utils/cuerpo_cierre.dart';
import '../utils/fallo_sync.dart';
import '../utils/pasadas_en_serie.dart';
import '../utils/uuid.dart';
import 'api_client.dart';

export '../utils/fallo_sync.dart' show ErrorPermanenteSync;

class SyncService extends ChangeNotifier {
  /// Sin argumentos usa la base local y el cliente HTTP reales. Los parametros son para las pruebas
  /// (base en memoria, cliente falso, subida de archivos falsa).
  SyncService({
    ApiCola? api,
    Future<Database> Function()? abrirBase,
    http.Client? clienteHttp,
  })  : _api = _ApiVerificada(api ?? ApiClient.instance),
        _abrirBase = abrirBase,
        _http = clienteHttp ?? http.Client();

  final ApiCola _api;
  final Future<Database> Function()? _abrirBase;
  final http.Client _http;

  late final PasadasEnSerie _pasadas = PasadasEnSerie(pasada: _pasada, alCambiar: notifyListeners);
  bool get sincronizando => _pasadas.enCurso;

  // true cuando el servidor rechazo el token (401/403): la cola queda pausada
  // sin consumir reintentos hasta que el mecanico vuelva a iniciar sesion
  bool _sesionExpirada = false;
  bool get sesionExpirada => _sesionExpirada;

  /// Llamar tras un login exitoso: limpia el aviso de sesion expirada aunque la cola este vacia
  /// (solo se limpiaba cuando una tarea sincronizaba con exito).
  void reiniciarSesion() {
    if (_sesionExpirada) {
      _sesionExpirada = false;
      notifyListeners();
    }
  }

  // Cuando termino la ultima sincronizacion completa de esta sesion de la app. Los catalogos
  // (repuestos, checklist, flota) y el historial de equipos cambian poco y bajarlos cuesta decenas
  // de peticiones: se refrescan al abrir la app y despues cada _vigenciaCompleta, no en cada
  // toque. Vive en memoria: tras reiniciar la app la primera sincronizacion vuelve a ser completa.
  DateTime? _ultimaCompleta;
  static const _vigenciaCompleta = Duration(hours: 6);

  DateTime? _ultimaSincronizacion;
  /// Cuando se completo la ultima sincronizacion (null si aun no hubo ninguna en esta sesion).
  DateTime? get ultimaSincronizacion => _ultimaSincronizacion;

  // id local (negativo) -> id real de las OT creadas en terreno que ya se sincronizaron. La
  // pantalla de una OT recien creada sigue abierta cuando la cola le asigna su id real: sin esto
  // seguiria operando con el id local, que ya no existe, y todo lo que el mecanico hiciera ahi
  // quedaria huerfano en la cola.
  final Map<int, int> _remapeos = {};

  /// El id con el que hay que operar una OT: el real si la creada en terreno ya se sincronizo.
  int resolverIdOrden(int id) => _remapeos[id] ?? id;

  Future<Database> get _db async => _abrirBase != null ? _abrirBase() : LocalDatabase.instance.database;

  /// [posicion] solo se manda al pasar a en camino (ver cuerpoPosicion): viaja dentro de la misma tarea
  /// para que el servidor la guarde unicamente si ese cambio de estado se aplico. Si la tarea llega
  /// tarde, el servidor descarta una posicion vieja sin hacer fallar el cambio de estado.
  Future<void> encolarDiagnostico(int ordenId, {String? diagnostico, String? estado, Map<String, dynamic>? posicion}) async {
    ordenId = resolverIdOrden(ordenId);
    final db = await _db;
    // cambio local y tarea en la misma transaccion: si la app muere entre ambos, no queda uno sin el otro
    await db.transaction((txn) async {
      await txn.update(
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
        // hora real del toque: la cola puede enviarlo mucho despues, y el servidor registra cuando
        // se acepto, salio o llego (no cuando por fin hubo senal)
        if (estado != null) 'ocurrio_en': DateTime.now().toUtc().toIso8601String(),
        'posicion': ?posicion,
      }, ejecutor: txn);
    });
    notifyListeners();
  }

  /// Cierra la OT. La marca `facturable` es por linea de repuesto en el talonario y el backend la
  /// deriva de ahi (ver utils/facturableOt.js).
  Future<void> encolarFinalizar(
    int ordenId, {
    String? personaRecibe,
    bool sinPersona = false,
    String? rutaFirmaLocal,
    required String estadoEquipo,
  }) async {
    if (estadoEquipo != estadoEquipoOperativo && estadoEquipo != estadoEquipoFueraDeServicio) {
      throw ArgumentError.value(estadoEquipo, 'estadoEquipo', 'debe ser operativa o fuera_de_servicio');
    }
    ordenId = resolverIdOrden(ordenId);
    final db = await _db;
    // las escrituras van juntas: si se corta a la mitad no queda la OT finalizada sin su tarea de
    // cierre en la cola (y el uuid de la tarea se genera una sola vez, dentro de _encolar)
    await db.transaction((txn) async {
      await txn.update(
        'ordenes_locales',
        {'estado': 'finalizada', 'actualizado_en': DateTime.now().toIso8601String()},
        where: 'id = ?',
        whereArgs: [ordenId],
      );
      await _encolar(ordenId, 'finalizar', {
        if (personaRecibe != null) 'persona_recibe': personaRecibe,
        'sin_persona': sinPersona,
        if (rutaFirmaLocal != null) 'ruta_firma_local': rutaFirmaLocal,
        // como queda el equipo y la hora real del cierre: la cola puede enviarlo mucho despues, y el
        // historial registra cuando se cerro, no cuando hubo senal. Si la tarea la encolo una version
        // anterior no trae hora y se usa creado_en, que se guarda en la hora LOCAL del telefono sin
        // zona: es correcta mientras el telefono no cambie de zona horaria entre el cierre y el envio.
        'estado_equipo': estadoEquipo,
        'ocurrio_en': DateTime.now().toUtc().toIso8601String(),
      }, ejecutor: txn);
      // Flota muestra el estado sin senal. Solo el caso fuera de servicio se refleja: con "operativo"
      // el servidor puede mantener la mantencion por otra OT abierta o por un cambio del panel, asi
      // que ahi manda lo que responda al sincronizar.
      if (estadoEquipo == estadoEquipoFueraDeServicio) {
        await txn.update('maquinarias_local', {'estado': estadoEquipoFueraDeServicio},
            where: 'id = (SELECT maquinaria_id FROM ordenes_locales WHERE id = ?)', whereArgs: [ordenId]);
      }
    });
    notifyListeners();
  }

  /// Abre una OT para un segundo equipo intervenido en la misma visita. Devuelve el id LOCAL
  /// (negativo) con el que la OT vive hasta sincronizar. Se usa un negativo derivado del reloj para
  /// que no choque nunca con un id del servidor, y para que dos OT creadas sin senal no se pisen
  /// entre si. En milisegundos: con segundos, dos OT creadas en el mismo segundo chocarian en la
  /// clave primaria.
  Future<int> encolarOtEnTerreno({required int maquinariaId, required String maquinariaCodigo, String? motivo}) async {
    final db = await _db;
    final idLocal = -DateTime.now().millisecondsSinceEpoch;
    await db.transaction((txn) async {
      await txn.insert('ordenes_locales', {
        'id': idLocal,
        'maquinaria_id': maquinariaId,
        'maquinaria_codigo': maquinariaCodigo,
        'motivo': motivo,
        'estado': 'en_terreno',
        'facturable': 0,
        'fecha_creacion': DateTime.now().toIso8601String(),
        'actualizado_en': DateTime.now().toIso8601String(),
      });
      // primera tarea de la OT: la cola procesa por id, asi que corre antes que sus hijas
      await _encolar(idLocal, 'crear_ot', {
        'maquinaria_id': maquinariaId,
        if (motivo != null && motivo.isNotEmpty) 'motivo': motivo,
      }, ejecutor: txn);
    });
    notifyListeners();
    return idLocal;
  }

  /// Cabecera de la OT tal como esta en el talonario: tipo de servicio, observaciones
  /// iniciales y finales, y el folio del papel. Se guarda local primero, como todo lo demas.
  Future<void> encolarDatosOt(
    int ordenId, {
    String? tipoServicio,
    String? diagnostico,
    String? observacionFinal,
    String? folioPapel,
  }) async {
    ordenId = resolverIdOrden(ordenId);
    final db = await _db;
    await db.transaction((txn) async {
      await txn.update(
        'ordenes_locales',
        {
          'diagnostico': ?diagnostico,
          'tipo_servicio': ?tipoServicio,
          'observacion_final': ?observacionFinal,
          'folio_papel': ?folioPapel,
          'actualizado_en': DateTime.now().toIso8601String(),
        },
        where: 'id = ?',
        whereArgs: [ordenId],
      );
      await _encolar(ordenId, 'datos_ot', {
        'tipo_servicio': ?tipoServicio,
        'diagnostico': ?diagnostico,
        'observacion_final': ?observacionFinal,
        'folio_papel': ?folioPapel,
      }, ejecutor: txn);
    });
    notifyListeners();
  }

  /// Sistemas donde se intervino. Se manda la lista completa, no incrementos: asi un reintento
  /// de la cola deja el mismo resultado en vez de acumular marcas.
  Future<void> encolarChecklist(int ordenId, List<int> servicioIds) async {
    ordenId = resolverIdOrden(ordenId);
    final db = await _db;
    await db.transaction((txn) async {
      await txn.delete('ot_servicios_locales', where: 'orden_trabajo_id = ?', whereArgs: [ordenId]);
      for (final id in servicioIds) {
        await txn.insert('ot_servicios_locales', {'orden_trabajo_id': ordenId, 'servicio_id': id});
      }
      await _encolar(ordenId, 'checklist', {'servicio_ids': servicioIds}, ejecutor: txn);
    });
    notifyListeners();
  }

  /// Tramo de trabajo (una visita). El papel trae dos bloques; aca puede haber varios.
  /// [reemplazaTramoLocalId]: al cerrar un tramo que estaba abierto, la fila abierta se borra en la
  /// misma transaccion que crea la cerrada y su tarea.
  Future<void> encolarTramo(int ordenId,
      {required DateTime inicio, DateTime? termino, int? reemplazaTramoLocalId}) async {
    ordenId = resolverIdOrden(ordenId);
    final db = await _db;
    await db.transaction((txn) async {
      if (reemplazaTramoLocalId != null) {
        await txn.delete('tramos_locales', where: 'id = ?', whereArgs: [reemplazaTramoLocalId]);
      }
      final tramoLocalId = await txn.insert('tramos_locales', {
        'orden_trabajo_id': ordenId,
        'inicio': inicio.toUtc().toIso8601String(),
        'termino': termino?.toUtc().toIso8601String(),
        'sincronizado': 0,
      });
      // En UTC (con la Z): el servidor interpretaria una hora local sin zona en la suya, y con un
      // telefono en otra zona horaria (o con la hora mal puesta) el tramo saldria corrido varias
      // horas.
      await _encolar(ordenId, 'tramo', {
        'tramo_local_id': tramoLocalId,
        'inicio': inicio.toUtc().toIso8601String(),
        if (termino != null) 'termino': termino.toUtc().toIso8601String(),
      }, ejecutor: txn);
    });
    notifyListeners();
  }

  /// Lectura de horometro tomada en terreno. Se encola igual que el resto del trabajo del
  /// mecanico para que funcione sin señal: la maquinaria va en el payload porque la cola se
  /// indexa por orden de trabajo.
  Future<void> encolarHorometro(
    int ordenId, {
    required int maquinariaId,
    required double valor,
    bool reiniciarContador = false,
    String? observacion,
  }) async {
    ordenId = resolverIdOrden(ordenId);
    await _encolar(ordenId, 'horometro', {
      'maquinaria_id': maquinariaId,
      'valor': valor,
      'reiniciar_contador': reiniciarContador,
      if (observacion != null && observacion.isNotEmpty) 'observacion': observacion,
    });
    notifyListeners();
  }

  Future<void> encolarEvidencia(int ordenId, String rutaLocal, {String tipo = 'antes'}) async {
    ordenId = resolverIdOrden(ordenId);
    final db = await _db;
    await db.transaction((txn) async {
      final evidenciaId = await txn.insert('evidencias_locales', {
        'orden_trabajo_id': ordenId,
        'ruta_local': rutaLocal,
        'tipo': tipo,
        'sincronizado': 0,
        'creado_en': DateTime.now().toIso8601String(),
      });
      await _encolar(ordenId, 'evidencia', {
        'evidencia_local_id': evidenciaId,
        'ruta_local': rutaLocal,
        'tipo': tipo,
      }, ejecutor: txn);
    });
    notifyListeners();
  }

  /// Linea de repuesto de la OT, como la tabla del talonario: cantidad, insumo del catalogo
  /// o descripcion escrita a mano, precio, y el facturable si/no/pendiente de esa linea.
  Future<void> encolarInsumo(
    int ordenId, {
    int? insumoId,
    required String insumoNombre,
    required double cantidad,
    String? descripcion,
    double? precioUnitario,
    String facturable = 'pendiente',
  }) async {
    ordenId = resolverIdOrden(ordenId);
    final db = await _db;
    await db.transaction((txn) async {
      final insumoLocalId = await txn.insert('insumos_locales', {
        'orden_trabajo_id': ordenId,
        'insumo_id': insumoId,
        'insumo_nombre': insumoNombre,
        'cantidad': cantidad,
        'descripcion': descripcion,
        'precio_unitario': precioUnitario,
        'facturable': facturable,
        'sincronizado': 0,
        'creado_en': DateTime.now().toIso8601String(),
      });
      await _encolar(ordenId, 'insumo', {
        'insumo_local_id': insumoLocalId,
        'insumo_id': ?insumoId,
        'cantidad': cantidad,
        if (descripcion != null && descripcion.isNotEmpty) 'descripcion': descripcion,
        'precio_unitario': ?precioUnitario,
        'facturable': facturable,
      }, ejecutor: txn);
    });
    notifyListeners();
  }

  /// Anula (tacha) una linea de repuesto. No se borra: queda visible como anulada, igual que
  /// una linea tachada en el talonario, y el servidor devuelve el repuesto al furgon.
  ///
  /// La anulacion se encola siempre DETRAS del envio de la linea, aunque la linea todavia no
  /// se haya enviado. Sacarla de la cola parece mas simple, pero la tarea puede haber llegado
  /// al servidor con la respuesta perdida: la linea quedaria viva alla y tachada aca. Como la
  /// cola respeta el orden, al ejecutarse la anulacion la linea ya tiene su id del servidor.
  ///
  /// Devuelve un mensaje para el mecanico si no se pudo anular, o null si se anulo.
  Future<String?> anularInsumo(Map<String, dynamic> linea) async {
    final db = await _db;
    final lineaLocalId = linea['id'] as int;
    final ordenId = resolverIdOrden(linea['orden_trabajo_id'] as int);

    if (linea['sincronizado'] == 1 && linea['servidor_id'] == null) {
      // lineas enviadas antes de esta version: el telefono no guardo su id en el servidor
      return 'Esta línea se registró con una versión anterior de la app. '
          'Pide al administrativo que la anule desde el panel.';
    }

    await db.transaction((txn) async {
      await _encolar(ordenId, 'anular_insumo', {'insumo_local_id': lineaLocalId}, ejecutor: txn);
      await txn.update('insumos_locales', {'anulada': 1}, where: 'id = ?', whereArgs: [lineaLocalId]);
    });
    notifyListeners();
    return null;
  }

  Future<void> _encolar(int ordenId, String tipo, Map<String, dynamic> payload, {DatabaseExecutor? ejecutor}) async {
    ordenId = resolverIdOrden(ordenId);
    final db = ejecutor ?? await _db;
    await db.insert('cola_sincronizacion', {
      'tipo': tipo,
      'orden_trabajo_id': ordenId,
      // identifica la tarea ante el servidor: un reintento con el mismo uuid no se duplica
      'payload': jsonEncode({...payload, 'uuid': generarUuid()}),
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

  /// Cambios pendientes que no pueden salir porque otro cambio de la misma OT quedo en error (la
  /// cola respeta el orden dentro de cada OT). Las lecturas de horometro sin OT (id 0) no se
  /// frenan entre si, asi que no cuentan.
  Future<int> contarDetrasDeErrores() async {
    final db = await _db;
    final result = await db.rawQuery(
      "SELECT COUNT(*) as n FROM cola_sincronizacion WHERE estado = 'pendiente' AND orden_trabajo_id != 0 "
      "AND orden_trabajo_id IN (SELECT orden_trabajo_id FROM cola_sincronizacion WHERE estado = 'error')",
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  /// OT que el telefono ya muestra finalizadas pero cuyo cierre sigue en la cola (pendiente o en
  /// error): para la oficina siguen abiertas.
  Future<Set<int>> ordenesConCierreSinEnviar() async {
    final db = await _db;
    final filas = await db.rawQuery(
      "SELECT DISTINCT orden_trabajo_id FROM cola_sincronizacion WHERE tipo = 'finalizar' AND estado IN ('pendiente', 'error')",
    );
    return filas.map((f) => f['orden_trabajo_id'] as int).toSet();
  }

  Future<List<Map<String, dynamic>>> tareasEnError() async {
    final db = await _db;
    return db.query('cola_sincronizacion', where: "estado = 'error'", orderBy: 'creado_en ASC');
  }

  /// Tareas que no se han podido enviar y por que: las que ya pasaron a error y las que siguen
  /// pendientes pero fallaron en el ultimo intento (sin senal real, servidor lento o rechazo que
  /// aun se reintenta).
  Future<List<Map<String, dynamic>>> tareasConProblema() async {
    final db = await _db;
    return db.query(
      'cola_sincronizacion',
      where: "estado = 'error' OR (estado = 'pendiente' AND ultimo_error IS NOT NULL)",
      orderBy: 'creado_en ASC',
    );
  }

  /// Motivo del ultimo fallo de una tarea que sigue pendiente, para mostrarlo en el aviso.
  Future<String?> ultimoProblemaPendiente() async {
    final db = await _db;
    final filas = await db.query(
      'cola_sincronizacion',
      columns: ['ultimo_error'],
      where: "estado = 'pendiente' AND ultimo_error IS NOT NULL",
      orderBy: 'creado_en ASC',
      limit: 1,
    );
    return filas.isEmpty ? null : filas.first['ultimo_error'] as String?;
  }

  Future<void> _anotarProblema(int tareaId, String mensaje) async {
    final db = await _db;
    await db.update('cola_sincronizacion', {'ultimo_error': mensaje}, where: 'id = ?', whereArgs: [tareaId]);
  }

  /// Descarta una tarea en error (por ejemplo la de una OT que se reasigno a otro tecnico y
  /// responde 403 siempre): sin esto la tarea y la OT ajena quedarian en el telefono para siempre y
  /// frenarian las demas tareas de esa orden. Solo borra tareas en 'error'. Tambien quita lo local
  /// que la tarea habia creado (repuesto, foto u orden nueva) para que no quede una linea que
  /// parece enviada.
  Future<void> descartarTarea(int tareaId) async {
    final db = await _db;
    final filas = await db.query('cola_sincronizacion', where: "id = ? AND estado = 'error'", whereArgs: [tareaId]);
    if (filas.isEmpty) return;
    await db.transaction((txn) => _borrarTareaYLocal(txn, filas.first));
    notifyListeners();
    await sincronizar();
  }

  /// Descarta todas las tareas sin enviar de una orden (pendientes y en error). Para una OT
  /// reasignada: son varias y cada una solo pasaria a error en una sincronizacion distinta.
  Future<void> descartarOrden(int ordenId) async {
    final db = await _db;
    final filas = await db.query(
      'cola_sincronizacion',
      where: "orden_trabajo_id = ? AND estado IN ('pendiente', 'error')",
      whereArgs: [ordenId],
    );
    if (filas.isEmpty) return;
    await db.transaction((txn) async {
      for (final fila in filas) {
        await _borrarTareaYLocal(txn, fila);
      }
    });
    notifyListeners();
    await sincronizar();
  }

  Future<void> _borrarTareaYLocal(DatabaseExecutor txn, Map<String, Object?> fila) async {
    final tipo = fila['tipo'] as String?;
    final ordenId = fila['orden_trabajo_id'] as int;
    Map<String, dynamic> payload = {};
    try {
      payload = Map<String, dynamic>.from(jsonDecode(fila['payload'] as String) as Map);
      // un payload ilegible se trata como vacio: la tarea se borra igual
    } catch (_) {}
    if (tipo == 'evidencia' && payload['evidencia_local_id'] != null) {
      await txn.delete('evidencias_locales', where: 'id = ?', whereArgs: [payload['evidencia_local_id']]);
    } else if (tipo == 'insumo' && payload['insumo_local_id'] != null) {
      await txn.delete('insumos_locales', where: 'id = ?', whereArgs: [payload['insumo_local_id']]);
    } else if (tipo == 'crear_ot' && ordenId < 0) {
      // la orden nunca llego al servidor: sus tareas hijas ya no tienen a donde ir
      await txn.delete('cola_sincronizacion', where: 'orden_trabajo_id = ? AND id != ?', whereArgs: [ordenId, fila['id']]);
      for (final tabla in ['evidencias_locales', 'insumos_locales', 'ot_servicios_locales', 'tramos_locales']) {
        await txn.delete(tabla, where: 'orden_trabajo_id = ?', whereArgs: [ordenId]);
      }
      await txn.delete('ordenes_locales', where: 'id = ?', whereArgs: [ordenId]);
    }
    await txn.delete('cola_sincronizacion', where: 'id = ?', whereArgs: [fila['id']]);
  }

  /// Devuelve las tareas en error al estado pendiente (con reintentos en cero) y dispara una
  /// sincronizacion inmediata. El contador de fallos transitorios del payload tambien vuelve a cero
  /// y se borra la hora del primero (el uuid y lo demas del payload no se tocan): si no, una tarea
  /// que llego al tope volveria a error al primer fallo.
  Future<void> reintentarErrores() async {
    final db = await _db;
    await db.transaction((txn) async {
      final filas = await txn.query('cola_sincronizacion', columns: ['id', 'payload'], where: "estado = 'error'");
      for (final fila in filas) {
        String? payloadNuevo;
        try {
          final payload = Map<String, dynamic>.from(jsonDecode(fila['payload'] as String) as Map);
          if (tieneMarcasFallosTransitorios(payload)) payloadNuevo = jsonEncode(sinFallosTransitorios(payload));
          // un payload ilegible no se toca: la tarea vuelve a pendiente tal cual
        } catch (_) {}
        await txn.update(
          'cola_sincronizacion',
          {'intentos': 0, 'estado': 'pendiente', 'ultimo_error': null, 'payload': ?payloadNuevo},
          where: 'id = ?',
          whereArgs: [fila['id']],
        );
      }
    });
    notifyListeners();
    await sincronizar();
  }

  /// Sincronizacion rapida: envia la cola, baja las OT y el furgon. Es lo que hace falta tras cada
  /// accion del mecanico y al volver a la app. La completa agrega catalogos, flota e historial de
  /// equipos; se hace sola al abrir la app y cada pocas horas, o con `completa: true`.
  ///
  /// Si ya hay una en curso, se agenda una sola pasada mas para cuando termine (ver
  /// PasadasEnSerie).
  Future<void> sincronizar({bool completa = false}) => _pasadas.pedir(completa: completa);

  Future<void> _pasada(bool completa) async {
    await _push();
    await _pull();
    // el pull respondio autorizado: si habia un aviso de sesion expirada, ya no aplica
    reiniciarSesion();
    await _pullMiFurgon();

    final vencida = _ultimaCompleta == null || DateTime.now().difference(_ultimaCompleta!) > _vigenciaCompleta;
    if (completa || vencida) {
      // cada bloque por separado: un catalogo lento o caido no debe impedir los demas ni
      // dejar sin refrescar lo que ya se bajo
      var todoOk = true;
      for (final bloque in [
        _pullCatalogoInsumos,
        _pullCatalogoChecklist,
        _pullMaquinarias,
        _pullHistorialEquipos,
      ]) {
        try {
          await bloque();
        } catch (_) {
          todoOk = false;
        }
      }
      if (todoOk) _ultimaCompleta = DateTime.now();
    }
    _ultimaSincronizacion = DateTime.now();
  }

  Future<void> _pull() async {
    final data = (await _api.get('/api/ordenes-trabajo'))['items'];
    final db = await _db;

    // OT con tareas aun pendientes o en error no se sobreescriben con la version
    // del servidor, para no perder el cambio local todavia sin sincronizar.
    final pendientesRows = await db.rawQuery(
      "SELECT DISTINCT orden_trabajo_id FROM cola_sincronizacion WHERE estado IN ('pendiente', 'error')",
    );
    final idsConPendientes = pendientesRows.map((r) => r['orden_trabajo_id'] as int).toSet();

    final idsDelServidor = <int>{};
    final lote = db.batch();
    for (final item in (data as List)) {
      final orden = OrdenTrabajo.fromApiJson(item);
      idsDelServidor.add(orden.id);
      if (idsConPendientes.contains(orden.id)) continue;
      lote.insert('ordenes_locales', orden.toLocalMap(), conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await lote.commit(noResult: true);

    // OT que el servidor ya no le entrega a este mecanico (reasignadas a otro tecnico o
    // eliminadas): si quedaran en el telefono, trabajar sobre ellas llenaria la cola de rechazos.
    // Se conservan las que aun tienen cambios sin enviar, para no perder trabajo, y las creadas en
    // terreno que todavia no existen en el servidor (id negativo).
    final locales = await db.query('ordenes_locales', columns: ['id']);
    for (final fila in locales) {
      final id = fila['id'] as int;
      if (id < 0 || idsDelServidor.contains(id) || idsConPendientes.contains(id)) continue;
      await db.transaction((txn) async {
        for (final tabla in ['evidencias_locales', 'insumos_locales', 'ot_servicios_locales', 'tramos_locales']) {
          await txn.delete(tabla, where: 'orden_trabajo_id = ?', whereArgs: [id]);
        }
        await txn.delete('ordenes_locales', where: 'id = ?', whereArgs: [id]);
      });
    }
  }

  /// Refresca solo el furgon (stock, vehiculo y perfil). Tras cargar repuestos desde la bodega no
  /// hace falta una sincronizacion completa, y ademas `sincronizar()` con otra en curso espera a
  /// que esa termine antes de su propia pasada.
  Future<void> actualizarFurgon() async {
    await _pullMiFurgon();
    notifyListeners();
  }

  /// Stock del furgon, vehiculo asignado y perfil propio. Se cachean para poder consultarlos
  /// en terreno; la carga del furgon en cambio es solo online (se hace en el taller).
  Future<void> _pullMiFurgon() async {
    final db = await _db;
    try {
      final furgon = await _api.get('/api/insumos/mi-furgon');
      await db.delete('furgon_stock_local');
      for (final item in (furgon['items'] as List? ?? [])) {
        await db.insert('furgon_stock_local', {
          'insumo_id': item['insumo_id'],
          'nombre': item['nombre'],
          'unidad_medida': item['unidad_medida'],
          'cantidad': _aDouble(item['cantidad']) ?? 0,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }

      final mio = await _api.get('/api/vehiculos/mio');
      await db.delete('mi_vehiculo_local');
      final v = mio['vehiculo'];
      if (v != null) {
        await db.insert('mi_vehiculo_local', {
          'id': v['id'],
          'patente': v['patente'],
          'marca': v['marca'],
          'modelo': v['modelo'],
          'anio': v['anio'],
          'tipo': v['tipo'],
          'kilometraje': v['kilometraje'],
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }

      final perfil = await _api.get('/api/usuarios/mi-perfil');
      await db.delete('mi_perfil_local');
      await db.insert('mi_perfil_local', {
        'id': perfil['id'],
        'nombre': perfil['nombre'],
        'email': perfil['email'],
        'rut': perfil['rut'],
        'telefono_whatsapp': perfil['telefono_whatsapp'],
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    } on ApiException catch (_) {
      // un mecanico sin furgon asignado todavia no debe romper la sincronizacion
    }
  }

  /// Catalogo liviano de la flota, para el selector de "intervine otro equipo". Solo id,
  /// codigo y tipo: son ~500 equipos y no tiene sentido bajar la ficha completa de todos.
  Future<void> _pullMaquinarias() async {
    // sin `limit` el endpoint devuelve la flota completa, que es lo que necesita el catalogo
    final data = (await _api.get('/api/maquinarias'))['items'];
    final db = await _db;
    // un solo batch: son ~500 equipos y un insert por fila tardaba segundos
    final batch = db.batch();
    for (final item in (data as List)) {
      batch.insert(
        'maquinarias_local',
        {
          'id': item['id'],
          'codigo': item['codigo'],
          'tipo': item['tipo'],
          'estado': item['estado'],
          'ubicacion': item['ubicacion'],
          'cliente_nombre': item['cliente'],
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  /// Ficha completa, historial de OT y lecturas de horometro de los equipos que el mecanico
  /// tiene asignados. Solo esos: es lo que necesita en terreno y evita arrastrarse la flota.
  Future<void> _pullHistorialEquipos() async {
    final db = await _db;
    final filas = await db.rawQuery(
      'SELECT DISTINCT maquinaria_id FROM ordenes_locales WHERE maquinaria_id IS NOT NULL',
    );
    for (final fila in filas) {
      try {
        await _pullEquipo(fila['maquinaria_id'] as int);
      } on ApiException catch (_) {
        // un equipo que ya no existe o al que perdio acceso no debe abortar el resto del pull
        continue;
      }
    }
  }

  /// Baja la ficha completa, el historial de OT y las lecturas de horometro de UN equipo. Lo usa
  /// la sincronizacion para los equipos de sus ordenes y la pantalla Flota para abrir cualquier otro.
  Future<void> descargarEquipo(int maquinariaId) => _pullEquipo(maquinariaId);

  Future<void> _pullEquipo(int maquinariaId) async {
    final db = await _db;
    final ficha = await _api.get('/api/maquinarias/$maquinariaId');
    await db.insert(
      'maquinarias_local',
      {
        'id': ficha['id'],
        'codigo': ficha['codigo'],
        'tipo': ficha['tipo'],
        'estado': ficha['estado'],
        'categoria_equipo': ficha['categoria_equipo'],
        'marca': ficha['marca'],
        'modelo': ficha['modelo'],
        'anio': ficha['anio'],
        'numero_serie': ficha['numero_serie'],
        'numero_motor': ficha['numero_motor'],
        'numero_chasis': ficha['numero_chasis'],
        'numero_mastil': ficha['numero_mastil'],
        'capacidad_carga': _aDouble(ficha['capacidad_carga']),
        'altura_trabajo': _aDouble(ficha['altura_trabajo']),
        'tipo_combustible': ficha['tipo_combustible'],
        'ubicacion': ficha['ubicacion'],
        'ficha_completa': 1,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );

    final historial = await _api.get('/api/maquinarias/$maquinariaId/ordenes-trabajo');
    await db.delete('historial_ot_local', where: 'maquinaria_id = ?', whereArgs: [maquinariaId]);
    for (final ot in (historial as List)) {
      await db.insert('historial_ot_local', {
        'id': ot['id'],
        'maquinaria_id': maquinariaId,
        'motivo': ot['motivo'],
        'diagnostico': ot['diagnostico'],
        'observacion_final': ot['observacion_final'],
        'estado': ot['estado'],
        'fecha_creacion': ot['fecha_creacion'],
        'fecha_cierre': ot['fecha_cierre'],
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }

    final horometro = await _api.get('/api/horometro/maquinaria/$maquinariaId');
    await db.delete('horometro_local', where: 'maquinaria_id = ?', whereArgs: [maquinariaId]);
    for (final l in (horometro['lecturas'] as List? ?? [])) {
      await db.insert('horometro_local', {
        'id': l['id'],
        'maquinaria_id': maquinariaId,
        'valor': _aDouble(l['valor']) ?? 0,
        'origen': l['origen'],
        'fecha': l['fecha'],
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }
  }

  static double? _aDouble(dynamic v) {
    if (v == null) return null;
    if (v is num) return v.toDouble();
    return double.tryParse(v.toString());
  }

  /// Catalogo del checklist (31 sistemas del talonario). Se cachea igual que el de insumos
  /// para poder llenar la OT en terreno sin señal.
  Future<void> _pullCatalogoChecklist() async {
    final data = await _api.get('/api/checklist');
    final db = await _db;
    final batch = db.batch();
    for (final item in (data as List)) {
      batch.insert(
        'checklist_catalogo_local',
        {'id': item['id'], 'grupo': item['grupo'], 'nombre': item['nombre'], 'orden': item['orden']},
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  Future<void> _pullCatalogoInsumos() async {
    final data = await _api.get('/api/insumos');
    final db = await _db;
    final batch = db.batch();
    for (final item in (data as List)) {
      batch.insert(
        'insumos_catalogo_local',
        {
          'id': item['id'],
          'nombre': item['nombre'],
          'unidad_medida': item['unidad_medida'],
          'costo_unitario': _aDouble(item['costo_unitario']),
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  // Clasificacion de errores (practica estandar de colas offline-first), en utils/fallo_sync.dart:
  // - Errores de red/timeout: NO consumen reintentos (la tarea no fallo, no hubo red)
  //   y abortan el resto del push - se reintenta completo cuando vuelva la senal.
  // - 401: NO consume reintentos; pausa la cola y marca sesionExpirada para que la UI pida
  //   volver a iniciar sesion. El trabajo local queda intacto. 403: esa tarea a error.
  // - 5xx, 429 y 408 (de la API o del almacenamiento de fotos): NO consumen reintentos; frenan
  //   solo esa OT en esta pasada y se cuentan en el payload; pasan a error solo con
  //   topeFallosTransitorios fallos y plazoFallosTransitorios desde el primero.
  // - Otros errores del servidor (rechazo real de negocio): consumen un reintento,
  //   y tras maxIntentos la tarea pasa a 'error' - visible en la UI con reintento manual.
  Future<void> _push() async {
    final db = await _db;
    const maxIntentos = maxIntentosSync;
    final pendientes = await db.query(
      'cola_sincronizacion',
      where: 'estado = ? AND intentos < ?',
      whereArgs: ['pendiente', maxIntentos],
      // por id (autoincremental) y no por hora: la hora local sin zona se desordena si cambia el reloj
      orderBy: 'id ASC',
    );

    // OTs con una tarea rechazada en ESTE ciclo: sus tareas posteriores se saltan
    // para preservar el orden causal (ej. que "finalizar" no se ejecute si la
    // evidencia anterior de la misma OT fue rechazada) - quedan para el proximo push
    final otsConFallo = <int>{};

    // Una tarea que ya quedo en 'error' en un ciclo anterior tambien frena las siguientes de su
    // OT: si no, el cierre (o la evidencia posterior) pasaria por encima de un repuesto o una foto
    // rechazados. Se libera al reintentar o descartar.
    final enError = await db.query(
      'cola_sincronizacion',
      columns: ['orden_trabajo_id'],
      where: "estado = 'error'",
    );
    for (final fila in enError) {
      final id = fila['orden_trabajo_id'] as int;
      if (id != 0) otsConFallo.add(_remapeos[id] ?? id);
    }

    // Traduccion de id local (negativo) a id real, para las OT creadas en terreno sin señal.
    // Hace falta en memoria porque `pendientes` es un snapshot tomado ANTES del bucle: las
    // tareas hijas ya cargadas siguen trayendo el id negativo aunque la base ya se remapeo.
    final remapeo = <int, int>{};

    for (final tarea in pendientes) {
      final idTarea = tarea['orden_trabajo_id'] as int;
      final otId = remapeo[idTarea] ?? _remapeos[idTarea] ?? idTarea;
      if (otsConFallo.contains(otId)) continue;
      try {
        await _ejecutarTarea({...tarea, 'orden_trabajo_id': otId}, remapeo);
        await db.delete('cola_sincronizacion', where: 'id = ?', whereArgs: [tarea['id']]);
        if (_sesionExpirada) {
          _sesionExpirada = false;
          notifyListeners();
        }
      } catch (err) {
        final decision = clasificarFalloSync(err);
        switch (decision.accion) {
          case AccionFallo.esperarRed:
            // sin red: abortar sin castigar la tarea, pero dejando el motivo visible
            await _anotarProblema(tarea['id'] as int, decision.mensaje);
            return;
          case AccionFallo.pausarSesion:
            _sesionExpirada = true;
            notifyListeners();
            return; // token invalido: pausar toda la cola sin consumir reintentos
          case AccionFallo.aError:
            // irrecuperable (foto borrada del telefono) o 403 (la OT se reasigno a otro tecnico:
            // volver a iniciar sesion no lo arregla): a error de inmediato, con su motivo y sin
            // quemar reintentos que no sirven
            if (otId != 0) otsConFallo.add(otId);
            await db.update(
              'cola_sincronizacion',
              {'intentos': maxIntentos, 'ultimo_error': decision.mensaje, 'estado': 'error'},
              where: 'id = ?',
              whereArgs: [tarea['id']],
            );
          case AccionFallo.transitorio:
            // el servidor o el almacenamiento de fotos fallo por su lado: la tarea no tiene la
            // culpa. Frena solo esta OT (el orden dentro de ella se respeta) y sigue con las demas.
            if (otId != 0) otsConFallo.add(otId);
            await _anotarFalloTransitorio(tarea['id'] as int, decision);
          case AccionFallo.gastarIntento:
            if (otId != 0) otsConFallo.add(otId);
            final intentos = (tarea['intentos'] as int) + 1;
            await db.update(
              'cola_sincronizacion',
              {
                'intentos': intentos,
                'ultimo_error': decision.mensaje,
                'estado': intentos >= maxIntentos ? 'error' : 'pendiente',
              },
              where: 'id = ?',
              whereArgs: [tarea['id']],
            );
        }
      }
    }
  }

  /// Cuenta un fallo transitorio en el payload de la tarea, sin tocar `intentos`. El payload se
  /// relee de la base y no del snapshot de `_push`: mientras se ejecutaba, la tarea pudo guardar
  /// ahi su uuid (tareas antiguas) o el path de la foto o firma ya subida, y eso no se pierde.
  /// Con el contador se guarda la hora del primer fallo: la tarea pasa a error solo con el tope de
  /// fallos Y el plazo cumplidos (ver contarFalloTransitorio).
  ///
  /// Las dos llaves viajan al servidor en las tareas que mandan el payload completo (datos_ot,
  /// checklist y diagnostico): esas rutas leen solo sus campos y validan solo esos, asi que las
  /// ignoran, igual que el `uuid` que ya viaja ahi.
  Future<void> _anotarFalloTransitorio(int tareaId, DecisionFallo decision) async {
    final db = await _db;
    final filas = await db.query('cola_sincronizacion', columns: ['payload'], where: 'id = ?', whereArgs: [tareaId]);
    if (filas.isEmpty) return;
    Map<String, dynamic> payload;
    try {
      payload = Map<String, dynamic>.from(jsonDecode(filas.first['payload'] as String) as Map);
    } catch (_) {
      await _anotarProblema(tareaId, decision.mensaje);
      return;
    }
    final conteo = contarFalloTransitorio(payload);
    await db.update(
      'cola_sincronizacion',
      {
        'payload': jsonEncode(conteo.payload),
        'ultimo_error': conteo.aError ? (decision.mensajeAlAgotar ?? decision.mensaje) : decision.mensaje,
        if (conteo.aError) ...{'estado': 'error', 'intentos': maxIntentosSync},
      },
      where: 'id = ?',
      whereArgs: [tareaId],
    );
  }

  Future<void> _ejecutarTarea(Map<String, dynamic> tarea, [Map<int, int>? remapeo]) async {
    final tipo = tarea['tipo'] as String;
    final ordenId = tarea['orden_trabajo_id'] as int;
    final Map<String, dynamic> payload;
    try {
      payload = jsonDecode(tarea['payload'] as String) as Map<String, dynamic>;
    } on FormatException {
      // dato propio del telefono, no una respuesta del servidor: reintentar no lo arregla (ver RespuestaIncompleta)
      throw ErrorPermanenteSync('La tarea guardada en el teléfono está dañada y no se puede enviar. Avisa al administrativo.');
    }

    // Tareas encoladas por una version anterior de la app no traen uuid. Se les asigna uno y se
    // guarda ANTES de enviarlas: asi, si esta vez se pierde la respuesta, el reintento ya viaja
    // con el mismo uuid y el servidor no la duplica.
    if (payload['uuid'] == null) {
      payload['uuid'] = generarUuid();
      final db = await _db;
      await db.update('cola_sincronizacion', {'payload': jsonEncode(payload)},
          where: 'id = ?', whereArgs: [tarea['id']]);
    }

    switch (tipo) {
      case 'crear_ot':
        await _crearOtEnTerreno(ordenId, payload, remapeo);
        break;
      case 'diagnostico':
        await _api.patch('/api/ordenes-trabajo/$ordenId/diagnostico', cuerpoDiagnostico(payload));
        break;
      case 'finalizar':
        await _finalizarConFirma(tarea, ordenId, payload);
        break;
      case 'evidencia':
        await _subirEvidencia(tarea, ordenId, payload);
        break;
      case 'insumo':
        await _registrarInsumo(ordenId, payload);
        break;
      case 'anular_insumo':
        await _anularInsumo(ordenId, payload);
        break;
      case 'horometro':
        await _registrarHorometro(ordenId, payload);
        break;
      case 'datos_ot':
        await _api.patch('/api/ordenes-trabajo/$ordenId/datos', payload);
        break;
      case 'checklist':
        // se manda la lista completa de marcados: es idempotente ante un reintento de la cola
        await _api.put('/api/ordenes-trabajo/$ordenId/checklist', payload);
        break;
      case 'tramo':
        await _registrarTramo(ordenId, payload);
        break;
      default:
        throw Exception('Tipo de tarea desconocido: $tipo');
    }
  }

  /// Cierra la OT en el servidor, subiendo antes la firma de recepcion si existe.
  /// Idempotente ante reintentos de la cola: el path de la firma ya subida se
  /// persiste en el payload de la tarea ANTES del PATCH, asi un reintento
  /// (PUT exitoso + PATCH fallido) no vuelve a subir el PNG.
  Future<void> _finalizarConFirma(Map<String, dynamic> tarea, int ordenId, Map<String, dynamic> payload) async {
    final rutaFirma = payload['ruta_firma_local'] as String?;
    var firmaPath = payload['firma_path'] as String?;

    if (rutaFirma != null && firmaPath == null) {
      final archivo = File(rutaFirma);
      // si la firma local se perdio, se cierra igual la OT (con persona/sin_persona):
      // bloquear el cierre para siempre por un PNG borrado seria peor para el negocio
      if (await archivo.exists()) {
        final nombreArchivo = rutaFirma.split(Platform.pathSeparator).last;
        final solicitud = await _solicitarSubida(ordenId, {'nombre_archivo': nombreArchivo, 'carpeta': 'firmas'});
        final resp = await _http
            .put(
              Uri.parse(solicitud['signedUrl'] as String),
              headers: {'Content-Type': 'image/png'},
              body: await archivo.readAsBytes(),
            )
            .timeout(const Duration(seconds: 20));
        if (resp.statusCode >= 300) {
          throw ErrorSubidaArchivo(resp.statusCode);
        }
        firmaPath = solicitud['path'] as String;
        payload['firma_path'] = firmaPath;
        final db = await _db;
        await db.update(
          'cola_sincronizacion',
          {'payload': jsonEncode(payload)},
          where: 'id = ?',
          whereArgs: [tarea['id']],
        );
      }
    }

    await _api.patch(
      '/api/ordenes-trabajo/$ordenId/finalizar',
      cuerpoFinalizar(payload, creadoEn: tarea['creado_en'] as String?, firmaPath: firmaPath),
    );

    // el cierre ya esta en el servidor, con la firma subida: el PNG local no sirve para nada mas. Se
    // borra recien ahora y no tras la subida: si el PATCH falla, el reintento usa firma_path y no el
    // archivo, pero asi nunca se borra una firma de un cierre que aun no llego.
    await borrarArchivoLocal(rutaFirma);
  }

  /// Pide la URL firmada para subir una foto o firma. Si el servidor responde que el almacenamiento
  /// no esta disponible (5xx, 429, 408), el fallo se informa como de la subida de fotos, para que
  /// el mecanico vea un motivo que entienda. Los rechazos (403, 409...) siguen saliendo como
  /// ApiException.
  Future<dynamic> _solicitarSubida(int ordenId, Map<String, dynamic> cuerpo) async {
    try {
      return await _api.post('/api/ordenes-trabajo/$ordenId/evidencia/solicitar-upload', cuerpo);
    } on ApiException catch (err) {
      if (esCodigoTransitorio(err.statusCode)) throw ErrorSubidaArchivo(err.statusCode);
      rethrow;
    }
  }

  /// Sube la foto a Supabase y la registra en la OT.
  ///
  /// Idempotente ante reintentos, igual que la firma: el path de la foto ya subida se guarda en
  /// la tarea antes de confirmar, asi un reintento (subida exitosa + confirmacion sin respuesta)
  /// no vuelve a subir el archivo, y el uuid evita que la confirmacion se registre dos veces.
  Future<void> _subirEvidencia(Map<String, dynamic> tarea, int ordenId, Map<String, dynamic> payload) async {
    var pathSubido = payload['path_subido'] as String?;

    if (pathSubido == null) {
      final rutaLocal = payload['ruta_local'] as String;
      final archivo = File(rutaLocal);
      if (!await archivo.exists()) {
        throw ErrorPermanenteSync('La foto ya no está en el teléfono (fue borrada o se limpiaron los datos de la app)');
      }
      final nombreArchivo = rutaLocal.split(Platform.pathSeparator).last;

      final solicitud = await _solicitarSubida(ordenId, {'nombre_archivo': nombreArchivo});

      final signedUrl = solicitud['signedUrl'] as String;
      final resp = await _http
          .put(
            Uri.parse(signedUrl),
            headers: {'Content-Type': 'image/jpeg'},
            body: await archivo.readAsBytes(),
          )
          .timeout(const Duration(seconds: 20));
      if (resp.statusCode >= 300) {
        throw ErrorSubidaArchivo(resp.statusCode);
      }

      pathSubido = solicitud['path'] as String;
      payload['path_subido'] = pathSubido;
      final db = await _db;
      await db.update('cola_sincronizacion', {'payload': jsonEncode(payload)},
          where: 'id = ?', whereArgs: [tarea['id']]);
    }

    await _api.post(
      '/api/ordenes-trabajo/$ordenId/evidencia/confirmar',
      {
        'path': pathSubido,
        // tareas encoladas antes del rediseño no traen tipo: 'antes' (mismo default del backend)
        'tipo': payload['tipo'] ?? 'antes',
        'uuid_cliente': payload['uuid'],
      },
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

    // confirmada en el servidor: la copia local ya no es trabajo pendiente y ocupa espacio del telefono.
    // La fila se conserva (la lista de evidencias la sigue mostrando como enviada) y su miniatura cae en
    // el marcador de foto ya enviada. Si el borrado falla, no importa: lo recoge la limpieza al cerrar sesion.
    await borrarArchivoLocal(payload['ruta_local'] as String?);
  }

  /// Crea en el servidor una OT que nacio en terreno y traduce su id local por el real.
  ///
  /// Sin señal la OT no puede tener id del servidor, asi que nace con uno negativo (imposible
  /// que choque con uno real) y sus fotos, repuestos y tramos cuelgan de ese id. Al sincronizar
  /// hay que reescribir esa referencia en todas partes.
  Future<void> _crearOtEnTerreno(int idLocal, Map<String, dynamic> payload, Map<int, int>? remapeo) async {
    final creada = await _api.post('/api/ordenes-trabajo/en-terreno', {
      'maquinaria_id': payload['maquinaria_id'],
      if (payload['motivo'] != null) 'motivo': payload['motivo'],
      'uuid_cliente': payload['uuid'],
    });
    final idReal = creada['id'] as int;
    if (idReal == idLocal) return;

    final db = await _db;
    await db.transaction((txn) async {
      for (final tabla in ['cola_sincronizacion', 'evidencias_locales', 'insumos_locales',
                           'ot_servicios_locales', 'tramos_locales']) {
        await txn.update(tabla, {'orden_trabajo_id': idReal},
            where: 'orden_trabajo_id = ?', whereArgs: [idLocal]);
      }
      // si la respuesta de la creacion se perdio, el pull ya trajo la OT con su id real: gana la copia
      // local, que tiene el trabajo todavia sin enviar, y sin esto el UPDATE choca con la clave primaria
      await txn.delete('ordenes_locales', where: 'id = ?', whereArgs: [idReal]);
      await txn.update('ordenes_locales', {'id': idReal}, where: 'id = ?', whereArgs: [idLocal]);
    });
    remapeo?[idLocal] = idReal;
    _remapeos[idLocal] = idReal;
  }

  Future<void> _registrarTramo(int ordenId, Map<String, dynamic> payload) async {
    await _api.post('/api/ordenes-trabajo/$ordenId/tramos', {
      'inicio': payload['inicio'],
      if (payload['termino'] != null) 'termino': payload['termino'],
      'uuid_cliente': payload['uuid'],
    });
    final tramoLocalId = payload['tramo_local_id'];
    if (tramoLocalId != null) {
      final db = await _db;
      await db.update(
        'tramos_locales',
        {'sincronizado': 1},
        where: 'id = ?',
        whereArgs: [tramoLocalId],
      );
    }
  }

  Future<void> _registrarHorometro(int ordenId, Map<String, dynamic> payload) async {
    await _api.post('/api/horometro/maquinaria/${payload['maquinaria_id']}', {
      'valor': payload['valor'],
      // orden 0 = lectura de un equipo sin orden de trabajo (desde Flota)
      if (ordenId > 0) 'orden_trabajo_id': ordenId,
      'reiniciar_contador': payload['reiniciar_contador'] ?? false,
      if (payload['observacion'] != null) 'observacion': payload['observacion'],
      'uuid_cliente': payload['uuid'],
    });
  }

  /// El id del servidor se busca al ejecutar, no al encolar: si la linea se anulo antes de
  /// enviarse, recien lo tiene cuando su propia tarea (anterior en la cola) termino.
  Future<void> _anularInsumo(int ordenId, Map<String, dynamic> payload) async {
    final db = await _db;
    final filas = await db.query('insumos_locales',
        columns: ['servidor_id'], where: 'id = ?', whereArgs: [payload['insumo_local_id']]);
    final servidorId = filas.isEmpty ? null : filas.first['servidor_id'];
    if (servidorId == null) {
      throw ErrorPermanenteSync(
          'No se pudo anular el repuesto porque no llegó al servidor. Revisa si su envío tiene un error.');
    }
    await _api.post('/api/insumos/orden/$ordenId/linea/$servidorId/anular', {});
  }

  Future<void> _registrarInsumo(int ordenId, Map<String, dynamic> payload) async {
    final linea = await _api.post('/api/insumos/orden/$ordenId', {
      if (payload['insumo_id'] != null) 'insumo_id': payload['insumo_id'],
      'cantidad': payload['cantidad'],
      if (payload['descripcion'] != null) 'descripcion': payload['descripcion'],
      if (payload['precio_unitario'] != null) 'precio_unitario': payload['precio_unitario'],
      'facturable': payload['facturable'] ?? 'pendiente',
      'uuid_cliente': payload['uuid'],
    });

    final db = await _db;
    final insumoLocalId = payload['insumo_local_id'];
    if (insumoLocalId != null) {
      await db.update(
        'insumos_locales',
        // el id del servidor permite anular la linea despues de sincronizada
        {'sincronizado': 1, 'servidor_id': linea is Map ? linea['id'] : null},
        where: 'id = ?',
        whereArgs: [insumoLocalId],
      );
    }
  }
}

/// Envuelve el cliente HTTP de la cola: un `FormatException` que sale de una llamada (respuesta cortada o
/// corrupta) pasa a [RespuestaIncompleta], que la clasificacion trata como falla de red. Los
/// `FormatException` que nacen en codigo propio no pasan por aqui y siguen siendo errores normales.
class _ApiVerificada implements ApiCola {
  _ApiVerificada(this._real);
  final ApiCola _real;

  Future<dynamic> _vigilar(Future<dynamic> Function() llamada) async {
    try {
      return await llamada();
    } on FormatException catch (e) {
      throw RespuestaIncompleta(e);
    }
  }

  @override
  Future<dynamic> get(String path) => _vigilar(() => _real.get(path));
  @override
  Future<dynamic> post(String path, Map<String, dynamic> body) => _vigilar(() => _real.post(path, body));
  @override
  Future<dynamic> patch(String path, Map<String, dynamic> body) => _vigilar(() => _real.patch(path, body));
  @override
  Future<dynamic> put(String path, Map<String, dynamic> body) => _vigilar(() => _real.put(path, body));
}
