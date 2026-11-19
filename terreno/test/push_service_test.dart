import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/services/api_client.dart';
import 'package:gomaq_mecanico/services/push_config.dart';
import 'package:gomaq_mecanico/services/push_service.dart';
import 'package:gomaq_mecanico/widgets/dialogo_permiso_avisos.dart';

const _configOk = ConfigPush(apiKey: 'k', appId: 'a', senderId: 's', projectId: 'p');

class _PlataformaFalsa implements PushPlataforma {
  bool permiso;
  final bool concedeAlPedir = true;
  String? token = 'tok-1';
  int inicializaciones = 0;
  int pedidos = 0;
  bool tokenBorrado = false;
  MensajePush? inicial;
  final renovar = StreamController<String>.broadcast();
  final primerPlano = StreamController<MensajePush>.broadcast();
  final abrir = StreamController<MensajePush>.broadcast();

  _PlataformaFalsa({this.permiso = true});

  @override
  Future<void> inicializar(ConfigPush config) async => inicializaciones++;
  @override
  Future<bool> permisoConcedido() async => permiso;
  @override
  Future<bool> pedirPermiso() async {
    pedidos++;
    permiso = concedeAlPedir;
    return concedeAlPedir;
  }

  @override
  Future<String?> obtenerToken() async => token;
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

Future<void> _iniciar(
  PushService s, {
  Future<bool> Function()? explicar,
  List<String>? eventos,
  Future<bool> Function(int)? existe,
  List<DestinoPush>? destinos,
  List<MensajePush>? avisos,
}) =>
    s.iniciar(
      explicarPermiso: explicar ?? () async => true,
      sincronizar: () async => eventos?.add('sync'),
      existeOrdenLocal: existe ?? (id) async => true,
      alAbrir: (d) => destinos?.add(d),
      mostrarAviso: (m) => avisos?.add(m),
    );

void main() {
  group('configuracion', () {
    test('sin dart-define la config esta incompleta', () {
      expect(ConfigPush.desdeEntorno.completa, isFalse);
    });
    test('falta cualquiera de los cuatro datos: incompleta', () {
      expect(const ConfigPush(apiKey: 'k', appId: 'a', senderId: 's').completa, isFalse);
      expect(const ConfigPush(apiKey: 'k', appId: 'a', projectId: 'p').completa, isFalse);
      expect(const ConfigPush(apiKey: ' ', appId: 'a', senderId: 's', projectId: 'p').completa, isFalse);
      expect(_configOk.completa, isTrue);
    });
  });

  group('PushService', () {
    test('sin config no inicializa Firebase ni llama al servidor', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = PushService(config: const ConfigPush(), plataforma: p, api: api);
      await _iniciar(s);
      expect(s.activo, isFalse);
      expect(p.inicializaciones, 0);
      expect(api.llamadas, isEmpty);
      await s.alCerrarSesion(avisarServidor: true);
      expect(p.tokenBorrado, isFalse);
    });

    test('con permiso registra el token en POST /api/dispositivos', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = PushService(config: _configOk, plataforma: p, api: api);
      await _iniciar(s);
      expect(s.activo, isTrue);
      expect(p.inicializaciones, 1);
      expect(api.llamadas, ['POST /api/dispositivos']);
      expect(api.cuerpos.single, {'token': 'tok-1', 'plataforma': 'android', 'app': 'terreno'});
    });

    test('un 404 (ruta aun no desplegada) se ignora sin lanzar', () async {
      final api = _ApiFalsa()..errorAlPost = ApiException(404, 'no encontrado');
      final s = PushService(config: _configOk, plataforma: _PlataformaFalsa(), api: api);
      await _iniciar(s);
      expect(api.llamadas.length, 1);
      expect(s.tokenActual, isNull);
    });

    test('un error de red tampoco rompe; al reabrir se reintenta', () async {
      final api = _ApiFalsa()..errorAlPost = TimeoutException('lento');
      final s = PushService(config: _configOk, plataforma: _PlataformaFalsa(), api: api);
      await _iniciar(s);
      api.errorAlPost = null;
      await _iniciar(s);
      expect(api.llamadas.length, 2);
      expect(s.tokenActual, 'tok-1');
    });

    test('al renovarse el token se registra el nuevo', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = PushService(config: _configOk, plataforma: p, api: api);
      await _iniciar(s);
      p.renovar.add('tok-2');
      await Future<void>.delayed(Duration.zero);
      expect(api.cuerpos.last['token'], 'tok-2');
      expect(s.tokenActual, 'tok-2');
    });

    test('sin permiso explica una vez; si lo niega no insiste ni registra', () async {
      final p = _PlataformaFalsa(permiso: false);
      final api = _ApiFalsa();
      final guardado = <String, String>{};
      var explicaciones = 0;
      final s = PushService(
        config: _configOk,
        plataforma: p,
        api: api,
        leerFlag: (c) async => guardado[c],
        guardarFlag: (c, v) async => guardado[c] = v,
      );
      Future<bool> explicar() async {
        explicaciones++;
        return false;
      }

      await _iniciar(s, explicar: explicar);
      await _iniciar(s, explicar: explicar);
      expect(explicaciones, 1);
      expect(p.pedidos, 0);
      expect(api.llamadas, isEmpty);
    });

    test('si acepta el dialogo se pide el permiso del sistema y se registra', () async {
      final p = _PlataformaFalsa(permiso: false);
      final api = _ApiFalsa();
      final s = PushService(
        config: _configOk,
        plataforma: p,
        api: api,
        leerFlag: (c) async => null,
        guardarFlag: (c, v) async {},
      );
      await _iniciar(s);
      expect(p.pedidos, 1);
      expect(api.llamadas, ['POST /api/dispositivos']);
    });

    test('con la app abierta muestra el aviso y sincroniza', () async {
      final p = _PlataformaFalsa();
      final eventos = <String>[];
      final avisos = <MensajePush>[];
      final s = PushService(config: _configOk, plataforma: p, api: _ApiFalsa());
      await _iniciar(s, eventos: eventos, avisos: avisos);
      p.primerPlano.add(const MensajePush(titulo: 'Nueva orden', cuerpo: 'OT #7', data: {}));
      await Future<void>.delayed(Duration.zero);
      expect(avisos.single.titulo, 'Nueva orden');
      expect(eventos, ['sync']);
    });

    test('al tocar el aviso sincroniza y abre la OT si esta en la base local', () async {
      final p = _PlataformaFalsa();
      final eventos = <String>[];
      final destinos = <DestinoPush>[];
      final s = PushService(config: _configOk, plataforma: p, api: _ApiFalsa());
      await _iniciar(s, eventos: eventos, destinos: destinos);
      p.abrir.add(const MensajePush(data: {'orden_trabajo_id': '42'}));
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(eventos, ['sync']);
      expect(destinos.single.ordenId, 42);
    });

    test('el aviso que abrio la app (getInitialMessage) tambien navega', () async {
      final p = _PlataformaFalsa()..inicial = const MensajePush(data: {'orden_trabajo_id': '9'});
      final destinos = <DestinoPush>[];
      final s = PushService(config: _configOk, plataforma: p, api: _ApiFalsa());
      await _iniciar(s, destinos: destinos);
      await Future<void>.delayed(Duration.zero);
      expect(destinos.single.ordenId, 9);
    });

    test('cerrar sesion llama DELETE con el token y despues deleteToken', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = PushService(config: _configOk, plataforma: p, api: api);
      await _iniciar(s);
      await s.alCerrarSesion(avisarServidor: true);
      expect(api.llamadas, ['POST /api/dispositivos', 'DELETE /api/dispositivos']);
      expect(api.cuerpos.last, {'token': 'tok-1'});
      expect(p.tokenBorrado, isTrue);
      expect(s.tokenActual, isNull);
    });

    test('con sesion vencida solo se borra el token de Firebase', () async {
      final p = _PlataformaFalsa();
      final api = _ApiFalsa();
      final s = PushService(config: _configOk, plataforma: p, api: api);
      await _iniciar(s);
      await s.alCerrarSesion(avisarServidor: false);
      expect(api.llamadas, ['POST /api/dispositivos']);
      expect(p.tokenBorrado, isTrue);
    });
  });

  group('destinoDeAviso', () {
    Future<bool> existe(int id) async => id == 5;

    test('abre la OT del data si esta en la base local', () async {
      expect((await destinoDeAviso({'orden_trabajo_id': '5'}, existe)).ordenId, 5);
      expect((await destinoDeAviso({'orden_trabajo_id': 5}, existe)).ordenId, 5);
    });
    test('OT desconocida, ausente o mal formada: la lista', () async {
      expect((await destinoDeAviso({'orden_trabajo_id': '6'}, existe)).ordenId, isNull);
      expect((await destinoDeAviso({}, existe)).ordenId, isNull);
      expect((await destinoDeAviso({'orden_trabajo_id': 'abc'}, existe)).ordenId, isNull);
      expect((await destinoDeAviso({'orden_trabajo_id': '0'}, existe)).ordenId, isNull);
    });
  });

  group('dialogo previo', () {
    Future<bool?> abrir(WidgetTester t, String boton) async {
      bool? resultado;
      await t.pumpWidget(MaterialApp(
        home: Builder(
          builder: (c) => Scaffold(
            body: TextButton(
              onPressed: () async => resultado = await mostrarDialogoPermisoAvisos(c),
              child: const Text('abrir'),
            ),
          ),
        ),
      ));
      await t.tap(find.text('abrir'));
      await t.pumpAndSettle();
      expect(find.text('¿Activar avisos de órdenes?'), findsOneWidget);
      await t.tap(find.text(boton));
      await t.pumpAndSettle();
      return resultado;
    }

    testWidgets('Activar avisos devuelve true', (t) async {
      expect(await abrir(t, 'Activar avisos'), isTrue);
    });
    testWidgets('Ahora no devuelve false', (t) async {
      expect(await abrir(t, 'Ahora no'), isFalse);
    });
  });
}
