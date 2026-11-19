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
  final busquedas = <String>[];
  Object? errorAlReenviar;

  Future<dynamic> avisos({required bool soloProblemas, String? canal}) async => [
        _aviso(1, '1501', 'Constructora Ficticia Ltda'),
        _aviso(2, '1502', 'Transportes Imaginarios SpA', destinatario: 'otro@imaginarios.test'),
      ];

  Future<List<Map<String, dynamic>>> buscar(String q) async {
    busquedas.add(q);
    return [
      {'id': 9, 'folio': '1400', 'cliente_nombre': 'Minera Inventada SA'}
    ];
  }

  Future<void> reenviar(int id) async {
    if (errorAlReenviar != null) throw errorAlReenviar!;
    reenvios.add(id);
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
