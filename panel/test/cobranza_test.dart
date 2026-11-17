import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/cobranza.dart';

Map<String, dynamic> _fila(String estado, {int? mora, int? paraVencer, String? pago, String? nc}) => {
      'folio': '1001',
      'cliente_nombre': 'Cliente Ficticio Ltda',
      'estado_cobranza': estado,
      'dias_mora': mora ?? 0,
      'dias_para_vencer': paraVencer,
      'fecha_pago': pago,
      'anulada_nc': nc,
      'fecha_vencimiento': '2026-08-28',
    };

void main() {
  group('textoEstadoCobranza', () {
    test('vencida dice hace cuántos días', () {
      expect(textoEstadoCobranza(_fila('vencida', mora: 12)), 'Vencida hace 12 días');
      expect(textoEstadoCobranza(_fila('vencida', mora: 1)), 'Vencida hace 1 día');
    });

    test('próxima dice hoy, mañana o en N días', () {
      expect(textoEstadoCobranza(_fila('proxima', paraVencer: 0)), 'Vence hoy');
      expect(textoEstadoCobranza(_fila('proxima', paraVencer: 1)), 'Vence mañana');
      expect(textoEstadoCobranza(_fila('proxima', paraVencer: 5)), 'Vence en 5 días');
    });

    test('pagada lleva la fecha y avisa si pagó tarde', () {
      expect(textoEstadoCobranza(_fila('pagada', pago: '2026-09-03')), 'Pagada el 03-09-2026');
      expect(textoEstadoCobranza(_fila('pagada', pago: '2026-09-03', mora: 6)), 'Pagada el 03-09-2026, con 6 días de atraso');
    });

    test('anulada lleva el folio de la nota de crédito', () {
      expect(textoEstadoCobranza(_fila('anulada', nc: '88')), 'Anulada NC/88');
    });

    test('al día y sin vencimiento', () {
      expect(textoEstadoCobranza(_fila('al_dia')), 'Al día');
      expect(textoEstadoCobranza(_fila('sin_vencimiento')), 'Sin vencimiento');
    });

    test('el resumen para el lector de pantalla junta folio, cliente, estado y vencimiento', () {
      final r = resumenFacturaEmitida(_fila('vencida', mora: 3));
      expect(r, contains('Factura 1001'));
      expect(r, contains('Cliente Ficticio Ltda'));
      expect(r, contains('Vencida hace 3 días'));
      expect(r, contains('28-08-2026'));
    });
  });

  group('fechas', () {
    test('fechaGuiones pasa de AAAA-MM-DD a dd-mm-aaaa', () {
      expect(fechaGuiones('2026-08-28'), '28-08-2026');
      expect(fechaGuiones('2026-08-28T00:00:00.000Z'), '28-08-2026');
      expect(fechaGuiones(null), '-');
      expect(fechaGuiones('basura-basura', siVacio: 'sin fecha'), 'sin fecha');
    });

    test('diaIso y diaDesdeIso son inversos', () {
      expect(diaIso(DateTime(2026, 3, 5)), '2026-03-05');
      expect(diaDesdeIso('2026-03-05'), DateTime(2026, 3, 5));
      expect(diaDesdeIso('x'), isNull);
    });
  });

  group('sumaTraslado', () {
    test('suma entrega y retiro', () {
      expect(sumaTraslado('70.000', '70.000'), 140000);
      expect(sumaTraslado('100000', ''), 100000);
      expect(sumaTraslado('', '35.000'), 35000);
    });

    test('sin partes o con una inválida no hay suma', () {
      expect(sumaTraslado('', ''), isNull);
      expect(sumaTraslado('abc', '1000'), isNull);
      expect(sumaTraslado('1.5', ''), isNull, reason: 'los pesos son enteros');
      expect(sumaTraslado('-5', '10'), isNull);
    });
  });

  group('opcionesVencimiento', () {
    test('con vencimiento distinto del plazo ofrece las dos fechas, con la del PDF primero', () {
      final o = opcionesVencimiento({
        'propuesta': '2026-08-28',
        'origen': 'pdf',
        'alternativa': '2026-08-13',
        'coincide': false,
        'dias_pdf': 45,
        'plazo_cliente_dias': 30,
      })!;
      expect(o, hasLength(2));
      expect(o[0].dia, '2026-08-28');
      expect(o[0].texto, 'Fecha de la factura: 28-08-2026 (45 días)');
      expect(o[1].dia, '2026-08-13');
      expect(o[1].texto, 'Plazo habitual del cliente: 30 días, 13-08-2026');
    });

    test('sin conflicto no hay opciones', () {
      expect(opcionesVencimiento(null), isNull);
      expect(opcionesVencimiento({'propuesta': '2026-08-28', 'coincide': true, 'alternativa': null}), isNull);
      expect(opcionesVencimiento({'propuesta': '2026-08-28', 'coincide': null, 'alternativa': null}), isNull);
    });
  });

  group('filtroCobranzaDesdeUrl', () {
    test('acepta los filtros conocidos y deja todas ante cualquier otro', () {
      expect(filtroCobranzaDesdeUrl('vencidas'), 'vencidas');
      expect(filtroCobranzaDesdeUrl('proximas'), 'proximas');
      expect(filtroCobranzaDesdeUrl('aviso'), 'todas');
      expect(filtroCobranzaDesdeUrl(null), 'todas');
    });
  });
}
