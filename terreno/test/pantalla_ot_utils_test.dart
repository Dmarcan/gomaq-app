import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/utils/accion_unica.dart';
import 'package:gomaq_mecanico/utils/cantidad_unidad.dart';
import 'package:gomaq_mecanico/utils/datos_finales.dart';
import 'package:gomaq_mecanico/utils/hoja_inferior.dart';

void main() {
  group('AccionUnica (doble toque)', () {
    test('dos toques seguidos ejecutan la accion una sola vez', () async {
      var tareasEncoladas = 0;
      final guarda = AccionUnica();
      Future<void> encolar() async {
        tareasEncoladas++;
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }

      final a = guarda.ejecutar(encolar);
      final b = guarda.ejecutar(encolar);
      expect(guarda.enCurso, isTrue);
      expect(await a, isTrue);
      expect(await b, isFalse);
      expect(tareasEncoladas, 1);
      expect(guarda.enCurso, isFalse);
    });

    test('despues de terminar se puede volver a ejecutar, tambien si fallo', () async {
      var veces = 0;
      final guarda = AccionUnica();
      await expectLater(guarda.ejecutar(() async => throw StateError('x')), throwsStateError);
      expect(guarda.enCurso, isFalse);
      await guarda.ejecutar(() async => veces++);
      expect(veces, 1);
    });

    test('avisa al cambiar para deshabilitar el boton', () async {
      final avisos = <bool>[];
      late final AccionUnica guarda;
      guarda = AccionUnica(alCambiar: () => avisos.add(guarda.enCurso));
      await guarda.ejecutar(() async {});
      expect(avisos, [true, false]);
    });
  });

  group('hayDatosFinalesSinGuardar (finalizar sin pulsar Guardar)', () {
    test('observacion final nueva sin guardar: hay que encolar antes del cierre', () {
      expect(
        hayDatosFinalesSinGuardar(
            observacionActual: ' Se cambia llave ', observacionGuardada: '', folioActual: '', folioGuardado: ''),
        isTrue,
      );
    });

    test('folio editado sin guardar tambien cuenta', () {
      expect(
        hayDatosFinalesSinGuardar(
            observacionActual: 'ok', observacionGuardada: 'ok', folioActual: '00904', folioGuardado: ''),
        isTrue,
      );
    });

    test('lo ya guardado o un campo vacio no encola nada', () {
      expect(
        hayDatosFinalesSinGuardar(
            observacionActual: 'ok', observacionGuardada: 'ok', folioActual: '', folioGuardado: ''),
        isFalse,
      );
      expect(
        hayDatosFinalesSinGuardar(
            observacionActual: '', observacionGuardada: 'ok', folioActual: '', folioGuardado: '1'),
        isFalse,
      );
    });
  });

  group('alturaHojaInferior', () {
    test('sin teclado es el 75 % del alto', () {
      expect(alturaHojaInferior(altoPantalla: 800, alturaTeclado: 0, paddingSuperior: 24), 600);
    });

    test('con teclado no pasa de lo que queda libre bajo la barra de estado', () {
      final h = alturaHojaInferior(altoPantalla: 800, alturaTeclado: 400, paddingSuperior: 24);
      expect(h, 376);
      expect(h + 400 + 24, lessThanOrEqualTo(800));
    });

    test('nunca es negativa y respeta la fraccion pedida', () {
      expect(alturaHojaInferior(altoPantalla: 100, alturaTeclado: 200, paddingSuperior: 24), 0);
      expect(alturaHojaInferior(altoPantalla: 1000, alturaTeclado: 0, paddingSuperior: 0, fraccion: 0.8), 800);
    });
  });

  group('cantidadConUnidad', () {
    test('sin decimales sobrantes y con plural', () {
      expect(cantidadConUnidad(-2.0, 'unidad'), '-2 unidades');
      expect(cantidadConUnidad(1.0, 'unidad'), '1 unidad');
      expect(cantidadConUnidad(2.5, 'litro'), '2,5 litros');
    });

    test('unidades desconocidas quedan tal cual', () {
      expect(cantidadConUnidad(3, 'kg'), '3 kg');
      expect(cantidadConUnidad(3, ''), '3');
    });
  });

  group('textoStockBodegaFurgon (hoja Cargar desde bodega)', () {
    test('las dos cantidades llevan su unidad, en plural cuando corresponde', () {
      // en la prueba decia "Bodega: 10 · Tu furgón: -3 unidad"
      expect(textoStockBodegaFurgon(10.0, -3.0, 'unidad'), 'Bodega: 10 unidades · Tu furgón: -3 unidades');
      expect(textoStockBodegaFurgon(1.0, 0.0, 'unidad'), 'Bodega: 1 unidad · Tu furgón: 0 unidades');
      expect(textoStockBodegaFurgon(2.5, 1.0, 'litro', detalle: true), 'En bodega: 2,5 litros · En tu furgón: 1 litro');
    });

    test('sin unidad conocida queda solo el numero', () {
      expect(textoStockBodegaFurgon(4.0, 2.0, ''), 'Bodega: 4 · Tu furgón: 2');
    });
  });
}
