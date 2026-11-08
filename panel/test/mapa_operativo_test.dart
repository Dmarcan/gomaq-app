import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/mapa_operativo.dart';

Map<String, dynamic> _equipo(int id, {String situacion = 'arrendado', double? lat = -33.45, double? lng = -70.65, String? cliente = 'Acsa'}) => {
      'id': id,
      'codigo': 'EQ-$id',
      'tipo': 'Grúa',
      'marca': 'Genie',
      'modelo': null,
      'estado': 'operativa',
      'situacion': situacion,
      'cliente': situacion == 'arrendado' ? {'id': 3, 'nombre': cliente} : null,
      'direccion': 'Av. Uno 1',
      'latitud': lat,
      'longitud': lng,
      'origen_ubicacion': lat == null ? null : 'guia',
      'alerta_mantencion': id == 2,
    };

void main() {
  group('DatosMapa.fromJson', () {
    test('lee equipos, furgones y bodega, con nulos y números enteros o decimales', () {
      final d = DatosMapa.fromJson({
        'generado_at': '2026-11-08T15:00:00.000Z',
        'bodega': {'id': 1, 'nombre': 'Bodega central', 'latitud': -33, 'longitud': -70.5},
        'equipos': [_equipo(1), _equipo(2, situacion: 'bodega', lat: null, lng: null)],
        'furgones': [
          {
            'orden_trabajo_id': 9,
            'mecanico_nombre': 'Pedro',
            'vehiculo': {'patente': 'AB1234', 'marca': 'Hyundai', 'modelo': null},
            'cliente_nombre': 'Acsa',
            'maquinaria_codigo': 'EQ-1',
            'latitud': null,
            'longitud': null,
            'posicion_at': null,
            'eta_llegada_at': '2026-11-08T15:30:00.000Z',
            'eta_aproximada': true,
          },
        ],
      });
      expect(d.bodega!.ubicacion!.latitud, -33.0);
      expect(d.equipos.first.arrendado, isTrue);
      expect(d.equipos.first.clienteNombre, 'Acsa');
      expect(d.equipos.first.descripcion, 'Grúa · Genie');
      expect(d.equipos[1].arrendado, isFalse);
      expect(d.equipos[1].alertaMantencion, isTrue);
      expect(d.equipos[1].ubicacion, isNull);
      expect(d.furgones.single.patente, 'AB1234');
      expect(d.furgones.single.vehiculo, 'Hyundai');
      expect(d.furgones.single.ubicacion, isNull);
      expect(d.furgones.single.etaAproximada, isTrue);
      expect(d.equiposEnMapa.length, 1);
      expect(d.equiposSinUbicacion.length, 1);
      expect(d.furgonesSinPosicion.length, 1);
    });

    test('una respuesta vacía o sin bodega no rompe', () {
      final d = DatosMapa.fromJson({'bodega': null, 'equipos': [], 'furgones': []});
      expect(d.bodega, isNull);
      expect(d.equipos, isEmpty);
    });
  });

  group('agruparPorPunto', () {
    test('equipos en el mismo punto van juntos; los sin ubicación se ignoran', () {
      final equipos = [
        EquipoMapa.fromJson(_equipo(1)),
        EquipoMapa.fromJson(_equipo(2, lat: -33.450001, lng: -70.650001)),
        EquipoMapa.fromJson(_equipo(3, lat: -33.2, lng: -70.1)),
        EquipoMapa.fromJson(_equipo(4, lat: null, lng: null)),
      ];
      final grupos = agruparPorPunto(equipos);
      expect(grupos.length, 2);
      expect(grupos.firstWhere((g) => g.length == 2).map((e) => e.id), [1, 2]);
    });
  });

  group('haceCuanto y posicionAntigua', () {
    final ahora = DateTime(2026, 11, 8, 12, 0);
    test('minutos, horas y días', () {
      expect(haceCuanto(ahora.subtract(const Duration(seconds: 20)), ahora), 'hace un momento');
      expect(haceCuanto(ahora.subtract(const Duration(minutes: 7)), ahora), 'hace 7 min');
      expect(haceCuanto(ahora.subtract(const Duration(hours: 3)), ahora), 'hace 3 h');
      expect(haceCuanto(ahora.subtract(const Duration(days: 2)), ahora), 'hace 2 d');
    });

    test('más de 15 minutos es antigua', () {
      expect(posicionAntigua(ahora.subtract(const Duration(minutes: 15)), ahora), isFalse);
      expect(posicionAntigua(ahora.subtract(const Duration(minutes: 16)), ahora), isTrue);
    });
  });

  group('filtrarDatos', () {
    final datos = DatosMapa.fromJson({
      'bodega': {'id': 1, 'nombre': 'Bodega central', 'latitud': -33.5, 'longitud': -70.7},
      'equipos': [
        _equipo(1),
        _equipo(2, situacion: 'bodega', lat: -33.5, lng: -70.7),
        _equipo(3, cliente: 'Minera Gamma'),
      ],
      'furgones': [
        {
          'orden_trabajo_id': 9,
          'mecanico_nombre': 'Pedro Pérez',
          'vehiculo': {'patente': 'AB1234', 'marca': 'Hyundai', 'modelo': 'H100'},
          'cliente_nombre': 'Acsa',
          'maquinaria_codigo': 'EQ-1',
        },
      ],
    });

    test('sin texto devuelve todo', () {
      expect(filtrarDatos(datos, '   ').equipos.length, 3);
    });

    test('ignora tildes y mayúsculas, y exige todas las palabras', () {
      expect(filtrarDatos(datos, 'GRUA').equipos.length, 3);
      expect(filtrarDatos(datos, 'grua minera').equipos.map((e) => e.id), [3]);
      expect(filtrarDatos(datos, 'eq-2').equipos.map((e) => e.id), [2]);
      expect(filtrarDatos(datos, 'zzz').equipos, isEmpty);
    });

    test('busca también técnicos y patentes, y conserva la bodega', () {
      final r = filtrarDatos(datos, 'perez');
      expect(r.furgones.length, 1);
      expect(r.equipos, isEmpty);
      expect(r.bodega, isNotNull);
      expect(filtrarDatos(datos, 'ab1234').furgones.length, 1);
    });
  });
}
