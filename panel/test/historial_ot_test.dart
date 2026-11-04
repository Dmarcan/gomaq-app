import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/historial_ot.dart';

/// Fecha local convertida a ISO en UTC, como la entrega la API.
String _iso(DateTime local) => local.toUtc().toIso8601String();

void main() {
  group('texto de la línea de tiempo de la orden', () {
    test('creación y cierre', () {
      expect(textoEventoOt({'tipo': 'creacion', 'origen': 'panel'}), 'Creada');
      expect(textoEventoOt({'tipo': 'creacion', 'origen': 'terreno'}), 'Creada en terreno');
      expect(
        textoEventoOt({'tipo': 'creacion', 'origen': 'panel', 'detalle': {'solicitud_id': 4}}),
        'Creada a partir de una solicitud del cliente',
      );
      expect(textoEventoOt({'tipo': 'cierre', 'estado_nuevo': 'finalizada'}), 'Cerrada');
    });

    test('asignación y reasignación nombran al mecánico', () {
      expect(
        textoEventoOt({'tipo': 'asignacion', 'detalle': {'mecanico_nuevo_nombre': 'Pedro Soto', 'mecanico_anterior_id': null}}),
        'Asignada a Pedro Soto',
      );
      expect(
        textoEventoOt({'tipo': 'asignacion', 'detalle': {'mecanico_nuevo_nombre': 'Ana Rojas', 'mecanico_anterior_id': 7}}),
        'Reasignada a Ana Rojas',
      );
      expect(textoEventoOt({'tipo': 'asignacion', 'detalle': null}), 'Asignada a otro mecánico');
    });

    test('el mismo mecánico como anterior y nuevo no es reasignación', () {
      expect(
        textoEventoOt({'tipo': 'asignacion', 'detalle': {'mecanico_nuevo_nombre': 'Pedro Soto', 'mecanico_anterior_id': 7, 'mecanico_nuevo_id': 7}}),
        'Asignada a Pedro Soto',
      );
      expect(
        textoEventoOt({'tipo': 'asignacion', 'detalle': {'mecanico_nuevo_nombre': 'Ana Rojas', 'mecanico_anterior_id': 7, 'mecanico_nuevo_id': 8}}),
        'Reasignada a Ana Rojas',
      );
    });

    test('toma de una orden sin asignar', () {
      expect(textoEventoOt({'tipo': 'toma'}), 'Tomada por el mecánico');
    });

    test('cambio de estado dice de qué estado a cuál', () {
      expect(
        textoEventoOt({'tipo': 'cambio_estado', 'estado_anterior': 'asignada', 'estado_nuevo': 'aceptada', 'aplicado': true}),
        'Estado: de Asignada a Aceptada',
      );
      expect(
        textoEventoOt({'tipo': 'cambio_estado', 'estado_anterior': null, 'estado_nuevo': 'en_terreno'}),
        'Estado: pasó a En terreno',
      );
    });

    test('un cambio atrasado que no se aplicó lo dice', () {
      expect(
        textoEventoOt({'tipo': 'cambio_estado', 'estado_anterior': 'en_terreno', 'estado_nuevo': 'aceptada', 'aplicado': false}),
        'Estado: Aceptada (llegó atrasado, la orden ya estaba más adelante)',
      );
    });

    test('repetir el estado en que ya estaba la orden no se dice como atraso', () {
      expect(
        textoEventoOt({'tipo': 'cambio_estado', 'estado_anterior': 'en_terreno', 'estado_nuevo': 'en_terreno', 'aplicado': false}),
        'Se repitió el estado En terreno (la orden ya estaba en ese estado)',
      );
    });

    test('valorización con y sin monto anterior', () {
      expect(
        textoEventoOt({'tipo': 'valorizacion', 'detalle': {'valorizacion_anterior': null, 'valorizacion_nueva': 249900}}),
        'Valorizada en \$249.900',
      );
      expect(
        textoEventoOt({'tipo': 'valorizacion', 'detalle': {'valorizacion_anterior': 15000, 'valorizacion_nueva': 20000}}),
        'Valorización cambiada de \$15.000 a \$20.000',
      );
    });

    test('valorización anulada por un cambio de líneas', () {
      expect(
        textoEventoOt({
          'tipo': 'valorizacion',
          'detalle': {'anulada': true, 'valorizacion_anterior': 7000, 'valorizacion_nueva': null},
        }),
        'Valorización anulada por un cambio en las líneas facturables',
      );
    });

    test('línea agregada con y sin motivo', () {
      expect(
        textoEventoOt({'tipo': 'linea_agregada', 'detalle': {'insumo': 'Filtro de aceite', 'motivo_codigo': null, 'motivo': null}}),
        'Repuesto agregado: Filtro de aceite',
      );
      expect(
        textoEventoOt({
          'tipo': 'linea_agregada',
          'detalle': {'insumo': 'Correa', 'motivo_codigo': 'error_registro', 'motivo': 'Faltaba en el talonario'},
        }),
        'Repuesto agregado: Correa. Motivo: Error de registro: Faltaba en el talonario',
      );
      expect(textoEventoOt({'tipo': 'linea_agregada', 'detalle': null}), 'Repuesto agregado: sin nombre');
    });

    test('facturable modificado dice de qué a qué y el motivo', () {
      expect(
        textoEventoOt({
          'tipo': 'linea_modificada',
          'detalle': {
            'insumo': 'Filtro', 'campo': 'facturable', 'antes': 'si', 'despues': 'no',
            'motivo_codigo': 'garantia', 'motivo': 'Cambio por garantía del fabricante',
          },
        }),
        'Facturable de Filtro: Sí a No. Motivo: Garantía: Cambio por garantía del fabricante',
      );
      expect(
        textoEventoOt({'tipo': 'linea_modificada', 'detalle': {'insumo': 'Filtro', 'campo': 'facturable', 'antes': 'pendiente', 'despues': 'si'}}),
        'Facturable de Filtro: Por decidir a Sí',
      );
    });

    test('precio, cantidad y descripción modificados', () {
      expect(
        textoEventoOt({'tipo': 'linea_modificada', 'detalle': {'insumo': 'Filtro', 'campo': 'precio_unitario', 'antes': 1000, 'despues': 1500}}),
        'Precio de Filtro: \$1.000 a \$1.500',
      );
      expect(
        textoEventoOt({'tipo': 'linea_modificada', 'detalle': {'insumo': 'Filtro', 'campo': 'precio_unitario', 'antes': null, 'despues': 900}}),
        'Precio de Filtro: sin precio a \$900',
      );
      expect(
        textoEventoOt({'tipo': 'linea_modificada', 'detalle': {'insumo': 'Filtro', 'campo': 'cantidad', 'antes': 2, 'despues': 3}}),
        'Cantidad de Filtro: 2 a 3',
      );
      expect(
        textoEventoOt({'tipo': 'linea_modificada', 'detalle': {'insumo': 'Filtro', 'campo': 'descripcion'}}),
        'Descripción de Filtro cambiada',
      );
      expect(textoEventoOt({'tipo': 'linea_modificada', 'detalle': null}), 'Repuesto modificado: sin nombre');
    });

    test('línea anulada con motivo; solo el texto si el código no es de la lista', () {
      expect(
        textoEventoOt({
          'tipo': 'linea_anulada',
          'detalle': {'insumo': 'Correa', 'motivo_codigo': 'cliente_antiguo', 'motivo': 'Cliente antiguo, no se cobra'},
        }),
        'Repuesto anulado: Correa. Motivo: Cliente antiguo: Cliente antiguo, no se cobra',
      );
      expect(
        textoEventoOt({'tipo': 'linea_anulada', 'detalle': {'insumo': 'Correa', 'motivo_codigo': 'raro', 'motivo': 'Texto libre'}}),
        'Repuesto anulado: Correa. Motivo: Texto libre',
      );
      expect(textoEventoOt({'tipo': 'linea_anulada', 'detalle': {'insumo': 'Correa'}}), 'Repuesto anulado: Correa');
    });

    test('factura cargada con folio', () {
      expect(textoEventoOt({'tipo': 'factura_cargada', 'detalle': {'folio': 'F-5001', 'monto': 119000}}), 'Factura folio F-5001 cargada');
      expect(textoEventoOt({'tipo': 'factura_cargada', 'detalle': {'folio': 1234}}), 'Factura folio 1234 cargada');
      expect(textoEventoOt({'tipo': 'factura_cargada', 'detalle': null}), 'Factura cargada');
    });

    test('factura anulada con motivo', () {
      expect(
        textoEventoOt({
          'tipo': 'factura_anulada',
          'detalle': {'folio': 'F-1001', 'motivo_codigo': 'error_registro', 'motivo': 'Se subió la factura equivocada'},
        }),
        'Factura folio F-1001 anulada. Motivo: Error de registro: Se subió la factura equivocada',
      );
      expect(textoEventoOt({'tipo': 'factura_anulada', 'detalle': null}), 'Factura anulada');
    });

    test('un tipo desconocido no rompe la pantalla', () {
      expect(textoEventoOt({'tipo': 'algo_nuevo'}), 'Evento registrado');
    });
  });

  group('sincronización tardía y autor', () {
    test('solo se menciona cuando el evento llegó tarde', () {
      // las fechas se arman en hora local: el texto sale en la zona del dispositivo y la prueba
      // pasa en cualquier zona horaria
      expect(textoSincronizacionOt({'sincronizado_tarde': false, 'registrado_en': _iso(DateTime(2026, 11, 3, 14, 35))}), isNull);
      final texto = textoSincronizacionOt({
        'sincronizado_tarde': true,
        'ocurrio_en': _iso(DateTime(2026, 11, 3, 14, 0)),
        'registrado_en': _iso(DateTime(2026, 11, 3, 14, 35)),
      });
      expect(texto, 'sincronizado a las 14:35');
      expect(textoSincronizacionOt({'sincronizado_tarde': true, 'registrado_en': null}), isNull);
    });

    test('si llegó otro día, agrega la fecha', () {
      final texto = textoSincronizacionOt({
        'sincronizado_tarde': true,
        'ocurrio_en': _iso(DateTime(2026, 11, 3, 15, 0)),
        'registrado_en': _iso(DateTime(2026, 11, 5, 15, 0)),
      });
      expect(texto, 'sincronizado el 05/11 a las 15:00');
    });

    test('quién lo hizo: el usuario, o una nota si es un registro reconstruido', () {
      expect(quienHizoEventoOt({'usuario_nombre': 'Pedro Soto', 'origen': 'terreno'}), 'Pedro Soto');
      expect(quienHizoEventoOt({'usuario_nombre': null, 'origen': 'migracion'}), 'Registro anterior al historial');
      expect(quienHizoEventoOt({'usuario_nombre': null, 'origen': 'sistema'}), isNull);
    });
  });
}
