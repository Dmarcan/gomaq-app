import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/services/api_client.dart' show ApiException;
import 'package:gomaq_mecanico/services/sync_service.dart';
import 'package:gomaq_mecanico/utils/fallo_sync.dart' show maxIntentosSync;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite/sqflite.dart';

import 'ayuda_cola.dart';

void main() {
  late Directory carpetaBase;
  late Database db;
  late ApiFalsa api;
  late List<http.BaseRequest> subidas;
  late SyncService cola;

  setUpAll(() async {
    carpetaBase = await prepararBaseDePruebas();
  });

  tearDownAll(() async {
    try {
      await carpetaBase.delete(recursive: true);
    } catch (_) {}
  });

  setUp(() async {
    db = await baseLimpia();
    api = ApiFalsa();
    subidas = [];
    cola = SyncService(
      api: api,
      clienteHttp: MockClient((req) async {
        subidas.add(req);
        return http.Response('', 200);
      }),
    );
  });

  Future<int> enCola() async => Sqflite.firstIntValue(await db.rawQuery('SELECT COUNT(*) FROM cola_sincronizacion')) ?? 0;

  group('atomicidad: el cambio local y su tarea van juntos', () {
    test('camino feliz: encolarDiagnostico deja el cambio local y la tarea', () async {
      await sembrarOrden(db, 5);
      await cola.encolarDiagnostico(5, diagnostico: 'Fuga de aceite', estado: 'en_reparacion');

      final orden = (await db.query('ordenes_locales', where: 'id = 5')).single;
      expect(orden['diagnostico'], 'Fuga de aceite');
      expect(orden['estado'], 'en_reparacion');
      final tarea = (await db.query('cola_sincronizacion')).single;
      expect(tarea['tipo'], 'diagnostico');
      // el uuid_cliente que evita duplicados en los reintentos sigue generandose
      expect(jsonDecode(tarea['payload'] as String)['uuid'], isA<String>());
    });

    test('si falla el encolado, encolarDiagnostico revierte el cambio local', () async {
      await sembrarOrden(db, 5);
      await romperEncolado(db);

      await expectLater(cola.encolarDiagnostico(5, diagnostico: 'Fuga', estado: 'en_reparacion'), throwsA(isA<DatabaseException>()));

      final orden = (await db.query('ordenes_locales', where: 'id = 5')).single;
      expect(orden['diagnostico'], isNull);
      expect(orden['estado'], 'en_terreno');
      expect(await enCola(), 0);
    });

    test('notifyListeners solo se llama tras el commit: con fallo no avisa', () async {
      await sembrarOrden(db, 5);
      await romperEncolado(db);
      var avisos = 0;
      cola.addListener(() => avisos++);

      await expectLater(cola.encolarDatosOt(5, folioPapel: '123'), throwsA(isA<DatabaseException>()));
      expect(avisos, 0);
    });

    test('si falla el encolado, la OT creada en terreno no queda en la base local', () async {
      await romperEncolado(db);
      await expectLater(cola.encolarOtEnTerreno(maquinariaId: 2, maquinariaCodigo: 'EQ-2'), throwsA(isA<DatabaseException>()));
      expect(await db.query('ordenes_locales'), isEmpty);
    });

    test('si falla el encolado, la foto no deja fila local sin tarea', () async {
      await sembrarOrden(db, 5);
      await romperEncolado(db);
      await expectLater(cola.encolarEvidencia(5, '/tmp/ot5_1.jpg'), throwsA(isA<DatabaseException>()));
      expect(await db.query('evidencias_locales'), isEmpty);
    });

    test('si falla el encolado, el repuesto no deja fila local sin tarea', () async {
      await sembrarOrden(db, 5);
      await romperEncolado(db);
      await expectLater(cola.encolarInsumo(5, insumoNombre: 'Filtro', cantidad: 1), throwsA(isA<DatabaseException>()));
      expect(await db.query('insumos_locales'), isEmpty);
    });

    test('si falla el encolado, el checklist conserva las marcas anteriores', () async {
      await sembrarOrden(db, 5);
      await db.insert('ot_servicios_locales', {'orden_trabajo_id': 5, 'servicio_id': 7});
      await romperEncolado(db);

      await expectLater(cola.encolarChecklist(5, [1, 2]), throwsA(isA<DatabaseException>()));

      final marcas = await db.query('ot_servicios_locales');
      expect(marcas.map((f) => f['servicio_id']), [7]);
    });

    test('si falla el encolado, el tramo abierto que se iba a cerrar sigue abierto', () async {
      await sembrarOrden(db, 5);
      final abierto = await db.insert('tramos_locales', {
        'orden_trabajo_id': 5,
        'inicio': DateTime.now().toUtc().toIso8601String(),
        'sincronizado': 0,
      });
      await romperEncolado(db);

      await expectLater(
        cola.encolarTramo(5, inicio: DateTime.now(), termino: DateTime.now(), reemplazaTramoLocalId: abierto),
        throwsA(isA<DatabaseException>()),
      );

      final tramos = await db.query('tramos_locales');
      expect(tramos.single['id'], abierto);
      expect(tramos.single['termino'], isNull);
    });

    test('anular una linea: si falla el encolado, la linea no queda marcada como anulada', () async {
      await sembrarOrden(db, 5);
      await cola.encolarInsumo(5, insumoNombre: 'Filtro', cantidad: 1);
      final linea = (await db.query('insumos_locales')).single;
      await db.delete('cola_sincronizacion');
      await romperEncolado(db);

      await expectLater(cola.anularInsumo(linea), throwsA(isA<DatabaseException>()));

      final despues = (await db.query('insumos_locales')).single;
      expect(despues['anulada'] ?? 0, 0);
    });

    test('encolarFinalizar tambien revierte la OT finalizada si falla el encolado', () async {
      await sembrarOrden(db, 5);
      await romperEncolado(db);
      await expectLater(cola.encolarFinalizar(5, sinPersona: true, estadoEquipo: 'operativa'), throwsA(isA<DatabaseException>()));
      expect((await db.query('ordenes_locales', where: 'id = 5')).single['estado'], 'en_terreno');
    });
  });

  group('cola existente sigue funcionando', () {
    test('una tarea encolada se envia, sale de la cola y conserva su uuid_cliente', () async {
      await sembrarOrden(db, 5);
      await cola.encolarDiagnostico(5, diagnostico: 'Listo');
      final uuid = jsonDecode((await db.query('cola_sincronizacion')).single['payload'] as String)['uuid'];

      await cola.sincronizar();

      expect(api.llamadas, contains('PATCH /api/ordenes-trabajo/5/diagnostico'));
      expect(await enCola(), 0);
      expect(uuid, isNotEmpty);
    });

    test('un fallo de red no gasta intentos y deja la tarea pendiente', () async {
      await sembrarOrden(db, 5);
      await cola.encolarDiagnostico(5, diagnostico: 'Listo');
      api.errorAlEscribir = const SocketException('sin red');

      await cola.sincronizar();

      final tarea = (await db.query('cola_sincronizacion')).single;
      expect(tarea['estado'], 'pendiente');
      expect(tarea['intentos'], 0);
    });

    test('un fallo TLS tampoco gasta intentos', () async {
      await sembrarOrden(db, 5);
      await cola.encolarDiagnostico(5, diagnostico: 'Listo');
      api.errorAlEscribir = const HandshakeException('apreton cortado');

      await cola.sincronizar();

      final tarea = (await db.query('cola_sincronizacion')).single;
      expect(tarea['estado'], 'pendiente');
      expect(tarea['intentos'], 0);
      expect(tarea['ultimo_error'], contains('conexión segura'));
    });

    test('una respuesta cortada del servidor (FormatException de la llamada) no gasta intentos', () async {
      await sembrarOrden(db, 5);
      await cola.encolarDiagnostico(5, diagnostico: 'Listo');
      api.errorAlEscribir = const FormatException('Unexpected end of input', '{"id":', 6);

      await cola.sincronizar();

      final tarea = (await db.query('cola_sincronizacion')).single;
      expect(tarea['estado'], 'pendiente');
      expect(tarea['intentos'], 0);
      expect(tarea['ultimo_error'], contains('incompleta'));
    });

    test('una tarea guardada con el payload danado pasa a error sin gastar reintentos', () async {
      await sembrarOrden(db, 5);
      await db.insert('cola_sincronizacion', {
        'tipo': 'diagnostico',
        'orden_trabajo_id': 5,
        'payload': '{no es json',
        'estado': 'pendiente',
        'intentos': 0,
        'creado_en': DateTime.now().toIso8601String(),
      });

      await cola.sincronizar();

      final tarea = (await db.query('cola_sincronizacion')).single;
      expect(tarea['estado'], 'error');
      expect(tarea['ultimo_error'], contains('dañada'));
    });
  });

  group('uuid_cliente: los reintentos no duplican', () {
    late Directory carpetaArchivos;

    setUp(() async {
      carpetaArchivos = await Directory.systemTemp.createTemp('gomaq_uuid_test_');
    });

    tearDown(() async {
      try {
        await carpetaArchivos.delete(recursive: true);
      } catch (_) {}
    });

    // datos_ot y checklist mandan el payload completo (el uuid viaja como `uuid`); el resto, como `uuid_cliente`
    String? uuidEnviado(Map<String, dynamic> cuerpo) => (cuerpo['uuid_cliente'] ?? cuerpo['uuid']) as String?;

    Future<String> uuidGuardado() async =>
        jsonDecode((await db.query('cola_sincronizacion')).single['payload'] as String)['uuid'] as String;

    final tipos = <String, Future<void> Function(SyncService c, Directory carpeta)>{
      'diagnostico': (c, _) => c.encolarDiagnostico(5, diagnostico: 'Listo'),
      'finalizar': (c, _) => c.encolarFinalizar(5, sinPersona: true, estadoEquipo: 'operativa'),
      'datos_ot': (c, _) => c.encolarDatosOt(5, folioPapel: '123'),
      'checklist': (c, _) => c.encolarChecklist(5, [1, 2]),
      'tramo': (c, _) => c.encolarTramo(5, inicio: DateTime.now(), termino: DateTime.now()),
      'horometro': (c, _) => c.encolarHorometro(5, maquinariaId: 1, valor: 100),
      'insumo': (c, _) => c.encolarInsumo(5, insumoNombre: 'Filtro', cantidad: 1),
      'evidencia': (c, carpeta) {
        final foto = File('${carpeta.path}/ot5_777.jpg')..writeAsBytesSync([1, 2, 3]);
        return c.encolarEvidencia(5, foto.path);
      },
    };

    for (final entrada in tipos.entries) {
      test('${entrada.key}: envia uuid_cliente igual al uuid guardado en la tarea', () async {
        await sembrarOrden(db, 5);
        await entrada.value(cola, carpetaArchivos);
        final uuid = await uuidGuardado();
        expect(uuid, isNotEmpty);

        await cola.sincronizar();

        expect(await enCola(), 0);
        final enviados = api.cuerpos.map((c) => uuidEnviado(c.cuerpo)).whereType<String>().toList();
        expect(enviados, [uuid]);
      });
    }

    test('crear_ot: envia uuid_cliente igual al uuid guardado en la tarea', () async {
      await cola.encolarOtEnTerreno(maquinariaId: 2, maquinariaCodigo: 'EQ-2');
      final uuid = await uuidGuardado();

      await cola.sincronizar();

      final envio = api.cuerpos.firstWhere((c) => c.ruta == '/api/ordenes-trabajo/en-terreno');
      expect(envio.cuerpo['uuid_cliente'], uuid);
    });

    test('tras un SocketException el reintento envia el mismo uuid_cliente', () async {
      await sembrarOrden(db, 5);
      await cola.encolarHorometro(5, maquinariaId: 1, valor: 100);
      final uuid = await uuidGuardado();
      api.errorAlEscribir = const SocketException('sin red');

      await cola.sincronizar();
      expect(await enCola(), 1);

      api.errorAlEscribir = null;
      await cola.sincronizar();

      expect(await enCola(), 0);
      expect(api.cuerpos.map((c) => c.cuerpo['uuid_cliente']), [uuid, uuid]);
    });

    test('una tarea sin uuid (version antigua) recibe uno, se guarda antes de enviar y el reintento lo reusa', () async {
      await sembrarOrden(db, 5);
      await db.insert('cola_sincronizacion', {
        'tipo': 'horometro',
        'orden_trabajo_id': 5,
        'payload': jsonEncode({'maquinaria_id': 1, 'valor': 100, 'reiniciar_contador': false}),
        'estado': 'pendiente',
        'intentos': 0,
        'creado_en': DateTime.now().toIso8601String(),
      });
      api.errorAlEscribir = const SocketException('sin red');

      await cola.sincronizar();

      // el envio fallo, pero el uuid ya quedo guardado
      final uuid = await uuidGuardado();
      expect(uuid, isNotEmpty);
      expect(api.cuerpos.single.cuerpo['uuid_cliente'], uuid);

      api.errorAlEscribir = null;
      await cola.sincronizar();

      expect(await enCola(), 0);
      expect(api.cuerpos.map((c) => c.cuerpo['uuid_cliente']), [uuid, uuid]);
    });
  });

  group('rechazos repetidos del servidor', () {
    test('con 409 seguidos, tras el 4.o intento sigue pendiente y tras el 5.o pasa a error', () async {
      await sembrarOrden(db, 5);
      await cola.encolarDiagnostico(5, diagnostico: 'Listo');
      api.errorAlEscribir = ApiException(409, 'La orden ya está cerrada');

      for (var n = 1; n < maxIntentosSync; n++) {
        await cola.sincronizar();
        final tarea = (await db.query('cola_sincronizacion')).single;
        expect(tarea['intentos'], n);
        expect(tarea['estado'], 'pendiente', reason: 'despues del intento $n');
        expect(tarea['ultimo_error'], 'La orden ya está cerrada');
      }

      await cola.sincronizar();
      final tarea = (await db.query('cola_sincronizacion')).single;
      expect(tarea['intentos'], maxIntentosSync);
      expect(tarea['estado'], 'error');
    });
  });

  group('archivos locales tras la subida', () {
    late Directory carpetaArchivos;

    setUp(() async {
      carpetaArchivos = await Directory.systemTemp.createTemp('gomaq_archivos_test_');
    });

    tearDown(() async {
      try {
        await carpetaArchivos.delete(recursive: true);
      } catch (_) {}
    });

    test('la foto local se borra al confirmarse la subida y la lista de evidencias la sigue mostrando', () async {
      await sembrarOrden(db, 5);
      final foto = File('${carpetaArchivos.path}/ot5_111.jpg')..writeAsBytesSync([1, 2, 3]);
      await cola.encolarEvidencia(5, foto.path, tipo: 'antes');

      await cola.sincronizar();

      expect(subidas.single.method, 'PUT');
      expect(api.llamadas, contains('POST /api/ordenes-trabajo/5/evidencia/confirmar'));
      expect(foto.existsSync(), isFalse);
      expect(await enCola(), 0);
      final fila = (await db.query('evidencias_locales')).single;
      expect(fila['sincronizado'], 1);
      expect(fila['ruta_local'], foto.path);
    });

    test('si la confirmacion falla, la foto NO se borra y el reintento no vuelve a subirla', () async {
      await sembrarOrden(db, 5);
      final foto = File('${carpetaArchivos.path}/ot5_222.jpg')..writeAsBytesSync([1, 2, 3]);
      await cola.encolarEvidencia(5, foto.path);

      // la subida (PUT) sale bien y la confirmacion se pierde por falta de red
      api.errorEnConfirmar = const SocketException('sin red');
      await cola.sincronizar();
      expect(subidas, hasLength(1));
      expect(foto.existsSync(), isTrue);
      expect(await enCola(), 1);

      api.errorEnConfirmar = null;
      await cola.sincronizar();
      expect(subidas, hasLength(1));
      expect(foto.existsSync(), isFalse);
      expect(await enCola(), 0);
    });

    test('la firma se borra cuando el cierre llego al servidor, no antes', () async {
      await sembrarOrden(db, 5);
      final firma = File('${carpetaArchivos.path}/ot5_firma_333.png')..writeAsBytesSync([9, 9]);
      await cola.encolarFinalizar(5, personaRecibe: 'Juan', rutaFirmaLocal: firma.path, estadoEquipo: 'operativa');

      // la firma sube bien pero el PATCH del cierre falla: la firma debe seguir en el telefono
      api.errorEnPatch = const SocketException('sin red');
      await cola.sincronizar();
      expect(firma.existsSync(), isTrue);

      api.errorEnPatch = null;
      await cola.sincronizar();
      expect(api.llamadas, contains('PATCH /api/ordenes-trabajo/5/finalizar'));
      expect(firma.existsSync(), isFalse);
    });
  });
}
