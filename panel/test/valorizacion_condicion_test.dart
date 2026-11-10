import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/orden_detalle.dart';
import 'package:gomaq_web/utils/roles.dart';

void main() {
  final orden = {'facturable': true, 'valorizacion': null};

  test('el gerente aprueba solo cuando la orden está finalizada', () {
    expect(puedeAprobarValorizacion(esGerente: true, orden: orden, cerrada: true), isTrue);
    expect(puedeAprobarValorizacion(esGerente: true, orden: orden, cerrada: false), isFalse);
  });

  test('no aprueba si no es gerente, no es facturable o ya está valorizada', () {
    expect(puedeAprobarValorizacion(esGerente: false, orden: orden, cerrada: true), isFalse);
    expect(puedeAprobarValorizacion(esGerente: true, orden: {'facturable': false}, cerrada: true), isFalse);
    expect(puedeAprobarValorizacion(esGerente: true, orden: {'facturable': true, 'valorizacion': 1000}, cerrada: true), isFalse);
  });

  test('repuestosSinDecidir cuenta solo las líneas vigentes en "pendiente"', () {
    final lineas = [
      {'facturable': 'pendiente', 'anulada_at': null},
      {'facturable': 'si', 'anulada_at': null},
      {'facturable': 'pendiente', 'anulada_at': '2026-01-01'},
      {'facturable': null},
    ];
    expect(repuestosSinDecidir(lineas), 2);
    expect(repuestosSinDecidir([]), 0);
  });

  test('el texto de la confirmación concuerda en número', () {
    expect(textoConfirmarValorizacion(1), 'Hay 1 repuesto sin decidir si se cobra. ¿Aprobar la valorización igual?');
    expect(textoConfirmarValorizacion(3), 'Hay 3 repuestos sin decidir si se cobran. ¿Aprobar la valorización igual?');
  });

  test('nombreRol da el nombre legible', () {
    expect(nombreRol('mecanico'), 'Mecánico');
    expect(nombreRol('administrativo'), 'Administrativo');
    expect(nombreRol('gerente'), 'Gerente');
    expect(nombreRol('otro'), 'otro');
  });
}
