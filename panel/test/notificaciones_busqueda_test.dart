import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/notificaciones_screen.dart';
import 'package:gomaq_web/services/api_client.dart';

// Datos ficticios.
Map<String, dynamic> _aviso(int id, String folio, String cliente, {String destinatario = 'contacto@ficticia.test'}) => {
      'id': id,
      'canal': 'email',
      'destinatario': destinatario,
      'estado': 'enviado',
      'intentos': 1,
      'payload': {'tipo': 'factura_emitida', 'factura_id': id, 'folio': folio, 'cliente_nombre': cliente},
    };

class _Falso {
  final reenvios = <int>[];
  final fotosReenviadas = <List<int>?>[];
  final busquedas = <String>[];
  Object? errorAlReenviar;
  List<dynamic>? lista;

  Future<dynamic> avisos({required bool soloProblemas, String? canal}) async =>
      lista ??
      [
        _aviso(1, '1501', 'Constructora Ficticia Ltda'),
        _aviso(2, '1502', 'Transportes Imaginarios SpA', destinatario: 'otro@imaginarios.test'),
      ];

  Future<List<Map<String, dynamic>>> buscar(String q) async {
    busquedas.add(q);
    return [
      {'id': 9, 'folio': '1400', 'cliente_nombre': 'Minera Inventada SA'}
    ];
  }

  Future<void> reenviar(int id, {List<int>? fotoIds}) async {
    if (errorAlReenviar != null) throw errorAlReenviar!;
    reenvios.add(id);
    fotosReenviadas.add(fotoIds);
  }
}

Widget _app(_Falso f, {bool admin = true}) => MaterialApp(
      home: NotificacionesScreen(
        puedeReenviar: admin,
        cargarAvisos: f.avisos,
        buscarFacturas: f.buscar,
        reenviarCorreo: f.reenviar,
      ),
    );

void main() {
  testWidgets('el texto filtra los avisos ya listados por folio y por cliente', (t) async {
    final f = _Falso();
    await t.pumpWidget(_app(f));
    await t.pumpAndSettle();
    expect(find.textContaining('Factura 1501'), findsOneWidget);
    expect(find.textContaining('Factura 1502'), findsOneWidget);

    await t.enterText(find.byType(TextField), '1502');
    await t.pumpAndSettle();
    expect(find.textContaining('Factura 1501'), findsNothing);
    expect(find.textContaining('Factura 1502'), findsOneWidget);

    await t.enterText(find.byType(TextField), 'constructora');
    await t.pumpAndSettle();
    expect(find.textContaining('Factura 1501'), findsOneWidget);
    expect(find.textContaining('Factura 1502'), findsNothing);

    await t.enterText(find.byType(TextField), 'zzz');
    await t.pumpAndSettle();
    expect(find.textContaining('Ningún aviso reciente coincide'), findsOneWidget);
    // filtrar no consulta el servidor
    expect(f.busquedas, isEmpty);
  });

  testWidgets('Buscar consulta las facturas emitidas y Reenviar correo pide confirmar antes de enviar', (t) async {
    final f = _Falso();
    await t.pumpWidget(_app(f));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), '1400');
    await t.tap(find.byTooltip('Buscar'));
    await t.pumpAndSettle();
    expect(f.busquedas, ['1400']);
    expect(find.text('Factura 1400'), findsOneWidget);

    await t.tap(find.widgetWithText(OutlinedButton, 'Reenviar correo'));
    await t.pumpAndSettle();
    expect(f.reenvios, isEmpty, reason: 'todavía no confirmó');
    expect(find.textContaining('Minera Inventada SA'), findsWidgets);
    await t.tap(find.widgetWithText(FilledButton, 'Reenviar'));
    await t.pumpAndSettle();
    expect(f.reenvios, [9]);
    expect(find.textContaining('puesto en la cola de envío'), findsOneWidget);
  });

  testWidgets('un 409 de envío pendiente se explica en limpio', (t) async {
    final f = _Falso()..errorAlReenviar = ApiException(409, 'Esta factura ya tiene un envío pendiente');
    await t.pumpWidget(_app(f));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), '1400');
    await t.tap(find.byTooltip('Buscar'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(OutlinedButton, 'Reenviar correo'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(FilledButton, 'Reenviar'));
    await t.pumpAndSettle();
    expect(find.textContaining('ya tiene un envío pendiente'), findsOneWidget);
  });

  testWidgets('el gerente ve las facturas encontradas pero sin Reenviar correo', (t) async {
    final f = _Falso();
    await t.pumpWidget(_app(f, admin: false));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), '1400');
    await t.tap(find.byTooltip('Buscar'));
    await t.pumpAndSettle();
    expect(find.text('Factura 1400'), findsOneWidget);
    expect(find.text('Reenviar correo'), findsNothing);
  });

  testWidgets('a 375 px no desborda', (t) async {
    t.view.physicalSize = const Size(375, 800);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize);
    addTearDown(t.view.resetDevicePixelRatio);
    final f = _Falso();
    await t.pumpWidget(_app(f));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), '1400');
    await t.tap(find.byTooltip('Buscar'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
  });

  group('Reenviar desde la fila', () {
    Map<String, dynamic> correo(int id, {String estado = 'enviado', String? error, List<int>? fotos, Object? existe, String folio = '1600'}) => {
          'id': id,
          'canal': 'email',
          'destinatario': 'cliente$id@ficticia.test',
          'estado': estado,
          'intentos': estado == 'error' ? 5 : 0,
          'ultimo_error': error,
          'factura_existe': ?existe,
          'payload': {
            'tipo': 'factura_emitida',
            'factura_id': id + 100,
            'folio': folio,
            'cliente_nombre': 'Cliente $id',
            'foto_ids': ?fotos,
          },
        };

    Future<_Falso> montar(WidgetTester t, List<dynamic> lista, {bool admin = true}) async {
      final f = _Falso()..lista = lista;
      await t.pumpWidget(_app(f, admin: admin));
      await t.pumpAndSettle();
      return f;
    }

    testWidgets('un correo enviado con fotos se reenvía con esas mismas fotos, tras confirmar', (t) async {
      final f = await montar(t, [correo(1, fotos: [12, 13])]);
      expect(find.textContaining('2 fotos adjuntas'), findsOneWidget);
      await t.tap(find.widgetWithText(OutlinedButton, 'Reenviar'));
      await t.pumpAndSettle();
      expect(f.reenvios, isEmpty, reason: 'todavía no confirmó');
      expect(find.textContaining('con 2 fotos adjuntas'), findsOneWidget);
      await t.tap(find.widgetWithText(FilledButton, 'Reenviar'));
      await t.pumpAndSettle();
      expect(f.reenvios, [101]);
      expect(f.fotosReenviadas, [
        [12, 13]
      ]);
      expect(find.textContaining('puesto en la cola de envío'), findsOneWidget);
    });

    testWidgets('un correo que no llevó fotos se reenvía con una lista vacía: no se le suman fotos de otro envío', (t) async {
      final f = await montar(t, [correo(2)]);
      expect(find.textContaining('foto'), findsNothing);
      await t.tap(find.widgetWithText(OutlinedButton, 'Reenviar'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Reenviar'));
      await t.pumpAndSettle();
      expect(f.fotosReenviadas, [<int>[]]);
    });

    testWidgets('con error el correo de una factura se reenvía y ya no ofrece Reintentar; un push con error sí', (t) async {
      await montar(t, [
        correo(3, estado: 'error', error: 'El proveedor rechazo el correo'),
        {
          'id': 50,
          'canal': 'push',
          'destinatario': '31',
          'estado': 'error',
          'intentos': 5,
          'ultimo_error': 'UNREGISTERED',
          'usuario_nombre': 'Ana Ficticia',
          'usuario_rol': 'administrativo',
          'payload': {'tipo': 'ot_por_valorizar'},
        },
      ]);
      expect(find.widgetWithText(OutlinedButton, 'Reenviar'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Reintentar'), findsOneWidget, reason: 'solo el del push');
    });

    testWidgets('un correo cancelado se puede reenviar, salvo si lo canceló la anulación de la factura', (t) async {
      await montar(t, [
        correo(4, estado: 'cancelado', error: 'Reemplazado', folio: '1'),
        correo(5, estado: 'cancelado', error: 'Factura anulada', folio: '2'),
      ]);
      expect(find.widgetWithText(OutlinedButton, 'Reenviar'), findsOneWidget);
      expect(find.textContaining('Cancelada: Factura anulada'), findsOneWidget);
    });

    testWidgets('sin botón: pendientes, facturas que ya no existen y avisos sin proveedor de envío', (t) async {
      await montar(t, [
        correo(6, estado: 'pendiente'),
        correo(7, existe: false),
        correo(8, estado: 'error', error: 'Proveedor de email no configurado todavia'),
      ]);
      expect(find.widgetWithText(OutlinedButton, 'Reenviar'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Reintentar'), findsNothing);
    });

    testWidgets('el gerente no reenvía (autorizar el envío es del administrativo): conserva Reintentar en los errores', (t) async {
      await montar(t, [correo(9), correo(10, estado: 'error', error: 'falló')], admin: false);
      expect(find.widgetWithText(OutlinedButton, 'Reenviar'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Reintentar'), findsOneWidget);
    });

    testWidgets('un 409 de envío pendiente al reenviar desde la fila se explica en limpio', (t) async {
      final f = await montar(t, [correo(11)]);
      f.errorAlReenviar = ApiException(409, 'Esta factura ya tiene un envío pendiente');
      await t.tap(find.widgetWithText(OutlinedButton, 'Reenviar'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Reenviar'));
      await t.pumpAndSettle();
      expect(find.textContaining('ya tiene un envío pendiente'), findsOneWidget);
    });

    testWidgets('a 375 px las filas con botón no desbordan', (t) async {
      t.view.physicalSize = const Size(375, 800);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.resetPhysicalSize);
      addTearDown(t.view.resetDevicePixelRatio);
      await montar(t, [
        correo(12, fotos: [1, 2, 3], folio: 'FOLIO-LARGO-0000123'),
        correo(13, estado: 'error', error: 'Un error de proveedor con un texto largo largo largo'),
      ]);
      expect(find.widgetWithText(OutlinedButton, 'Reenviar'), findsNWidgets(2));
      expect(t.takeException(), isNull);
    });

    test('puedeReenviarFila, fotosDelAviso y textoFotosAviso', () {
      expect(puedeReenviarFila(correo(1)), isTrue);
      expect(puedeReenviarFila(correo(1, estado: 'pendiente')), isFalse);
      expect(puedeReenviarFila(correo(1, existe: false)), isFalse);
      expect(puedeReenviarFila(correo(1, existe: true)), isTrue);
      expect(puedeReenviarFila({'canal': 'push', 'estado': 'enviado', 'payload': {'tipo': 'ot_asignada'}}), isFalse);
      expect(puedeReenviarFila({'canal': 'email', 'estado': 'enviado', 'payload': {'tipo': 'factura_emitida'}}), isFalse,
          reason: 'sin id de factura no hay qué reenviar');
      expect(fotosDelAviso(correo(1, fotos: [5, 6])), [5, 6]);
      expect(fotosDelAviso(correo(1)), isEmpty);
      expect(textoFotosAviso(correo(1, fotos: [5])), '1 foto adjunta');
      expect(textoFotosAviso(correo(1, fotos: [5, 6])), '2 fotos adjuntas');
      expect(textoFotosAviso(correo(1)), isNull);
    });
  });

  testWidgets('un push muestra el nombre y el rol del usuario, no el id del dispositivo', (t) async {
    final canales = <String?>[];
    Future<dynamic> avisos({required bool soloProblemas, String? canal}) async {
      canales.add(canal);
      return [
        {
          'id': 5,
          'canal': 'push',
          'destinatario': '31',
          'estado': 'enviado',
          'intentos': 1,
          'usuario_nombre': 'Ana Ficticia',
          'usuario_rol': 'administrativo',
          'payload': {'tipo': 'ot_por_valorizar', 'orden_trabajo_id': 7},
        },
      ];
    }

    await t.pumpWidget(MaterialApp(
      home: NotificacionesScreen(puedeReenviar: false, cargarAvisos: avisos),
    ));
    await t.pumpAndSettle();
    expect(find.text('Push -> Ana Ficticia (administrativo)'), findsOneWidget);
    expect(find.textContaining('31'), findsNothing);
    // se puede buscar por el nombre del usuario
    await t.enterText(find.byType(TextField), 'ana');
    await t.pumpAndSettle();
    expect(find.textContaining('Ana Ficticia'), findsWidgets);
    await t.enterText(find.byType(TextField), '');
    // el chip de canal vuelve a pedir la lista solo de ese canal
    await t.tap(find.byKey(const ValueKey('canal-push')));
    await t.pumpAndSettle();
    expect(canales, [null, 'push']);
    await t.tap(find.byKey(const ValueKey('canal-todos')));
    await t.pumpAndSettle();
    expect(canales, [null, 'push', null]);
  });
}
