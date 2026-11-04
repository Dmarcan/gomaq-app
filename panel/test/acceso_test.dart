import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:gomaq_web/screens/acceso/login_screen.dart';
import 'package:gomaq_web/screens/acceso/registro_cliente_screen.dart';
import 'package:gomaq_web/services/auth_service.dart';
import 'package:gomaq_web/utils/validadores_acceso.dart';
import 'package:provider/provider.dart';

Widget _app(Widget pantalla) => ChangeNotifierProvider<AuthService>(
      create: (_) => AuthService(),
      child: MaterialApp.router(
        routerConfig: GoRouter(routes: [
          GoRoute(path: '/', builder: (_, _) => pantalla),
          GoRoute(path: '/login', builder: (_, _) => const SizedBox()),
          GoRoute(path: '/registro', builder: (_, _) => const SizedBox()),
        ]),
      ),
    );

void main() {
  group('validadores de acceso', () {
    test('correo', () {
      expect(validarCorreo(''), isNotNull);
      expect(validarCorreo('   '), isNotNull);
      expect(validarCorreo('sin-arroba.cl'), isNotNull);
      expect(validarCorreo('a@b'), isNotNull);
      expect(validarCorreo('a b@c.cl'), isNotNull);
      expect(validarCorreo('contacto@empresa.cl'), isNull);
      expect(validarCorreo('  contacto@empresa.cl '), isNull);
    });

    test('contraseña: 8 o más, igual que el servidor', () {
      expect(validarPassword(null), isNotNull);
      expect(validarPassword(''), isNotNull);
      expect(validarPassword('1234567'), isNotNull);
      expect(validarPassword('12345678'), isNull);
      expect(largoMinimoPassword, 8);
    });

    test('confirmación', () {
      expect(validarConfirmacion('', 'clave1234'), isNotNull);
      expect(validarConfirmacion('otra', 'clave1234'), 'Las contraseñas no coinciden.');
      expect(validarConfirmacion('clave1234', 'clave1234'), isNull);
    });

    test('RUT opcional', () {
      expect(validarRutOpcional(''), isNull);
      expect(validarRutOpcional(null), isNull);
      expect(validarRutOpcional('76.123.456-7'), isNotNull, reason: 'dígito verificador incorrecto');
      expect(validarRutOpcional('11.111.111-1'), isNull);
      expect(validarRutOpcional('1' * 21), 'El RUT es demasiado largo.');
    });

    test('teléfono opcional', () {
      expect(validarTelefonoOpcional(''), isNull);
      expect(validarTelefonoOpcional('+56 9 1234 5678'), isNull);
      expect(validarTelefonoOpcional('912345678'), isNull);
      expect(validarTelefonoOpcional('12345'), isNotNull);
      expect(validarTelefonoOpcional('abc'), isNotNull);
      expect(validarTelefonoOpcional('+56 9 1234 5678 9012 3456'), isNotNull);
      expect(validarTelefonoOpcional('1' * 31), 'El teléfono es demasiado largo.');
    });

    test('obligatorio', () {
      expect(validarObligatorio(' ', 'Falta.'), 'Falta.');
      expect(validarObligatorio('algo', 'Falta.'), isNull);
    });
  });

  group('pantalla de ingreso', () {
    testWidgets('dice para quién es y deja mostrar la contraseña', (tester) async {
      await tester.pumpWidget(_app(const LoginScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Ingreso para clientes y personal de GOMAQ'), findsOneWidget);

      EditableText campoContrasena() => tester.widgetList<EditableText>(find.byType(EditableText)).last;
      expect(campoContrasena().obscureText, isTrue);

      await tester.tap(find.byTooltip('Mostrar contraseña'));
      await tester.pump();
      expect(campoContrasena().obscureText, isFalse);
      expect(find.byTooltip('Ocultar contraseña'), findsOneWidget);

      await tester.tap(find.byTooltip('Ocultar contraseña'));
      await tester.pump();
      expect(campoContrasena().obscureText, isTrue);
    });

    testWidgets('declara el autocompletado de correo y contraseña', (tester) async {
      await tester.pumpWidget(_app(const LoginScreen()));
      await tester.pumpAndSettle();

      final campos = tester.widgetList<EditableText>(find.byType(EditableText)).toList();
      expect(campos[0].autofillHints, contains(AutofillHints.username));
      expect(campos[1].autofillHints, contains(AutofillHints.password));
      expect(find.byType(AutofillGroup), findsOneWidget);
    });

    testWidgets('Siguiente en el correo pasa a la contraseña y no intenta entrar', (tester) async {
      await tester.pumpWidget(_app(const LoginScreen()));
      await tester.pumpAndSettle();

      final correo = find.byType(TextField).first;
      await tester.tap(correo);
      await tester.enterText(correo, 'ana@empresa.cl');
      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pumpAndSettle();

      // no se intentó iniciar sesión: no hay error ni spinner, y el foco quedó en la contraseña
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('No se pudo conectar al servidor. Revisa tu conexión.'), findsNothing);
      final campos = tester.widgetList<EditableText>(find.byType(EditableText)).toList();
      expect(campos[1].focusNode.hasFocus, isTrue);
    });
  });

  group('registro de cliente', () {
    testWidgets('muestra el error de cada campo sin enviar', (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(_app(const RegistroClienteScreen()));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Solicitar cuenta'));
      await tester.pumpAndSettle();

      expect(find.text('Revisa los campos marcados.'), findsOneWidget);
      expect(find.text('Escribe tu nombre.'), findsOneWidget);
      expect(find.text('Escribe tu correo.'), findsOneWidget);
      expect(find.text('Escribe una contraseña.'), findsOneWidget);
      expect(find.text('Repite la contraseña.'), findsOneWidget);
      expect(find.text('Escribe el nombre de la empresa.'), findsOneWidget);
    });

    testWidgets('contraseña corta, distinta y RUT o teléfono inválidos tienen su mensaje', (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(_app(const RegistroClienteScreen()));
      await tester.pumpAndSettle();

      final campos = find.byType(TextFormField);
      // orden del formulario: contacto, correo, contraseña, repetir, empresa, RUT, teléfono, ...
      await tester.enterText(campos.at(0), 'Ana Pérez');
      await tester.enterText(campos.at(1), 'ana@empresa');
      await tester.enterText(campos.at(2), '1234');
      await tester.enterText(campos.at(3), '12345');
      await tester.enterText(campos.at(4), 'Empresa SpA');
      await tester.enterText(campos.at(5), '76.123.456-7');
      await tester.enterText(campos.at(6), '123');
      await tester.tap(find.text('Solicitar cuenta'));
      await tester.pumpAndSettle();

      expect(find.text('Revisa el correo: falta el @ o el dominio.'), findsOneWidget);
      expect(find.text('Debe tener al menos 8 caracteres.'), findsOneWidget);
      expect(find.text('Las contraseñas no coinciden.'), findsOneWidget);
      expect(find.text('El RUT no es válido. Revisa el dígito verificador.'), findsOneWidget);
      expect(find.text('El teléfono debe tener entre 8 y 15 dígitos.'), findsOneWidget);
      expect(find.text('Escribe tu nombre.'), findsNothing);
    });

    testWidgets('el teléfono usa teclado de teléfono y su sugerencia de autocompletado', (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(_app(const RegistroClienteScreen()));
      await tester.pumpAndSettle();

      final telefono = tester.widgetList<EditableText>(find.byType(EditableText)).elementAt(6);
      expect(telefono.keyboardType, TextInputType.phone);
      expect(telefono.autofillHints, contains(AutofillHints.telephoneNumber));
    });

    testWidgets('al cambiar la contraseña se vuelve a validar la confirmación', (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(_app(const RegistroClienteScreen()));
      await tester.pumpAndSettle();

      final campos = find.byType(TextFormField);
      await tester.enterText(campos.at(2), 'clave1234');
      await tester.enterText(campos.at(3), 'clave1234');
      await tester.pumpAndSettle();
      expect(find.text('Las contraseñas no coinciden.'), findsNothing);

      await tester.enterText(campos.at(2), 'otraClave99');
      await tester.pumpAndSettle();
      expect(find.text('Las contraseñas no coinciden.'), findsOneWidget);
    });
  });
}
