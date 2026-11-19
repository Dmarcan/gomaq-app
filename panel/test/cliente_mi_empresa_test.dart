import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/cliente/cliente_mi_empresa_screen.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/services/mi_empresa_service.dart';
import 'package:gomaq_web/utils/ubicacion.dart';
import 'package:gomaq_web/widgets/estado_vacio.dart';
import 'utils/tamano.dart';

Map<String, dynamic> _ficha({String? email = 'contacto@prueba.cl', double? lat, double? lng}) => {
      'nombre': 'Constructora Prueba SpA',
      'rut': '76.809.295-8',
      'giro': 'Construcción',
      'email': email,
      'telefono': '+56 9 1111 2222',
      'direccion': 'Calle 1',
      'horario_trabajo': null,
      'horario_colacion': null,
      'plazo_pago_dias': 30,
      'latitud': lat,
      'longitud': lng,
    };

class _Falso extends MiEmpresaService {
  final Map<String, dynamic> inicial;
  final List<Map<String, dynamic>> enviados = [];
  Object? errorAlGuardar;
  Object? errorAlCargar;
  _Falso(this.inicial);

  @override
  Future<Map<String, dynamic>> cargar() async {
    if (errorAlCargar != null) throw errorAlCargar!;
    return Map<String, dynamic>.from(inicial);
  }

  @override
  Future<Map<String, dynamic>> guardar(Map<String, dynamic> cambios) async {
    enviados.add(cambios);
    if (errorAlGuardar != null) throw errorAlGuardar!;
    return {...inicial, ...cambios};
  }
}

Widget _app(Widget hijo) => MaterialApp(home: Scaffold(body: hijo));

Finder _campo(String etiqueta) => find.widgetWithText(TextFormField, etiqueta);

void main() {
  testWidgets('a 375 px muestra los datos de solo lectura y el formulario sin desbordar', (t) async {
    fijarTamano(t, const Size(375, 812));
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(servicio: _Falso(_ficha()))));
    await t.pumpAndSettle();

    expect(find.text('Constructora Prueba SpA'), findsOneWidget);
    expect(find.text('76.809.295-8'), findsOneWidget);
    expect(find.text('Construcción'), findsOneWidget);
    expect(find.text('30 días'), findsOneWidget);
    expect(find.text('Para cambiar estos datos, contacta a GOMAQ.'), findsOneWidget);
    // los datos de solo lectura no son campos de texto: solo se editan los de contacto
    expect(find.byType(TextFormField), findsNWidgets(5));
    expect(find.widgetWithText(TextFormField, 'Constructora Prueba SpA'), findsNothing);
    expect(find.text('Mi empresa'), findsOneWidget);
    expect(t.takeException(), isNull);

    // bajando por la pantalla aparece el boton Guardar, sin desbordes
    await t.scrollUntilVisible(find.text('Guardar'), 300, scrollable: find.byType(Scrollable).first);
    expect(t.takeException(), isNull);
  });

  testWidgets('envia solo lo que se modifico', (t) async {
    fijarTamano(t, const Size(375, 812));
    final servicio = _Falso(_ficha());
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(servicio: servicio)));
    await t.pumpAndSettle();

    await t.enterText(_campo('Teléfono de contacto'), '+56 9 5555 4444');
    await t.enterText(_campo('Horario de trabajo'), '08:00-18:00');
    await t.scrollUntilVisible(find.text('Guardar'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Guardar'));
    await t.pumpAndSettle();

    expect(servicio.enviados, [
      {'telefono': '+56 9 5555 4444', 'horario_trabajo': '08:00-18:00'},
    ]);
    expect(find.text('Datos guardados.'), findsOneWidget);
  });

  testWidgets('sin cambios no llama al servidor', (t) async {
    fijarTamano(t, const Size(375, 812));
    final servicio = _Falso(_ficha());
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(servicio: servicio)));
    await t.pumpAndSettle();
    await t.scrollUntilVisible(find.text('Guardar'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Guardar'));
    await t.pumpAndSettle();
    expect(servicio.enviados, isEmpty);
    expect(find.text('No hay cambios por guardar.'), findsOneWidget);
  });

  testWidgets('el correo es obligatorio: vacio no se envia', (t) async {
    fijarTamano(t, const Size(375, 812));
    final servicio = _Falso(_ficha());
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(servicio: servicio)));
    await t.pumpAndSettle();
    await t.enterText(_campo('Correo de la empresa *'), '   ');
    await t.scrollUntilVisible(find.text('Guardar'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Guardar'));
    await t.pumpAndSettle();
    expect(find.text('Escribe tu correo.'), findsOneWidget);
    expect(servicio.enviados, isEmpty);
  });

  testWidgets('muestra el mensaje del servidor si falla el guardado y conserva lo escrito', (t) async {
    fijarTamano(t, const Size(375, 812));
    final servicio = _Falso(_ficha())..errorAlGuardar = ApiException(400, 'Ese dato lo actualiza GOMAQ');
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(servicio: servicio)));
    await t.pumpAndSettle();
    await t.enterText(_campo('Dirección'), 'Calle Nueva 99');
    await t.scrollUntilVisible(find.text('Guardar'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Guardar'));
    await t.pumpAndSettle();
    expect(find.text('Ese dato lo actualiza GOMAQ'), findsOneWidget);
    expect(find.text('Calle Nueva 99'), findsOneWidget);
    expect(find.text('Datos guardados.'), findsNothing);
  });

  testWidgets('sin red al cargar muestra el error con Reintentar', (t) async {
    fijarTamano(t, const Size(375, 812));
    final servicio = _Falso(_ficha())..errorAlCargar = Exception('sin red');
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(servicio: servicio)));
    await t.pumpAndSettle();
    expect(find.byType(EstadoError), findsOneWidget);
    expect(find.text('Reintentar'), findsOneWidget);
    servicio.errorAlCargar = null;
    await t.tap(find.text('Reintentar'));
    await t.pumpAndSettle();
    expect(find.text('Constructora Prueba SpA'), findsOneWidget);
  });

  testWidgets('Tab pasa al campo siguiente y Enter en el ultimo campo guarda', (t) async {
    fijarTamano(t, const Size(375, 812));
    final servicio = _Falso(_ficha());
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(servicio: servicio)));
    await t.pumpAndSettle();

    await t.tap(_campo('Correo de la empresa *'));
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.tab);
    await t.pump();
    // el foco paso al telefono: lo que se escribe ahora cae ahi
    await t.enterText(find.byType(EditableText).at(1), '+56 9 7777 6666');
    final editable = t.widget<EditableText>(find.byType(EditableText).at(1));
    expect(editable.focusNode.hasFocus, isTrue);

    await t.scrollUntilVisible(_campo('Dirección'), 200, scrollable: find.byType(Scrollable).first);
    await t.enterText(_campo('Dirección'), 'Calle Nueva 99');
    await t.testTextInput.receiveAction(TextInputAction.done);
    await t.pumpAndSettle();
    expect(servicio.enviados, [
      {'telefono': '+56 9 7777 6666', 'direccion': 'Calle Nueva 99'},
    ]);
  });

  testWidgets('la ubicacion marcada se envia como latitud y longitud', (t) async {
    fijarTamano(t, const Size(375, 812));
    final servicio = _Falso(_ficha());
    await t.pumpWidget(_app(ClienteMiEmpresaScreen(
      servicio: servicio,
      obtenerUbicacion: () async => const Coordenada(-38.7359, -72.5904),
    )));
    await t.pumpAndSettle();
    await t.scrollUntilVisible(find.text('Usar mi ubicación actual'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Usar mi ubicación actual'));
    await t.pumpAndSettle();
    expect(find.text('Ubicación marcada'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Guardar'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Guardar'));
    await t.pumpAndSettle();
    expect(servicio.enviados, [
      {'latitud': -38.7359, 'longitud': -72.5904},
    ]);
  });
}
