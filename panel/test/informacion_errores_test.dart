import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:gomaq_web/screens/panel/notificaciones_screen.dart';
import 'package:gomaq_web/screens/panel/orden_detalle.dart';
import 'package:gomaq_web/screens/panel/ordenes_screen.dart';

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  group('destino y llegada estimada en el detalle de la OT', () {
    test('el destino se dice por su origen y nunca con coordenadas', () {
      expect(textoDestinoOt({'destino_lat': '-33.4', 'destino_lng': '-70.6', 'destino_origen': 'cliente'}), 'Ubicación del cliente');
      expect(textoDestinoOt({'destino_lat': '-33.4', 'destino_lng': '-70.6', 'destino_origen': 'guia'}), 'Ubicación de la guía');
      expect(textoDestinoOt({'destino_lat': null, 'destino_lng': null}), 'Sin destino');
      expect(textoDestinoOt({'destino_lat': '-33.4', 'destino_lng': '-70.6', 'destino_origen': 'cliente'}), isNot(contains('33')));
    });

    test('hayDestinoOt exige las dos coordenadas', () {
      expect(hayDestinoOt({'destino_lat': '-33.4', 'destino_lng': '-70.6'}), isTrue);
      expect(hayDestinoOt({'destino_lat': '-33.4', 'destino_lng': null}), isFalse);
    });

    test('la llegada estimada solo sale en camino y con el dato del servidor', () {
      final llegada = DateTime.utc(2026, 1, 1, 15, 40).toIso8601String();
      expect(horaLlegadaEstimada({'estado': 'en_camino', 'eta_llegada_at': llegada}), isNotNull);
      expect(horaLlegadaEstimada({'estado': 'en_terreno', 'eta_llegada_at': llegada}), isNull);
      expect(horaLlegadaEstimada({'estado': 'en_camino'}), isNull);
    });

    test('las cantidades de repuestos sin decimales crudos', () {
      expect(cantidadLineaRepuesto({'cantidad': '1.00', 'unidad_medida': 'unidad'}), '1 unidad');
      expect(cantidadLineaRepuesto({'cantidad': '2.50', 'unidad_medida': 'litro'}), '2,5 litro');
      expect(cantidadLineaRepuesto({'cantidad': '3.00', 'unidad_medida': 'unidad'}), '3 unidades');
    });
  });

  group('aviso de equipo con otra OT abierta', () {
    test('dice el número y el estado legible', () {
      expect(
        textoAvisoOtAbierta({'ot_abierta': {'id': 12, 'estado': 'en_camino'}}),
        'Este equipo ya tiene la OT-12 abierta (En camino).',
      );
    });

    test('sin OT abierta o sin equipo no hay aviso', () {
      expect(textoAvisoOtAbierta({'ot_abierta': null}), isNull);
      expect(textoAvisoOtAbierta({'codigo': 'X'}), isNull);
      expect(textoAvisoOtAbierta(null), isNull);
    });

    testWidgets('el aviso se anuncia solo y lleva el texto', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: AvisoOtAbierta(texto: 'Este equipo ya tiene la OT-1 abierta (Asignada).'))));
      expect(find.text('Este equipo ya tiene la OT-1 abierta (Asignada).'), findsOneWidget);
    });
  });

  group('avisos de notificaciones sin proveedor', () {
    test('reconoce el error de proveedor no configurado', () {
      expect(errorProveedorSinConectar('Proveedor de email no configurado todavia'), isTrue);
      expect(errorProveedorSinConectar('SMTP rechazó el destinatario'), isFalse);
      expect(errorProveedorSinConectar(null), isFalse);
    });

    test('el texto del aviso con ese error es el limpio', () {
      expect(
        textoDetalleNotificacion({'estado': 'error', 'intentos': 5, 'ultimo_error': 'Proveedor de email no configurado todavia'}),
        'Sin proveedor de envío conectado: el aviso quedó registrado.',
      );
    });

    test('los demás errores se muestran como hoy', () {
      expect(
        textoDetalleNotificacion({'estado': 'error', 'intentos': 3, 'ultimo_error': 'timeout'}),
        'Error tras 3 intentos: timeout',
      );
      expect(textoDetalleNotificacion({'estado': 'pendiente', 'intentos': 0}), 'Estado: pendiente (0 intentos)');
    });

    test('un pendiente que ya falló muestra el motivo, sin cambiar lo que se puede hacer con él', () {
      final n = {'estado': 'pendiente', 'intentos': 0, 'ultimo_error': 'Credencial de FCM rechazada', 'canal': 'push'};
      expect(textoDetalleNotificacion(n), 'Pendiente (0 intentos): Credencial de FCM rechazada');
      expect(puedeReintentarAviso(n), isFalse);
      expect(esAvisoSinProveedor(n), isFalse);
      // un pendiente con el error vacío o en blanco sigue con el texto de siempre
      expect(textoDetalleNotificacion({'estado': 'pendiente', 'intentos': 1, 'ultimo_error': '  '}), 'Estado: pendiente (1 intentos)');
      // el motivo no se agrega a los demás estados
      expect(textoDetalleNotificacion({'estado': 'enviado', 'intentos': 1, 'ultimo_error': 'nota'}), 'Estado: enviado (1 intentos)');
    });
  });
}
