import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/widgets/asignar_cliente.dart';

/// Abre el cuadro de Retirar desde un botón. Cada llamada a la función de envío queda en [envios].
Future<void> _abrirRetiro(
  WidgetTester tester,
  EnviarGuia enviar, {
  List<bool>? resultado,
}) async {
  tester.view.physicalSize = const Size(900, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            onPressed: () async {
              final r = await mostrarGuiaRapida(
                context,
                tipo: 'recepcion',
                maquinariaId: 12,
                codigo: 'EQ-12',
                clienteActual: 'ACSA',
                enviar: enviar,
              );
              resultado?.add(r);
            },
            child: const Text('abrir'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('abrir'));
  await tester.pumpAndSettle();
}

Future<void> _guardar(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Retirar'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));


  testWidgets('una recepción se envía sin cliente_id, con la hora en UTC y la llave del cuadro', (tester) async {
    final envios = <(String, Map<String, String>)>[];
    final resultado = <bool>[];
    await _abrirRetiro(tester, (ruta, campos) async {
      envios.add((ruta, campos));
      return {'id': 1};
    }, resultado: resultado);

    expect(find.textContaining('EQ-12 se libera de ACSA'), findsOneWidget);
    await _guardar(tester);

    expect(envios, hasLength(1));
    final (ruta, campos) = envios.single;
    expect(ruta, '/api/maquinarias/12/guias');
    expect(campos['tipo'], 'recepcion');
    expect(campos['sin_documento'], 'true');
    expect(campos.containsKey('cliente_id'), isFalse);
    expect(campos['uuid_cliente'], isNotEmpty);
    expect(campos['fecha_hora'], endsWith('Z'));
    expect(campos.containsKey('horometro'), isFalse);
    expect(resultado, [true]);
    expect(find.textContaining('Equipo retirado'), findsOneWidget);
  });

  testWidgets('un horómetro inválido no se envía y el cuadro lo dice', (tester) async {
    var llamadas = 0;
    await _abrirRetiro(tester, (ruta, campos) async {
      llamadas++;
      return {'id': 1};
    });
    await tester.enterText(find.byType(TextFormField), 'abc');
    await _guardar(tester);
    expect(llamadas, 0);
    expect(find.textContaining('El horómetro no es un número válido'), findsOneWidget);
  });

  testWidgets('el horómetro con miles y coma se envía normalizado', (tester) async {
    final campos = <Map<String, String>>[];
    await _abrirRetiro(tester, (ruta, c) async {
      campos.add(c);
      return {'id': 1};
    });
    await tester.enterText(find.byType(TextFormField), '1.156,5');
    await _guardar(tester);
    expect(campos.single['horometro'], '1156.5');
  });

  testWidgets('sin respuesta: el cuadro sigue abierto y reintentar usa la misma llave', (tester) async {
    final llaves = <String>[];
    var intento = 0;
    await _abrirRetiro(tester, (ruta, campos) async {
      llaves.add(campos['uuid_cliente']!);
      intento++;
      if (intento == 1) throw TimeoutException('sin respuesta');
      return {'id': 1};
    });
    await _guardar(tester);
    expect(find.textContaining('no se duplica'), findsOneWidget);
    // el cuadro sigue abierto
    expect(find.widgetWithText(FilledButton, 'Retirar'), findsOneWidget);

    // aunque cambie un dato, con la respuesta perdida la llave se conserva
    await tester.enterText(find.byType(TextFormField), '100');
    await _guardar(tester);
    expect(llaves, hasLength(2));
    expect(llaves[1], llaves[0]);
  });

  testWidgets('con el envío resuelto, cambiar un dato renueva la llave', (tester) async {
    final llaves = <String>[];
    var intento = 0;
    await _abrirRetiro(tester, (ruta, campos) async {
      llaves.add(campos['uuid_cliente']!);
      intento++;
      if (intento == 1) throw ApiException(400, 'Dato inválido');
      return {'id': 1};
    });
    await _guardar(tester);
    expect(find.text('Dato inválido'), findsOneWidget);
    await tester.enterText(find.byType(TextFormField), '100');
    await _guardar(tester);
    expect(llaves, hasLength(2));
    expect(llaves[1], isNot(llaves[0]));
  });

  testWidgets('un 409 tras perder la respuesta explica que ya hay una guía con los datos anteriores', (tester) async {
    var intento = 0;
    await _abrirRetiro(tester, (ruta, campos) async {
      intento++;
      if (intento == 1) throw TimeoutException('sin respuesta');
      throw ApiException(409, 'uuid usado');
    });
    await _guardar(tester);
    await tester.enterText(find.byType(TextFormField), '100');
    await _guardar(tester);
    expect(find.textContaining('Ya se registró una guía con los datos anteriores'), findsOneWidget);
  });

  testWidgets('si el servidor ya tenía la guía, el aviso lo dice', (tester) async {
    await _abrirRetiro(tester, (ruta, campos) async => {'id': 1, 'ya_registrada': true});
    await _guardar(tester);
    expect(find.textContaining('Este retiro ya estaba registrado'), findsOneWidget);
  });
}
