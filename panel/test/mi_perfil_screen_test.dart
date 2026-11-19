import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:gomaq_web/screens/panel/mi_perfil_screen.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/services/auth_service.dart';

// Datos ficticios.
Map<String, dynamic> _perfil({String nombre = 'Ana Ficticia', String? telefono = '+56 9 1111 2222', List<Map<String, dynamic>>? avisos}) => {
      'id': 7,
      'nombre': nombre,
      'email': 'ana@ficticia.test',
      'rol': 'administrativo',
      'rut': null,
      'telefono_whatsapp': telefono,
      'avisos': avisos ??
          [
            {'tipo': 'ot_por_valorizar', 'titulo': 'Orden por valorizar', 'descripcion': 'Una reparación terminó.', 'activo': true},
            {'tipo': 'asistencia_nueva', 'titulo': 'Nueva asistencia', 'descripcion': 'Un cliente pidió asistencia.', 'activo': true},
            {'tipo': 'mantencion_proxima', 'titulo': 'Mantención próxima', 'descripcion': 'Un equipo se acerca a su mantención.', 'activo': false},
          ],
    };

class _Falso {
  Map<String, dynamic> actual = _perfil();
  final guardados = <Map<String, dynamic>>[];
  Object? errorAlGuardar;
  int cargas = 0;
  Object? errorAlCargar;

  Future<Map<String, dynamic>> cargar() async {
    cargas++;
    if (errorAlCargar != null) throw errorAlCargar!;
    return Map<String, dynamic>.from(actual);
  }

  Future<Map<String, dynamic>> guardar(Map<String, dynamic> cambios) async {
    if (errorAlGuardar != null) throw errorAlGuardar!;
    guardados.add(cambios);
    // el servidor devuelve el perfil ya actualizado
    final nuevo = Map<String, dynamic>.from(actual);
    if (cambios['nombre'] != null) nuevo['nombre'] = cambios['nombre'];
    if (cambios['telefono_whatsapp'] != null) nuevo['telefono_whatsapp'] = cambios['telefono_whatsapp'];
    final avisos = cambios['avisos'] as Map?;
    if (avisos != null) {
      nuevo['avisos'] = [
        for (final a in (actual['avisos'] as List)) {...(a as Map<String, dynamic>), if (avisos.containsKey(a['tipo'])) 'activo': avisos[a['tipo']]},
      ];
    }
    actual = nuevo;
    return nuevo;
  }
}

Future<AuthService> _montar(WidgetTester t, _Falso f, {double ancho = 900}) async {
  t.view.physicalSize = Size(ancho, 1400);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  final auth = AuthService();
  await t.pumpWidget(ChangeNotifierProvider<AuthService>.value(
    value: auth,
    child: MaterialApp(home: Scaffold(body: MiPerfilScreen(cargar: f.cargar, guardar: f.guardar))),
  ));
  await t.pumpAndSettle();
  return auth;
}

FilledButton _guardarBoton(WidgetTester t) => t.widget<FilledButton>(find.widgetWithText(FilledButton, 'Guardar cambios'));

void main() {
  testWidgets('muestra los datos, el correo como solo lectura y los avisos del rol con su estado', (t) async {
    await _montar(t, _Falso());
    expect(find.text('Mi perfil y mis avisos'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Ana Ficticia'), findsOneWidget);
    expect(find.widgetWithText(TextField, '+56 9 1111 2222'), findsOneWidget);
    expect(find.textContaining('ana@ficticia.test'), findsOneWidget);
    expect(find.textContaining('es tu inicio de sesión'), findsOneWidget);
    // un interruptor por aviso, con su estado
    expect(find.byType(SwitchListTile), findsNWidgets(3));
    expect(t.widget<SwitchListTile>(find.byKey(const ValueKey('aviso-ot_por_valorizar'))).value, isTrue);
    expect(t.widget<SwitchListTile>(find.byKey(const ValueKey('aviso-mantencion_proxima'))).value, isFalse);
    expect(find.text('Orden por valorizar'), findsOneWidget);
    expect(find.text('Un cliente pidió asistencia.'), findsOneWidget);
  });

  testWidgets('Guardar cambios está apagado hasta que algo cambia', (t) async {
    await _montar(t, _Falso());
    expect(_guardarBoton(t).onPressed, isNull);
    await t.tap(find.byKey(const ValueKey('aviso-asistencia_nueva')));
    await t.pump();
    expect(_guardarBoton(t).onPressed, isNotNull);
    // volver a dejarlo como estaba lo apaga otra vez
    await t.tap(find.byKey(const ValueKey('aviso-asistencia_nueva')));
    await t.pump();
    expect(_guardarBoton(t).onPressed, isNull);
  });

  testWidgets('apagar un aviso envía solo ese aviso, y no hay nada que enviar hasta pulsar Guardar', (t) async {
    final f = _Falso();
    await _montar(t, f);
    await t.tap(find.byKey(const ValueKey('aviso-ot_por_valorizar')));
    await t.pump();
    expect(f.guardados, isEmpty, reason: 'cambiar el interruptor no guarda solo');
    await t.tap(find.widgetWithText(FilledButton, 'Guardar cambios'));
    await t.pumpAndSettle();
    expect(f.guardados, [
      {
        'avisos': {'ot_por_valorizar': false}
      }
    ]);
    expect(find.text('Cambios guardados.'), findsOneWidget);
    expect(t.widget<SwitchListTile>(find.byKey(const ValueKey('aviso-ot_por_valorizar'))).value, isFalse);
    expect(_guardarBoton(t).onPressed, isNull, reason: 'ya no hay cambios pendientes');
  });

  testWidgets('el nombre y el teléfono se envían solo si cambiaron, y el nombre nuevo llega al menú', (t) async {
    final f = _Falso();
    final auth = await _montar(t, f);
    await t.enterText(find.widgetWithText(TextField, 'Ana Ficticia'), '  Ana María Ficticia ');
    await t.enterText(find.widgetWithText(TextField, '+56 9 1111 2222'), '+56 9 9999 0000');
    await t.pump();
    await t.tap(find.widgetWithText(FilledButton, 'Guardar cambios'));
    await t.pumpAndSettle();
    expect(f.guardados, [
      {'nombre': 'Ana María Ficticia', 'telefono_whatsapp': '+56 9 9999 0000'}
    ]);
    expect(auth.nombre, 'Ana María Ficticia');
  });

  testWidgets('el nombre vacío no se puede guardar y lo dice', (t) async {
    final f = _Falso();
    await _montar(t, f);
    await t.enterText(find.widgetWithText(TextField, 'Ana Ficticia'), '   ');
    await t.pump();
    expect(find.text('El nombre no puede quedar vacío.'), findsOneWidget);
    expect(_guardarBoton(t).onPressed, isNull);
  });

  testWidgets('un teléfono vacío no se envía (no se puede borrar)', (t) async {
    final f = _Falso();
    await _montar(t, f);
    await t.enterText(find.widgetWithText(TextField, '+56 9 1111 2222'), '');
    await t.pump();
    expect(_guardarBoton(t).onPressed, isNull);
  });

  testWidgets('si el servidor rechaza el cambio, lo dice y conserva lo que la persona tenía en pantalla', (t) async {
    final f = _Falso()..errorAlGuardar = ApiException(400, 'El aviso "x" no existe para tu perfil');
    await _montar(t, f);
    await t.tap(find.byKey(const ValueKey('aviso-ot_por_valorizar')));
    await t.pump();
    await t.tap(find.widgetWithText(FilledButton, 'Guardar cambios'));
    await t.pumpAndSettle();
    expect(find.textContaining('no existe para tu perfil'), findsOneWidget);
    expect(t.widget<SwitchListTile>(find.byKey(const ValueKey('aviso-ot_por_valorizar'))).value, isFalse);
    expect(_guardarBoton(t).onPressed, isNotNull, reason: 'se puede volver a intentar');
  });

  testWidgets('si falla la carga muestra el error y se puede reintentar', (t) async {
    final f = _Falso()..errorAlCargar = Exception('sin red');
    await _montar(t, f);
    expect(find.text('No se pudo cargar tu perfil'), findsOneWidget);
    f.errorAlCargar = null;
    await t.tap(find.text('Reintentar'));
    await t.pumpAndSettle();
    expect(f.cargas, 2);
    expect(find.byType(SwitchListTile), findsNWidgets(3));
  });

  testWidgets('un perfil sin avisos (un rol que no recibe push) lo dice', (t) async {
    final f = _Falso()..actual = _perfil(avisos: []);
    await _montar(t, f);
    expect(find.text('No hay avisos para tu perfil.'), findsOneWidget);
    expect(find.byType(SwitchListTile), findsNothing);
  });

  testWidgets('a 375 px no desborda y los interruptores tienen objetivo táctil suficiente', (t) async {
    await _montar(t, _Falso(), ancho: 375);
    expect(t.takeException(), isNull);
    final alto = t.getSize(find.byKey(const ValueKey('aviso-ot_por_valorizar'))).height;
    expect(alto, greaterThanOrEqualTo(48));
  });
}
