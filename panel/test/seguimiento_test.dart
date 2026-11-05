import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/theme/gomaq_theme.dart';
import 'package:gomaq_web/screens/cliente/cliente_seguimiento_screen.dart';

void main() {
  group('pasos del seguimiento para el cliente', () {
    test('cada estado de la orden cae en su paso', () {
      expect(pasoParaCliente(null), 0);
      expect(pasoParaCliente('pendiente'), 0);
      expect(pasoParaCliente('asignada'), 1);
      expect(pasoParaCliente('aceptada'), 2);
      expect(pasoParaCliente('en_camino'), 3);
      expect(pasoParaCliente('en_terreno'), 4);
      expect(pasoParaCliente('en_reparacion'), 4);
      expect(pasoParaCliente('finalizada'), 5);
      expect(pasoParaCliente('estado_nuevo'), isNull, reason: 'un estado que no está en la lista no inventa un paso');
    });

    test('hay seis pasos, en el orden decidido', () {
      expect(pasosParaCliente, [
        'Solicitud recibida',
        'Técnico asignado',
        'Técnico aceptó',
        'Técnico en camino',
        'Trabajando en tu equipo',
        'Finalizada',
      ]);
    });

    test('las etiquetas del chip coinciden con los pasos', () {
      expect(etiquetaParaCliente('aceptada'), 'Técnico aceptó');
      expect(etiquetaParaCliente('en_terreno'), 'Trabajando en tu equipo');
      expect(etiquetaParaCliente('en_reparacion'), 'Trabajando en tu equipo');
      expect(etiquetaParaCliente('asignada'), 'Técnico asignado');
    });
  });

  group('horas, próximo paso y textos del seguimiento', () {
    final orden = <String, dynamic>{
      'id': 12,
      'estado': 'en_camino',
      'maquinaria_codigo': 'EQ-12',
      'fecha_creacion': '2026-11-04T12:00:00.000Z',
      'asignada_at': '2026-11-04T13:10:00.000Z',
      'aceptada_at': '2026-11-04T13:20:00.000Z',
      'en_camino_at': '2026-11-04T13:42:00.000Z',
      'llegada_at': null,
      'fecha_cierre': null,
      'vehiculo_marca': 'Ford',
      'vehiculo_modelo': 'Transit',
      'vehiculo_patente': 'ABCD12',
    };

    test('horaDePaso lee la hora de cada paso y es nula si falta', () {
      expect(horaDePaso(orden, 3)!.toUtc(), DateTime.utc(2026, 11, 4, 13, 42));
      expect(horaDePaso(orden, 1)!.toUtc(), DateTime.utc(2026, 11, 4, 13, 10));
      expect(horaDePaso(orden, 4), isNull);
      expect(horaDePaso(orden, 5), isNull);
      expect(horaDePaso(orden, 9), isNull);
      expect(horaDePaso({'asignada_at': 5}, 1), isNull, reason: 'un valor que no es texto no se interpreta');
      expect(horaDePaso({'asignada_at': 'no es una fecha'}, 1), isNull);
    });

    test('horaCorta da HH:MM con ceros y nulo sin hora', () {
      expect(horaCorta(DateTime(2026, 11, 4, 9, 5)), '09:05');
      expect(horaCorta(DateTime(2026, 11, 4, 14, 30)), '14:30');
      expect(horaCorta(null), isNull);
    });

    test('proximoPaso dice lo que viene y es nulo al terminar', () {
      expect(proximoPaso(null), 'Técnico asignado');
      expect(proximoPaso('pendiente'), 'Técnico asignado');
      expect(proximoPaso('asignada'), 'Técnico aceptó');
      expect(proximoPaso('aceptada'), 'Técnico en camino');
      expect(proximoPaso('en_camino'), 'Trabajando en tu equipo');
      expect(proximoPaso('en_terreno'), 'Finalizada');
      expect(proximoPaso('en_reparacion'), 'Finalizada');
      expect(proximoPaso('finalizada'), isNull);
    });

    test('resumenPaso lleva el número de paso y la hora si la hay', () {
      // el reloj se inyecta: con el real, la hora de la fixture deja de ser 'de hoy' al pasar la medianoche
      final enElMismoDia = DateTime.parse(orden['en_camino_at'] as String).add(const Duration(hours: 1));
      final texto = resumenPaso(orden, ahora: enElMismoDia);
      expect(texto, startsWith('Paso 4 de 6: Técnico en camino, desde las '));
      expect(resumenPaso({'estado': 'en_terreno', 'llegada_at': null}), 'Paso 5 de 6: Trabajando en tu equipo');
      expect(resumenPaso({'estado': null}), 'Paso 1 de 6: Solicitud recibida');
    });

    test('un estado desconocido dice solo En proceso y no tiene próximo paso', () {
      expect(resumenPaso({'estado': 'estado_nuevo'}), 'En proceso');
      expect(proximoPaso('estado_nuevo'), isNull);
      expect(etiquetaParaCliente('estado_nuevo'), 'En proceso');
    });

    test('horaConDia: solo la hora si es de hoy y con día si es de otro', () {
      final ahora = DateTime(2026, 11, 4, 18, 0);
      expect(horaConDia(DateTime(2026, 11, 4, 10, 42), ahora: ahora), '10:42');
      expect(horaConDia(DateTime(2026, 11, 3, 10, 42), ahora: ahora), '03/11 10:42');
      expect(horaConDia(DateTime(2025, 11, 4, 9, 5), ahora: ahora), '04/11 09:05', reason: 'mismo día y mes de otro año no es hoy');
      expect(horaConDia(null, ahora: ahora), isNull);
    });

    test('resumenPaso con la hora de otro día dice desde el día', () {
      final ahora = DateTime(2026, 11, 4, 18, 0);
      final ayer = DateTime(2026, 11, 3, 10, 42).toUtc().toIso8601String();
      final hoy = DateTime(2026, 11, 4, 10, 42).toUtc().toIso8601String();
      expect(resumenPaso({'estado': 'en_camino', 'en_camino_at': ayer}, ahora: ahora),
          'Paso 4 de 6: Técnico en camino, desde el 03/11 10:42');
      expect(resumenPaso({'estado': 'en_camino', 'en_camino_at': hoy}, ahora: ahora),
          'Paso 4 de 6: Técnico en camino, desde las 10:42');
    });

    test('descripcionVehiculo une marca, modelo y patente con lo que haya', () {
      expect(descripcionVehiculo(orden), 'Ford Transit · ABCD12');
      expect(descripcionVehiculo({'vehiculo_patente': 'ABCD12'}), 'ABCD12');
      expect(descripcionVehiculo({'vehiculo_marca': 'Ford', 'vehiculo_modelo': null, 'vehiculo_patente': ' '}), 'Ford');
      expect(descripcionVehiculo({}), isNull);
    });

    test('títulos sin jerga', () {
      expect(tituloOrden(orden), 'Reparación de EQ-12 (N.º 12)');
      expect(tituloAsistencia({'maquinaria_codigo': 'EQ-12'}), 'Solicitud de asistencia · EQ-12');
    });

    test('etiquetaCobro traduce lo que dice el servidor', () {
      expect(etiquetaCobro('con_cobro'), 'Con cobro');
      expect(etiquetaCobro('sin_cobro'), 'Sin cobro');
      expect(etiquetaCobro('por_definir'), 'Por confirmar');
      expect(etiquetaCobro(null), isNull);
      expect(etiquetaCobro('otra cosa'), isNull);
    });

    test('pestanaDePortal lee la URL y cae en Mis equipos', () {
      expect(pestanaDePortal('seguimiento'), 1);
      expect(pestanaDePortal('historial'), 2);
      expect(pestanaDePortal(null), 0);
      expect(pestanaDePortal('cualquiera'), 0);
    });
  });

  group('contraste de los pasos del seguimiento sobre blanco', () {
    double contraste(Color a, Color b) {
      final la = a.computeLuminance(), lb = b.computeLuminance();
      return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
    }

    test('el ícono y el texto de un paso pendiente llegan a 4,5:1', () {
      expect(contraste(GomaqColors.estadoNeutro, Colors.white), greaterThanOrEqualTo(4.5));
      expect(contraste(Colors.grey.shade700, Colors.white), greaterThanOrEqualTo(4.5));
      expect(contraste(GomaqColors.accion, Colors.white), greaterThanOrEqualTo(4.5));
    });
  });
}
