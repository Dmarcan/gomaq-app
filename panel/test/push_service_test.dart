import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/services/push_config.dart';
import 'package:gomaq_web/services/push_service.dart';
import 'package:gomaq_web/widgets/boton_avisos.dart';

const _configWeb = ConfigPush(apiKey: 'k', appId: 'a', senderId: 's', projectId: 'p', vapidKey: 'v');
const _configAndroid = ConfigPush(apiKey: 'k', appId: 'a', senderId: 's', projectId: 'p');

class _PlataformaFalsa implements PushPlataforma {
  PermisoAvisos permiso;
  PermisoAvisos alPedir;
  bool esSoportado = true;
  String? token = 'tok-1';
  int inicializaciones = 0;
  int pedidos = 0;
  bool tokenBorrado = false;
  MensajePush? inicial;
  final renovar = StreamController<String>.broadcast();
  final primerPlano = StreamController<MensajePush>.broadcast();
  final abrir = StreamController<MensajePush>.broadcast();

  _PlataformaFalsa({this.permiso = PermisoAvisos.concedido, this.alPedir = PermisoAvisos.concedido});

  @override
  Future<void> inicializar(ConfigPush config) async => inicializaciones++;
  @override
  Future<bool> soportado() async => esSoportado;
  @override
  Future<PermisoAvisos> estadoPermiso() async => permiso;
  @override
  Future<PermisoAvisos> pedirPermiso() async {
    pedidos++;
    permiso = alPedir;
    return alPedir;
  }

  @override
  Future<String?> obtenerToken(ConfigPush config) async => token;
  @override
  Stream<String> get alRenovarToken => renovar.stream;
  @override
  Stream<MensajePush> get alRecibirEnPrimerPlano => primerPlano.stream;
  @override
  Stream<MensajePush> get alAbrirDesdeNotificacion => abrir.stream;
  @override
  Future<MensajePush?> mensajeInicial() async => inicial;
  @override
  Future<void> borrarToken() async => tokenBorrado = true;
}

class _ApiFalsa implements ApiPush {
  final llamadas = <String>[];
  final cuerpos = <Map<String, dynamic>>[];
  Object? errorAlPost;

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body) async {
    llamadas.add('POST $path');
    cuerpos.add(body);
    if (errorAlPost != null) throw errorAlPost!;
    return {};
  }

  @override
  Future<dynamic> delete(String path, Map<String, dynamic> body) async {
    llamadas.add('DELETE $path');
    cuerpos.add(body);
    return null;
  }
}

PushService _servicio(
  _PlataformaFalsa p,
  _ApiFalsa api, {
  ConfigPush config = _configWeb,
  bool web = true,
  Map<String, String>? flags,
}) =>
    PushService(
      config: config,
      plataforma: p,
      api: api,
      web: web,
      leerFlag: (c) async => flags?[c],
      guardarFlag: (c, v) async => flags?[c] = v,
    );

Future<void> _iniciar(
  PushService s, {
  Future<bool> Function()? explicar,
  List<MensajePush>? abiertos,
  List<MensajePush>? avisos,
  void Function()? alRecibir,
}) =>
    s.iniciar(
      explicarPermiso: explicar ?? () async => true,
      alAbrir: (m) => abiertos?.add(m),
      mostrarAviso: (m) => avisos?.add(m),
      alRecibir: alRecibir,
    );

void main() {
  group('configuracion', () {
    test('sin dart-define la config esta incompleta', () {
      expect(ConfigPush.desdeEntorno.completa, isFalse);
    });
    test('en la web tambien hace falta la clave VAPID; en Android no', () {
      expect(_configAndroid.completaPara(web: false), isTrue);
      expect(_configAndroid.completaPara(web: true), isFalse);
      expect(_configWeb.completaPara(web: true), isTrue);
      expect(const ConfigPush(apiKey: 'k', appId: 'a', projectId: 'p').completaPara(web: false), isFalse);
      expect(const ConfigPush(apiKey: ' ', appId: 'a', senderId: 's', projectId: 'p').completaPara(web: false), isFalse);
    });
  });

  group('rutaDeAviso', () {
    test('con una OT abre la OT; sin ella, el inicio (pendientes)', () {
      expect(rutaDeAviso({'orden_trabajo_id': '42'}, esCliente: false), '/ordenes/42');
      expect(rutaDeAviso({'orden_trabajo_id': 42}, esCliente: false), '/ordenes/42');
      expect(rutaDeAviso({'tipo': 'ot_por_valorizar'}, esCliente: false), '/');
      expect(rutaDeAviso({'orden_trabajo_id': 'abc'}, esCliente: false), '/');
      expect(rutaDeAviso({'orden_trabajo_id': '0'}, esCliente: false), '/');
    });
    test('el cliente siempre queda en el portal', () {
      expect(rutaDeAviso({'orden_trabajo_id': '42'}, esCliente: true), '/portal');
      expect(rutaDeAviso({}, esCliente: true), '/portal');
    });
  });

  group('PushService', () {
    test('sin config no inicializa Firebase, no llama al servidor y el boton no se muestra', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = _servicio(p, api, config: const ConfigPush());
      await _iniciar(s);
      expect(s.activo, isFalse);
      expect(s.configurado, isFalse);
      expect(s.estado.value, EstadoAvisos.noDisponible);
      expect(p.inicializaciones, 0);
      expect(api.llamadas, isEmpty);
      await s.alCerrarSesion(avisarServidor: true);
      expect(p.tokenBorrado, isFalse);
    });

    test('navegador sin soporte: no disponible y sin registro', () async {
      final p = _PlataformaFalsa()..esSoportado = false;
      final api = _ApiFalsa();
      final s = _servicio(p, api);
      await _iniciar(s);
      expect(s.estado.value, EstadoAvisos.noDisponible);
      expect(api.llamadas, isEmpty);
    });

    test('permiso ya concedido: registra el token con app panel y plataforma web', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = _servicio(p, api);
      await _iniciar(s);
      expect(api.llamadas, ['POST /api/dispositivos']);
      expect(api.cuerpos.single, {'token': 'tok-1', 'plataforma': 'web', 'app': 'panel'});
      expect(s.estado.value, EstadoAvisos.activados);
      expect(p.pedidos, 0);
    });

    test('en Android registra plataforma android', () async {
      final api = _ApiFalsa();
      final s = _servicio(_PlataformaFalsa(), api, config: _configAndroid, web: false);
      await _iniciar(s);
      expect(api.cuerpos.single['plataforma'], 'android');
    });

    test('web: nunca pide permiso al cargar; queda por activar hasta que la persona lo pide', () async {
      final p = _PlataformaFalsa(permiso: PermisoAvisos.pendiente);
      final api = _ApiFalsa();
      var dialogos = 0;
      final s = _servicio(p, api);
      await _iniciar(s, explicar: () async {
        dialogos++;
        return true;
      });
      expect(p.pedidos, 0);
      expect(dialogos, 0);
      expect(s.estado.value, EstadoAvisos.porActivar);
      expect(api.llamadas, isEmpty);

      await s.activar();
      expect(p.pedidos, 1);
      expect(s.estado.value, EstadoAvisos.activados);
      expect(api.llamadas, ['POST /api/dispositivos']);
    });

    test('web: si el navegador lo bloquea queda bloqueado y no registra', () async {
      final p = _PlataformaFalsa(permiso: PermisoAvisos.pendiente, alPedir: PermisoAvisos.denegado);
      final api = _ApiFalsa();
      final s = _servicio(p, api);
      await _iniciar(s);
      await s.activar();
      expect(s.estado.value, EstadoAvisos.bloqueados);
      expect(api.llamadas, isEmpty);
    });

    test('web: permiso ya denegado al abrir: bloqueado sin preguntar', () async {
      final p = _PlataformaFalsa(permiso: PermisoAvisos.denegado);
      final s = _servicio(p, _ApiFalsa());
      await _iniciar(s);
      expect(s.estado.value, EstadoAvisos.bloqueados);
      expect(p.pedidos, 0);
    });

    test('Android: dialogo previo una sola vez; si lo rechaza no vuelve a preguntar', () async {
      final flags = <String, String>{};
      var dialogos = 0;
      Future<bool> no() async {
        dialogos++;
        return false;
      }

      final p = _PlataformaFalsa(permiso: PermisoAvisos.pendiente);
      final s = _servicio(p, _ApiFalsa(), config: _configAndroid, web: false, flags: flags);
      await _iniciar(s, explicar: no);
      expect(dialogos, 1);
      expect(p.pedidos, 0);
      expect(s.estado.value, EstadoAvisos.porActivar);
      await _iniciar(s, explicar: no);
      expect(dialogos, 1);
    });

    test('Android: si acepta el dialogo pide el permiso del sistema y registra', () async {
      final api = _ApiFalsa();
      final p = _PlataformaFalsa(permiso: PermisoAvisos.pendiente);
      final s = _servicio(p, api, config: _configAndroid, web: false, flags: {});
      await _iniciar(s);
      expect(p.pedidos, 1);
      expect(api.llamadas, ['POST /api/dispositivos']);
      expect(s.estado.value, EstadoAvisos.activados);
    });

    test('un 404 del servidor (ruta aun no desplegada) se ignora', () async {
      final api = _ApiFalsa()..errorAlPost = ApiException(404, 'No encontrado');
      final s = _servicio(_PlataformaFalsa(), api);
      await _iniciar(s);
      expect(s.tokenActual, isNull);
      expect(s.estado.value, EstadoAvisos.activados);
    });

    test('sin senal tampoco rompe', () async {
      final api = _ApiFalsa()..errorAlPost = TimeoutException('sin senal');
      final s = _servicio(_PlataformaFalsa(), api);
      await _iniciar(s);
      expect(s.activo, isTrue);
    });

    test('token renovado se registra de nuevo', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = _servicio(p, api);
      await _iniciar(s);
      p.renovar.add('tok-2');
      await Future<void>.delayed(Duration.zero);
      expect(api.cuerpos.last['token'], 'tok-2');
    });

    test('con el panel abierto muestra el aviso y refresca; al tocarlo abre', () async {
      final p = _PlataformaFalsa();
      final avisos = <MensajePush>[];
      final abiertos = <MensajePush>[];
      var refrescos = 0;
      final s = _servicio(p, _ApiFalsa());
      await _iniciar(s, avisos: avisos, abiertos: abiertos, alRecibir: () => refrescos++);
      const m = MensajePush(titulo: 'Orden', cuerpo: 'OT #7', data: {'orden_trabajo_id': '7'});
      p.primerPlano.add(m);
      p.abrir.add(m);
      await Future<void>.delayed(Duration.zero);
      expect(avisos, [m]);
      expect(refrescos, 1);
      expect(abiertos, [m]);
    });

    test('al cerrar sesion: DELETE con el token, borra el de Firebase y deja de escuchar', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final avisos = <MensajePush>[];
      final s = _servicio(p, api);
      await _iniciar(s, avisos: avisos);
      await s.alCerrarSesion(avisarServidor: true);
      expect(api.llamadas, ['POST /api/dispositivos', 'DELETE /api/dispositivos']);
      expect(api.cuerpos.last, {'token': 'tok-1'});
      expect(p.tokenBorrado, isTrue);
      expect(s.tokenActual, isNull);
      expect(s.estado.value, EstadoAvisos.noDisponible);
      p.primerPlano.add(const MensajePush(titulo: 'x'));
      await Future<void>.delayed(Duration.zero);
      expect(avisos, isEmpty);
    });

    test('sesion vencida: no llama al servidor pero si suelta el token', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = _servicio(p, api);
      await _iniciar(s);
      await s.alCerrarSesion(avisarServidor: false);
      expect(api.llamadas, ['POST /api/dispositivos']);
      expect(p.tokenBorrado, isTrue);
    });
  });

  group('BotonAvisos', () {
    Future<PushService> montar(WidgetTester t, EstadoAvisos e, {ConfigPush config = _configWeb, double ancho = 375}) async {
      t.view.physicalSize = Size(ancho, 800);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      final s = _servicio(_PlataformaFalsa(permiso: PermisoAvisos.pendiente), _ApiFalsa(), config: config);
      s.estado.value = e;
      await t.pumpWidget(MaterialApp(
        home: Scaffold(
          appBar: AppBar(title: const Text('Portal'), actions: [BotonAvisos(servicio: s)]),
        ),
      ));
      return s;
    }

    testWidgets('sin config no dibuja nada', (t) async {
      await montar(t, EstadoAvisos.porActivar, config: const ConfigPush());
      expect(find.byType(IconButton), findsNothing);
    });

    for (final e in EstadoAvisos.values) {
      testWidgets('estado $e: nombre accesible, objetivo tactil y 375 px sin desbordes', (t) async {
        final h = t.ensureSemantics();
        await montar(t, e);
        expect(find.byTooltip(etiquetaAvisos(e)), findsOneWidget);
        await expectLater(t, meetsGuideline(labeledTapTargetGuideline));
        final tam = t.getSize(find.byType(IconButton));
        expect(tam.width, greaterThanOrEqualTo(40));
        expect(tam.height, greaterThanOrEqualTo(40));
        expect(t.takeException(), isNull);
        h.dispose();
      });
    }

    testWidgets('por activar: tocar llama a activar (y es la unica via de pedir el permiso)', (t) async {
      final s = await montar(t, EstadoAvisos.porActivar);
      final p = s;
      expect(p.activo, isFalse); // sin iniciar: activar() no hace nada, no hay dialogo
      await t.tap(find.byType(IconButton));
      await t.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('bloqueado: explica como desbloquear en un dialogo con titulo de encabezado', (t) async {
      await montar(t, EstadoAvisos.bloqueados);
      await t.tap(find.byType(IconButton));
      await t.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.textContaining('configuración del navegador'), findsOneWidget);
      await t.tap(find.text('Entendido'));
      await t.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('no disponible: menciona la limitacion de iPhone (solo PWA instalada)', (t) async {
      await montar(t, EstadoAvisos.noDisponible);
      await t.tap(find.byType(IconButton));
      await t.pumpAndSettle();
      expect(find.textContaining('iOS 16.4'), findsOneWidget);
    });

    testWidgets('se puede activar con teclado (Enter)', (t) async {
      final p = _PlataformaFalsa(permiso: PermisoAvisos.pendiente);
      final api = _ApiFalsa();
      final s = _servicio(p, api);
      await s.iniciar(explicarPermiso: () async => true, alAbrir: (_) {}, mostrarAviso: (_) {});
      expect(s.estado.value, EstadoAvisos.porActivar);
      await t.pumpWidget(MaterialApp(home: Scaffold(appBar: AppBar(actions: [BotonAvisos(servicio: s)]))));
      await t.sendKeyEvent(LogicalKeyboardKey.tab);
      await t.pump();
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(p.pedidos, 1);
      expect(s.estado.value, EstadoAvisos.activados);
    });
  });
}
