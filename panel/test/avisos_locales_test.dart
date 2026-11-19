import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/services/avisos_locales_service.dart';
import 'package:gomaq_web/services/notificacion_local.dart';
import 'package:gomaq_web/services/push_config.dart';
import 'package:gomaq_web/services/push_service.dart';
import 'package:gomaq_web/utils/avisos_locales.dart';
import 'package:gomaq_web/utils/navegador_avisos.dart';
import 'package:gomaq_web/widgets/boton_avisos.dart';

class _NotifFalsa implements NotificacionLocal {
  PermisoAvisos permisoActual;
  PermisoAvisos alPedir;
  bool enFoco = false;
  bool admite = true;
  String ua = '';
  bool brave = false;
  int pedidos = 0;
  final mostrados = <String>[];
  final cuerposMostrados = <String>[];
  final toques = <void Function()>[];

  _NotifFalsa({
    this.permisoActual = PermisoAvisos.concedido,
    this.alPedir = PermisoAvisos.concedido,
  });

  @override
  bool get soportada => admite;
  @override
  PermisoAvisos get permiso => permisoActual;
  @override
  Future<PermisoAvisos> pedirPermiso() async {
    pedidos++;
    permisoActual = alPedir;
    return alPedir;
  }

  @override
  bool get pestanaEnFoco => enFoco;
  @override
  String get userAgent => ua;
  @override
  bool get esBrave => brave;
  @override
  void mostrar({
    required String titulo,
    required String cuerpo,
    required String tag,
    required void Function() alTocar,
  }) {
    mostrados.add(titulo);
    cuerposMostrados.add(cuerpo);
    toques.add(alTocar);
  }
}

const _basePendientes = {
  'ot_sin_asignar': 1,
  'asistencias_por_atender': 0,
  'ot_por_valorizar': 2,
};

void main() {
  group('avisosDePendientes', () {
    test('la primera lectura solo fija la base', () {
      expect(avisosDePendientes(null, _basePendientes), isEmpty);
    });
    test('lo que sube avisa, junto en un solo aviso', () {
      final a = avisosDePendientes(_basePendientes, {
        'ot_sin_asignar': 3,
        'asistencias_por_atender': 1,
        'ot_por_valorizar': 2,
      });
      expect(a, hasLength(1));
      expect(
        a.single.cuerpo,
        '2 órdenes sin asignar, 1 asistencia por atender',
      );
      expect(a.single.ruta, '/');
      expect(a.single.tag, 'gomaq-pendientes');
    });
    test('lo que baja o se mantiene no avisa', () {
      expect(
        avisosDePendientes(_basePendientes, {
          'ot_sin_asignar': 0,
          'ot_por_valorizar': 2,
        }),
        isEmpty,
      );
      expect(avisosDePendientes(_basePendientes, _basePendientes), isEmpty);
    });
    test('un contador que no venia cuenta como cero', () {
      final a = avisosDePendientes({}, {'cuentas_por_aprobar': 1});
      expect(a.single.cuerpo, '1 cuenta por aprobar');
    });
  });

  group('avisosDeOrdenesCliente', () {
    final antes = [
      {'id': 22, 'estado': 'pendiente'},
      {'id': 17, 'estado': 'finalizada'},
    ];
    test('sin lectura anterior solo fija la base', () {
      expect(avisosDeOrdenesCliente(null, antes), isEmpty);
    });
    test(
      'una orden que avanza avisa con titulo y numero, sin nombres ni datos del vehiculo',
      () {
        final a = avisosDeOrdenesCliente(antes, [
          {
            'id': 22,
            'estado': 'asignada',
            'mecanico_nombre': 'Juan Perez',
            'vehiculo_patente': 'ABCD12',
          },
          {'id': 17, 'estado': 'finalizada'},
        ]);
        expect(a, hasLength(1));
        expect(a.single.titulo, 'Asignamos un técnico a tu orden');
        expect(a.single.cuerpo, 'Orden N.º 22');
        expect(a.single.ruta, '/portal');
        expect(a.single.tag, 'ot-22-asignada');
        expect('${a.single.titulo}${a.single.cuerpo}', isNot(contains('Juan')));
        expect(
          '${a.single.titulo}${a.single.cuerpo}',
          isNot(contains('ABCD12')),
        );
      },
    );
    test(
      'una orden nueva no avisa y pasar de en_reparacion a en_terreno tampoco',
      () {
        expect(
          avisosDeOrdenesCliente(antes, [
            ...antes,
            {'id': 30, 'estado': 'asignada'},
          ]),
          isEmpty,
        );
        expect(
          avisosDeOrdenesCliente(
            [
              {'id': 5, 'estado': 'en_reparacion'},
            ],
            [
              {'id': 5, 'estado': 'en_terreno'},
            ],
          ),
          isEmpty,
        );
      },
    );
    test('en camino y finalizada avisan; un estado sin texto no', () {
      final a = avisosDeOrdenesCliente(
        [
          {'id': 1, 'estado': 'aceptada'},
          {'id': 2, 'estado': 'en_terreno'},
          {'id': 3, 'estado': 'pendiente'},
        ],
        [
          {'id': 1, 'estado': 'en_camino'},
          {'id': 2, 'estado': 'finalizada'},
          {'id': 3, 'estado': 'pendiente'},
        ],
      );
      expect(a.map((x) => x.titulo), [
        'Tu técnico va en camino',
        'Tu orden fue finalizada',
      ]);
    });
  });

  group('detectarNavegador', () {
    test('distingue los navegadores y Brave por navigator.brave', () {
      const chrome =
          'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
      expect(detectarNavegador(chrome), Navegador.chrome);
      expect(detectarNavegador(chrome, esBrave: true), Navegador.brave);
      expect(detectarNavegador('$chrome Edg/131.0'), Navegador.edge);
      expect(
        detectarNavegador('Mozilla/5.0 Gecko/20100101 Firefox/133.0'),
        Navegador.firefox,
      );
      expect(
        detectarNavegador(
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1',
        ),
        Navegador.safariIos,
      );
      expect(detectarNavegador(''), Navegador.otro);
    });
    test('cada navegador tiene su instruccion', () {
      expect(
        instruccionesAvisos(Navegador.brave),
        contains('brave://settings/privacy'),
      );
      expect(
        instruccionesAvisos(Navegador.safariIos),
        contains('pantalla de inicio'),
      );
      expect(
        instruccionesAvisos(Navegador.chrome),
        contains('Acepta el permiso'),
      );
    });
  });

  group('AvisosLocalesService', () {
    late _NotifFalsa n;
    late Object lectura;
    late List<String> rutas;
    var pedidas = 0;

    AvisosLocalesService servicio({Map<String, String>? flags}) =>
        AvisosLocalesService(
          plataforma: n,
          leerFlag: (c) async => flags?[c],
          guardarFlag: (c, v) async => flags?[c] = v,
        );

    void iniciar(
      AvisosLocalesService s, {
      bool esCliente = false,
      bool Function()? pushActivo,
    }) => s.iniciar(
      esCliente: esCliente,
      pedir: () async {
        pedidas++;
        return lectura;
      },
      alAbrir: rutas.add,
      pushActivo: pushActivo,
      cada: const Duration(
        hours: 1,
      ), // el ciclo se dispara a mano con revisar()
    );

    setUp(() {
      n = _NotifFalsa();
      lectura = Map<String, dynamic>.from(_basePendientes);
      rutas = [];
      pedidas = 0;
    });

    test('sin permiso no consulta al servidor ni avisa', () async {
      n.permisoActual = PermisoAvisos.pendiente;
      final s = servicio();
      iniciar(s);
      await s.revisar();
      expect(pedidas, 0);
      expect(n.mostrados, isEmpty);
      expect(s.estado.value, EstadoLocal.porActivar);
      s.detener();
    });

    test(
      'con permiso: la primera lectura es la base y despues avisa lo que sube',
      () async {
        final s = servicio();
        iniciar(s);
        await Future<void>.delayed(Duration.zero); // primera lectura (la base)
        expect(n.mostrados, isEmpty);
        lectura = {..._basePendientes, 'ot_sin_asignar': 2};
        await s.revisar();
        expect(n.mostrados, ['GOMAQ: hay novedades']);
        expect(n.cuerposMostrados.single, '1 orden sin asignar');
        n.toques.single();
        expect(rutas, ['/']);
        await s.revisar(); // sin cambios: no repite
        expect(n.mostrados, hasLength(1));
        s.detener();
      },
    );

    test(
      'con la pestana a la vista y con foco no avisa, pero conserva la base',
      () async {
        final s = servicio();
        iniciar(s);
        await Future<void>.delayed(Duration.zero);
        n.enFoco = true;
        lectura = {..._basePendientes, 'ot_sin_asignar': 5};
        await s.revisar();
        expect(n.mostrados, isEmpty);
        s.detener();
      },
    );

    test('con el push activo en este equipo no duplica el aviso', () async {
      final s = servicio();
      iniciar(s, pushActivo: () => true);
      await Future<void>.delayed(Duration.zero);
      lectura = {..._basePendientes, 'ot_sin_asignar': 5};
      await s.revisar();
      expect(n.mostrados, isEmpty);
      s.detener();
    });

    test('cliente: avisa cuando una orden suya cambia de estado', () async {
      lectura = [
        {'id': 22, 'estado': 'asignada'},
      ];
      final s = servicio();
      iniciar(s, esCliente: true);
      await Future<void>.delayed(Duration.zero);
      lectura = [
        {'id': 22, 'estado': 'en_camino'},
      ];
      await s.revisar();
      expect(n.mostrados, ['Tu técnico va en camino']);
      n.toques.single();
      expect(rutas, ['/portal']);
      s.detener();
    });

    test(
      'un error al consultar no rompe ni avisa; el ciclo siguiente sigue',
      () async {
        final s = servicio();
        var falla = false;
        s.iniciar(
          esCliente: false,
          pedir: () async {
            if (falla) throw Exception('sin red');
            return lectura;
          },
          alAbrir: rutas.add,
          cada: const Duration(hours: 1),
        );
        await Future<void>.delayed(Duration.zero);
        falla = true;
        await s.revisar();
        falla = false;
        lectura = {..._basePendientes, 'ot_sin_asignar': 4};
        await s.revisar();
        expect(n.mostrados, hasLength(1));
        s.detener();
      },
    );

    test(
      'detener olvida la sesion: una lectura que llega tarde se descarta',
      () async {
        final s = servicio();
        final c = Completer<Object?>();
        var primera = true;
        s.iniciar(
          esCliente: false,
          pedir: () {
            if (primera) {
              primera = false;
              return Future.value(_basePendientes);
            }
            return c.future;
          },
          alAbrir: rutas.add,
          cada: const Duration(hours: 1),
        );
        await Future<void>.delayed(Duration.zero);
        final pendiente = s.revisar();
        s.detener();
        c.complete({..._basePendientes, 'ot_sin_asignar': 9});
        await pendiente;
        expect(n.mostrados, isEmpty);
      },
    );

    test(
      'activar pide el permiso al navegador una sola vez y empieza a vigilar',
      () async {
        n = _NotifFalsa(permisoActual: PermisoAvisos.pendiente);
        final s = servicio();
        iniciar(s);
        expect(n.pedidos, 0, reason: 'iniciar nunca pide el permiso');
        await s.activar();
        expect(n.pedidos, 1);
        expect(s.estado.value, EstadoLocal.activados);
        expect(pedidas, 1, reason: 'toma la base apenas se activa');
        s.detener();
      },
    );

    test(
      'si la persona bloquea el permiso queda bloqueado y no consulta',
      () async {
        n = _NotifFalsa(
          permisoActual: PermisoAvisos.pendiente,
          alPedir: PermisoAvisos.denegado,
        );
        final s = servicio();
        iniciar(s);
        await s.activar();
        expect(s.estado.value, EstadoLocal.bloqueados);
        expect(pedidas, 0);
        s.detener();
      },
    );

    test(
      'un navegador sin notificaciones queda no soportado y activar no hace nada',
      () async {
        n = _NotifFalsa()..admite = false;
        final s = servicio();
        expect(s.estado.value, EstadoLocal.noSoportado);
        await s.activar();
        expect(n.pedidos, 0);
      },
    );

    test(
      'la invitacion: solo si falta decidir, y "Ahora no" se recuerda por usuario',
      () async {
        n = _NotifFalsa(permisoActual: PermisoAvisos.pendiente);
        final flags = <String, String>{};
        final s = servicio(flags: flags);
        expect(await s.debeInvitar(7), isTrue);
        await s.recordarAhoraNo(7);
        expect(await s.debeInvitar(7), isFalse);
        expect(await s.debeInvitar(8), isTrue, reason: 'es por usuario');
        n.permisoActual = PermisoAvisos.concedido;
        expect(
          await s.debeInvitar(8),
          isFalse,
          reason: 'ya decidio en el navegador',
        );
      },
    );
  });

  group('estadoCombinado y textos', () {
    test(
      'sin capa local manda el push; con ella, la local manda y el push suma',
      () {
        expect(
          estadoCombinado(
            push: EstadoAvisos.porActivar,
            local: EstadoLocal.noSoportado,
          ),
          EstadoAvisos.porActivar,
        );
        expect(
          estadoCombinado(
            push: EstadoAvisos.noDisponible,
            local: EstadoLocal.porActivar,
          ),
          EstadoAvisos.porActivar,
        );
        expect(
          estadoCombinado(
            push: EstadoAvisos.noDisponible,
            local: EstadoLocal.activados,
          ),
          EstadoAvisos.soloPanelAbierto,
        );
        expect(
          estadoCombinado(
            push: EstadoAvisos.activados,
            local: EstadoLocal.activados,
          ),
          EstadoAvisos.activados,
        );
        expect(
          estadoCombinado(
            push: EstadoAvisos.activados,
            local: EstadoLocal.bloqueados,
          ),
          EstadoAvisos.bloqueados,
        );
      },
    );

    test(
      'solo con el panel abierto: instrucciones del navegador y motivo tecnico',
      () {
        final t = explicacionAvisos(
          EstadoAvisos.soloPanelAbierto,
          motivo: 'fallo al activar: push service error',
          navegador: Navegador.brave,
        );
        expect(t, contains('panel abierto'));
        expect(t, contains('brave://settings/privacy'));
        expect(
          t,
          contains('Motivo técnico: fallo al activar: push service error.'),
        );
        expect(
          explicacionAvisos(EstadoAvisos.soloPanelAbierto),
          isNot(contains('Motivo técnico')),
        );
      },
    );
  });

  group('BotonAvisos con las dos capas', () {
    testWidgets(
      'Brave sin push de Google: campana activa, dialogo con la instruccion y el motivo',
      (t) async {
        t.view.physicalSize = const Size(375, 800);
        t.view.devicePixelRatio = 1;
        addTearDown(t.view.reset);
        final n = _NotifFalsa()
          ..brave = true
          ..ua = 'Mozilla/5.0 Chrome/131.0 Safari/537.36';
        final locales = AvisosLocalesService(plataforma: n);
        final push =
            PushService(
                config: const ConfigPush(
                  apiKey: 'k',
                  appId: 'a',
                  senderId: 's',
                  projectId: 'p',
                  vapidKey: 'v',
                ),
                web: true,
              )
              ..motivoNoDisponible = 'fallo al iniciar: push service error'
              ..estado.value = EstadoAvisos.noDisponible;
        await t.pumpWidget(
          MaterialApp(
            home: Scaffold(
              appBar: AppBar(
                title: const Text('Panel'),
                actions: [BotonAvisos(servicio: push, locales: locales)],
              ),
            ),
          ),
        );
        expect(
          find.byTooltip('Avisos activados con el panel abierto'),
          findsOneWidget,
        );
        await t.tap(find.byType(IconButton));
        await t.pumpAndSettle();
        expect(find.textContaining('brave://settings/privacy'), findsOneWidget);
        expect(
          find.textContaining(
            'Motivo técnico: fallo al iniciar: push service error.',
          ),
          findsOneWidget,
        );
        expect(t.takeException(), isNull);
      },
    );

    testWidgets(
      'sin config de Firebase y con navegador que admite notificaciones, la campana igual se dibuja',
      (t) async {
        final locales = AvisosLocalesService(
          plataforma: _NotifFalsa(permisoActual: PermisoAvisos.pendiente),
        );
        await t.pumpWidget(
          MaterialApp(
            home: Scaffold(
              appBar: AppBar(
                actions: [
                  BotonAvisos(servicio: PushService(), locales: locales),
                ],
              ),
            ),
          ),
        );
        expect(find.byTooltip('Activar avisos'), findsOneWidget);
      },
    );

    testWidgets('tocar la campana por activar pide el permiso una vez', (
      t,
    ) async {
      final n = _NotifFalsa(permisoActual: PermisoAvisos.pendiente);
      final locales = AvisosLocalesService(plataforma: n);
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            appBar: AppBar(
              actions: [BotonAvisos(servicio: PushService(), locales: locales)],
            ),
          ),
        ),
      );
      expect(n.pedidos, 0);
      await t.tap(find.byType(IconButton));
      await t.pumpAndSettle();
      expect(n.pedidos, 1);
      expect(
        find.byTooltip('Avisos activados con el panel abierto'),
        findsOneWidget,
      );
    });
  });

  group('banner de invitacion', () {
    testWidgets(
      'a 375 px se lee entero, sin desbordes, y los dos botones responden',
      (t) async {
        t.view.physicalSize = const Size(375, 800);
        t.view.devicePixelRatio = 1;
        addTearDown(t.view.reset);
        var activo = 0, descartado = 0;
        await t.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Column(
                children: [
                  bannerInvitacionAvisos(
                    alActivar: () => activo++,
                    alDescartar: () => descartado++,
                  ),
                ],
              ),
            ),
          ),
        );
        expect(
          find.textContaining(
            '¿Quieres recibir avisos de órdenes y pendientes?',
          ),
          findsOneWidget,
        );
        expect(t.takeException(), isNull);
        await t.tap(find.text('Activar'));
        await t.tap(find.text('Ahora no'));
        expect(activo, 1);
        expect(descartado, 1);
        expect(
          t.getSize(find.widgetWithText(FilledButton, 'Activar')).height,
          greaterThanOrEqualTo(40),
        );
      },
    );
  });
}
