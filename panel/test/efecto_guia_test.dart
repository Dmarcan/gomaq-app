import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/efecto_guia.dart';

void main() {
  final equipos = <Map<String, dynamic>>[
    {'id': 1, 'codigo': 'EQ-1', 'estado': 'operativa', 'cliente_id': null},
    {'id': 2, 'codigo': 'EQ-2', 'estado': 'operativa', 'cliente_id': 7, 'cliente': 'ACSA'},
    {'id': 3, 'codigo': 'EQ-3', 'estado': 'fuera_de_servicio', 'cliente_id': null},
    {'id': 4, 'codigo': 'EQ-4', 'estado': 'fuera_de_servicio', 'cliente_id': 8, 'cliente': 'Prize'},
    {'id': 5, 'codigo': 'EQ-5', 'estado': 'en_mantencion', 'cliente_id': null},
  ];
  List<int> ids(List<Map<String, dynamic>> l) => [for (final m in l) m['id'] as int];

  group('equiposParaGuia', () {
    test('despacho: sin cliente y no fuera de servicio', () {
      expect(ids(equiposParaGuia(equipos, tipo: 'despacho')), [1, 5]);
    });

    test('recepcion: con cliente, también el averiado', () {
      expect(ids(equiposParaGuia(equipos, tipo: 'recepcion')), [2, 4]);
    });

    test('ver todos: despacho nunca admite fuera de servicio, recepción sí', () {
      expect(ids(equiposParaGuia(equipos, tipo: 'despacho', verTodos: true)), [1, 2, 5]);
      expect(ids(equiposParaGuia(equipos, tipo: 'recepcion', verTodos: true)), [1, 2, 3, 4, 5]);
    });
  });

  group('validarFechaGuiaRapida', () {
    final ahora = DateTime(2026, 11, 4, 12, 0);

    test('ahora y un día atrás valen', () {
      expect(validarFechaGuiaRapida(ahora, ahora), isNull);
      expect(validarFechaGuiaRapida(ahora.subtract(const Duration(days: 1)), ahora), isNull);
    });

    test('el futuro no vale, salvo el margen de 5 minutos', () {
      expect(validarFechaGuiaRapida(ahora.add(const Duration(minutes: 4)), ahora), isNull);
      expect(validarFechaGuiaRapida(ahora.add(const Duration(hours: 1)), ahora), isNotNull);
    });

    test('más de 30 días atrás no vale', () {
      expect(validarFechaGuiaRapida(ahora.subtract(const Duration(days: 30)), ahora), isNull);
      expect(validarFechaGuiaRapida(ahora.subtract(const Duration(days: 31)), ahora), isNotNull);
    });
  });

  group('describirEfectoGuia', () {
    final f = DateTime(2026, 11, 4, 14, 30);

    test('despacho con cliente', () {
      expect(
        describirEfectoGuia(tipo: 'despacho', codigo: 'EQ-1', fecha: f, clienteNombre: 'ACSA'),
        'EQ-1 quedará arrendado a ACSA, con fecha 04/11 14:30.',
      );
    });

    test('despacho de un equipo que ya tiene cliente avisa del cambio', () {
      expect(
        describirEfectoGuia(tipo: 'despacho', codigo: 'EQ-1', fecha: f, clienteNombre: 'Prize', clienteActual: 'ACSA'),
        'EQ-1 deja de estar con ACSA y pasa a Prize, con fecha 04/11 14:30.',
      );
    });

    test('despacho sin cliente pide elegirlo', () {
      expect(describirEfectoGuia(tipo: 'despacho', codigo: 'EQ-1', fecha: f), contains('Elige el cliente'));
    });

    test('recepción con y sin cliente actual', () {
      expect(
        describirEfectoGuia(tipo: 'recepcion', codigo: 'EQ-2', fecha: f, clienteActual: 'ACSA'),
        'EQ-2 se libera de ACSA con fecha 04/11 14:30 y queda sin cliente.',
      );
      expect(describirEfectoGuia(tipo: 'recepcion', codigo: 'EQ-2', fecha: f), contains('no cierra ningún arriendo'));
    });

    test('fallida no cambia nada', () {
      expect(describirEfectoGuia(tipo: 'despacho', codigo: 'EQ-1', fecha: f, fallido: true), contains('no se cobra'));
      final retiro = describirEfectoGuia(tipo: 'recepcion', codigo: 'EQ-2', fecha: f, fallido: true);
      expect(retiro, contains('el arriendo sigue corriendo'));
      expect(retiro, contains('se ignoran'));
    });

    test('el horómetro se promete solo si es válido', () {
      expect(
        describirEfectoGuia(tipo: 'despacho', codigo: 'EQ-1', fecha: f, clienteNombre: 'ACSA', horometro: '1.156'),
        endsWith('Se registra una lectura de horómetro de 1156 h.'),
      );
      for (final malo in ['  ', 'abc', '-5', '1,2,3']) {
        expect(describirEfectoGuia(tipo: 'despacho', codigo: 'EQ-1', fecha: f, clienteNombre: 'ACSA', horometro: malo),
            isNot(contains('horómetro')), reason: malo);
      }
    });

    test('con otro año se muestra el año', () {
      expect(fechaHoraCorta(DateTime(2025, 12, 31, 9, 5), ahora: DateTime(2026, 11, 4)), '31/12/2025 09:05');
      expect(fechaHoraCorta(DateTime(2026, 12, 31, 9, 5), ahora: DateTime(2026, 11, 4)), '31/12 09:05');
    });
  });

  group('parsearHorometro', () {
    test('coma decimal, punto decimal y enteros', () {
      expect(parsearHorometro('1156'), 1156);
      expect(parsearHorometro('1156,5'), 1156.5);
      expect(parsearHorometro('1156.5'), 1156.5);
      expect(parsearHorometro(' 12.5 '), 12.5);
      expect(parsearHorometro('0'), 0);
    });

    test('separador de miles chileno', () {
      expect(parsearHorometro('1.156'), 1156);
      expect(parsearHorometro('12.345.678'), 12345678);
      expect(parsearHorometro('1.156,5'), 1156.5);
      expect(parsearHorometro('1,156.5'), 1156.5);
    });

    test('rechaza lo inválido', () {
      for (final malo in ['', '  ', 'abc', '-5', '1,2,3', '1.2.3', '12a', '1,', ',5', '1..2', '1.156,5,1', 'Infinity', '1e5']) {
        expect(parsearHorometro(malo), isNull, reason: 'debe rechazar "$malo"');
      }
    });

    test('horometroParaEnvio da texto limpio', () {
      expect(horometroParaEnvio('1.156'), '1156');
      expect(horometroParaEnvio('1156,5'), '1156.5');
      expect(horometroParaEnvio('x'), isNull);
    });
  });

  group('fechaIsoUtc', () {
    test('lleva la Z y es el mismo instante', () {
      final local = DateTime(2026, 11, 4, 14, 30);
      final texto = fechaIsoUtc(local);
      expect(texto.endsWith('Z'), isTrue);
      expect(DateTime.parse(texto).isAtSameMomentAs(local), isTrue);
    });
  });
}
