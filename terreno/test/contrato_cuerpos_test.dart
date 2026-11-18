// Contrato entre la app del mecanico y el backend: los cuerpos que la cola envia a cada ruta.
//
// La prueba arma cada tarea con el codigo REAL de la app (`SyncService.encolar*`, que a su vez usa
// `cuerpoFinalizar`, `cuerpoDiagnostico` y `cuerpoPosicion`), la despacha con un cliente HTTP falso
// que solo anota lo que recibe, y compara metodo, ruta y cuerpo con el fixture
// `backend/test/fixtures/terreno_cuerpos_<version>.json`. El backend (`contratoTerreno.test.js`) envia
// ese mismo fixture a sus rutas reales y espera 2xx, tambien al repetirlo. Asi, si alguien cambia el
// nombre de un campo en la app o en el servidor, una de las dos pruebas falla en el CI.
//
// Versiones: los telefonos se actualizan a mano y conviven versiones antiguas con tareas por
// sincronizar. Por eso un fixture nunca se edita: cuando cambie un cuerpo, subir `versionContrato`
// (v2), generar el fixture nuevo y CONSERVAR el anterior mientras queden telefonos con esa version.
// El backend prueba todos los fixtures que existan; esta prueba solo compara el de la version actual.
//
// Generar el fixture de una version nueva (o regenerar uno recien creado):
//   cd terreno
//   GOMAQ_ESCRIBIR_FIXTURE=1 flutter test test/contrato_cuerpos_test.dart       (PowerShell: $env:GOMAQ_ESCRIBIR_FIXTURE='1')
//
// Los datos son fijos. Lo que la app genera en cada corrida (uuid de la tarea y horas del momento) se
// reemplaza por valores fijos antes de comparar; antes se comprueba que tengan la forma correcta.
//
// Convenciones del fixture, que el backend resuelve al enviar:
//   - las rutas usan :orden, :equipo y :linea en lugar de los ids de esta prueba (5, 1 y 9);
//   - el segmento `ot-5/` de una ruta de archivo se reemplaza por la orden real;
//   - los uuid y las horas se reemplazan por valores nuevos en cada corrida (no deben repetirse).

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/services/sync_service.dart';
import 'package:gomaq_mecanico/utils/navegacion.dart' show cuerpoPosicion;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite/sqflite.dart';

import 'ayuda_cola.dart';

/// Version del contrato que implementa el codigo actual (los telefonos de hoy). Ver la cabecera.
const versionContrato = 'v1';

const _ordenPrueba = 5;
const _equipoPrueba = 1;
const _lineaPrueba = 9;
const _horaFija = '2026-01-15T14:30:00.000Z';

final _formaUuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

/// Cliente falso que responde lo minimo que el servidor real (ids de lo creado, rutas de archivo).
class _ApiContrato extends ApiFalsa {
  @override
  Future<dynamic> post(String path, Map<String, dynamic> body) async {
    await super.post(path, body);
    if (path == '/api/ordenes-trabajo/en-terreno') return {'id': 77};
    if (path == '/api/insumos/orden/$_ordenPrueba') return {'id': _lineaPrueba};
    if (path.endsWith('/solicitar-upload')) {
      final esFirma = body['carpeta'] == 'firmas';
      return {
        'signedUrl': 'https://almacen.falso/subida',
        'path': esFirma ? 'firmas/ot-$_ordenPrueba/firma.png' : 'ot-$_ordenPrueba/${body['nombre_archivo']}',
      };
    }
    return <String, dynamic>{};
  }
}

String _rutaSimbolica(String ruta) => ruta
    .replaceAll('/linea/$_lineaPrueba/', '/linea/:linea/')
    .replaceAll('/maquinaria/$_equipoPrueba', '/maquinaria/:equipo')
    .replaceAll('/ordenes-trabajo/$_ordenPrueba/', '/ordenes-trabajo/:orden/')
    .replaceAll('/insumos/orden/$_ordenPrueba', '/insumos/orden/:orden');

String _tipoDe(String metodo, String ruta) {
  if (ruta.endsWith('/en-terreno')) return 'crear_ot';
  if (ruta.endsWith('/diagnostico')) return 'diagnostico';
  if (ruta.endsWith('/posicion')) return 'posicion';
  if (ruta.endsWith('/datos')) return 'datos_ot';
  if (ruta.endsWith('/checklist')) return 'checklist';
  if (ruta.endsWith('/tramos')) return 'tramo';
  if (ruta.contains('/horometro/')) return 'horometro';
  if (ruta.endsWith('/anular')) return 'anular_insumo';
  if (ruta.contains('/insumos/orden/')) return 'insumo';
  if (ruta.endsWith('/solicitar-upload')) return 'solicitar_subida';
  if (ruta.endsWith('/confirmar')) return 'evidencia';
  if (ruta.endsWith('/finalizar')) return 'finalizar';
  throw StateError('Ruta sin tipo conocido en el contrato: $metodo $ruta');
}

/// Reemplaza lo que cambia en cada corrida por valores fijos, y comprueba antes que tenga la forma
/// correcta (si el uuid o la hora dejaran de generarse bien, la prueba falla aqui y no queda tapado).
Object? _normalizar(Object? valor, String? clave, int numeroPaso) {
  if (valor is Map) {
    return {for (final e in valor.entries) e.key as String: _normalizar(e.value, e.key as String, numeroPaso)};
  }
  if (valor is List) return [for (final e in valor) _normalizar(e, null, numeroPaso)];
  if (clave == 'uuid' || clave == 'uuid_cliente') {
    expect(valor, isA<String>(), reason: 'paso $numeroPaso: $clave debe ser un texto');
    expect(valor as String, matches(_formaUuid), reason: 'paso $numeroPaso: $clave debe ser un UUID');
    return '00000000-0000-4000-8000-${numeroPaso.toString().padLeft(12, '0')}';
  }
  if (clave == 'ocurrio_en' || clave == 'capturada_en') {
    expect(valor, isA<String>(), reason: 'paso $numeroPaso: $clave debe ser un texto');
    final fecha = DateTime.tryParse(valor as String);
    expect(fecha, isNotNull, reason: 'paso $numeroPaso: $clave debe ser una fecha ISO');
    expect(valor, endsWith('Z'), reason: 'paso $numeroPaso: $clave debe ir en UTC');
    return _horaFija;
  }
  return valor;
}

File _archivoFixture() {
  // `flutter test` corre con terreno/ como carpeta actual
  return File('../backend/test/fixtures/terreno_cuerpos_$versionContrato.json');
}

void main() {
  late Directory carpetaBase;
  late Directory carpetaArchivos;

  setUpAll(() async {
    carpetaBase = await prepararBaseDePruebas();
    carpetaArchivos = await Directory.systemTemp.createTemp('gomaq_contrato_');
  });

  tearDownAll(() async {
    for (final carpeta in [carpetaBase, carpetaArchivos]) {
      try {
        await carpeta.delete(recursive: true);
      } catch (_) {}
    }
  });

  test('los cuerpos que la cola envia a cada ruta son los del fixture $versionContrato', () async {
    final db = await baseLimpia();
    await sembrarOrden(db, _ordenPrueba, estado: 'asignada');
    final api = _ApiContrato();
    final cola = SyncService(api: api, clienteHttp: MockClient((_) async => http.Response('', 200)));

    final foto = await File('${carpetaArchivos.path}${Platform.pathSeparator}foto_contrato.jpg').writeAsBytes([0xFF, 0xD8, 0xFF, 0xD9]);
    final foto2 = await File('${carpetaArchivos.path}${Platform.pathSeparator}foto_contrato_despues.jpg').writeAsBytes([0xFF, 0xD8, 0xFF, 0xD9]);
    final firma = await File('${carpetaArchivos.path}${Platform.pathSeparator}firma_contrato.png').writeAsBytes([0x89, 0x50, 0x4E, 0x47]);

    // el orden es el del trabajo de un mecanico: la cola procesa por id, asi que se envia en este mismo orden
    await cola.encolarOtEnTerreno(maquinariaId: _equipoPrueba, maquinariaCodigo: 'EQ-1', motivo: 'Segundo equipo de la visita');
    await cola.encolarDiagnostico(_ordenPrueba, estado: 'aceptada');
    final posicion = cuerpoPosicion(
      latitud: -33.45,
      longitud: -70.66,
      precisionMetros: 12.4,
      capturadaEn: DateTime.utc(2026, 1, 15, 14, 29),
    )!;
    await cola.encolarDiagnostico(_ordenPrueba, estado: 'en_camino', posicion: posicion);
    await cola.encolarDiagnostico(_ordenPrueba, diagnostico: 'Fuga de aceite en el cilindro', estado: 'en_terreno');
    await cola.encolarDatosOt(
      _ordenPrueba,
      tipoServicio: 'reparacion',
      diagnostico: 'Fuga de aceite en el cilindro',
      observacionFinal: 'Se cambio el sello',
      folioPapel: '1234',
    );
    await cola.encolarChecklist(_ordenPrueba, [1, 2]);
    await cola.encolarTramo(_ordenPrueba, inicio: DateTime.utc(2026, 1, 15, 15));
    await cola.encolarTramo(_ordenPrueba, inicio: DateTime.utc(2026, 1, 15, 15), termino: DateTime.utc(2026, 1, 15, 17));
    await cola.encolarHorometro(_ordenPrueba, maquinariaId: _equipoPrueba, valor: 51000.5, observacion: 'Lectura al llegar');
    // orden 0: lectura de un equipo desde Flota, sin orden de trabajo
    await cola.encolarHorometro(0, maquinariaId: _equipoPrueba, valor: 51001);
    await cola.encolarInsumo(_ordenPrueba,
        insumoId: 7, insumoNombre: 'Filtro de aceite', cantidad: 2, precioUnitario: 15990, facturable: 'si');
    await cola.encolarInsumo(_ordenPrueba, insumoNombre: 'Sello', cantidad: 1.5, descripcion: 'Sello hidraulico');
    final libre = (await db.query('insumos_locales', where: 'insumo_id IS NULL')).single;
    await cola.anularInsumo({'id': libre['id'], 'orden_trabajo_id': _ordenPrueba, 'sincronizado': 0});
    await cola.encolarEvidencia(_ordenPrueba, foto.path, tipo: 'antes');
    await cola.encolarEvidencia(_ordenPrueba, foto2.path, tipo: 'despues');
    await cola.encolarFinalizar(_ordenPrueba, personaRecibe: 'Juan Perez', rutaFirmaLocal: firma.path, estadoEquipo: 'operativa');

    await cola.sincronizar();

    final pendientes = Sqflite.firstIntValue(await db.rawQuery("SELECT COUNT(*) FROM cola_sincronizacion WHERE estado <> 'enviado'"));
    expect(api.cuerpos.where((c) => c.metodo != 'GET'), isNotEmpty);
    expect(pendientes, anyOf(0, isNull), reason: 'toda la cola debe haber salido; si no, falta un paso del contrato');

    final pasos = <Map<String, dynamic>>[];
    for (final llamada in api.cuerpos) {
      final tipo = _tipoDe(llamada.metodo, llamada.ruta);
      pasos.add({
        'tipo': tipo,
        'metodo': llamada.metodo,
        'ruta': _rutaSimbolica(llamada.ruta),
        'cuerpo': llamada.cuerpo,
      });
      // la posicion suelta (la que manda el servicio en primer plano, no la cola) va justo despues de
      // la que viaja con el cambio a en camino
      if (tipo == 'diagnostico' && llamada.cuerpo['estado'] == 'en_camino') {
        pasos.add({
          'tipo': 'posicion',
          'metodo': 'POST',
          'ruta': '/api/ordenes-trabajo/:orden/posicion',
          'cuerpo': cuerpoPosicion(
            latitud: -33.451,
            longitud: -70.661,
            precisionMetros: 8,
            capturadaEn: DateTime.utc(2026, 1, 15, 14, 29, 30),
          ),
        });
      }
    }
    final normalizados = [
      for (var i = 0; i < pasos.length; i++)
        {...pasos[i], 'cuerpo': _normalizar(pasos[i]['cuerpo'], null, i + 1)},
    ];
    final actual = {
      'version': versionContrato,
      'nota': 'Generado por terreno/test/contrato_cuerpos_test.dart. No editar a mano: ver la cabecera de esa prueba.',
      'pasos': normalizados,
    };

    final archivo = _archivoFixture();
    final textoActual = '${const JsonEncoder.withIndent('  ').convert(actual)}\n';

    if (Platform.environment['GOMAQ_ESCRIBIR_FIXTURE'] == '1') {
      await archivo.create(recursive: true);
      await archivo.writeAsString(textoActual);
      return;
    }

    expect(archivo.existsSync(), isTrue,
        reason: 'Falta ${archivo.path}. Para crearlo: GOMAQ_ESCRIBIR_FIXTURE=1 flutter test test/contrato_cuerpos_test.dart');
    final esperado = jsonDecode(await archivo.readAsString());
    expect(
      jsonDecode(textoActual),
      equals(esperado),
      reason: 'Los cuerpos que la cola envia al backend cambiaron respecto de ${archivo.path}.\n'
          'Si el cambio es intencional y hay telefonos con la version anterior: subir `versionContrato` en esta prueba, '
          'generar el fixture nuevo con GOMAQ_ESCRIBIR_FIXTURE=1 y CONSERVAR el anterior (el backend sigue probandolo).\n'
          'Si fue sin querer, revertir el cambio en la app.',
    );
  });
}
