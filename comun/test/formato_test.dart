import 'package:gomaq_comun/gomaq_comun.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:test/test.dart';

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  group('fechas', () {
    // Se construyen en hora local porque Formato convierte a local antes de formatear.
    final f = DateTime(2026, 3, 5, 14, 30);

    test('fecha con ceros a la izquierda', () {
      expect(Formato.fecha(f), '05/03/2026');
    });

    test('fechaHora y diaMesHora', () {
      expect(Formato.fechaHora(f), '05/03/2026 14:30');
      expect(Formato.diaMesHora(f), '05/03 14:30');
    });

    test('acepta el String ISO de la API', () {
      final iso = f.toUtc().toIso8601String();
      expect(Formato.fechaHora(iso), '05/03/2026 14:30');
    });

    test('vacio, nulo o ilegible devuelve siVacio', () {
      expect(Formato.fecha(null), '-');
      expect(Formato.fecha('no es fecha'), '-');
      expect(Formato.fecha(null, siVacio: 'sin fecha'), 'sin fecha');
    });
  });

  group('clp', () {
    test('punto de miles y sin decimales', () {
      expect(Formato.clp(249900), r'$249.900');
      expect(Formato.clp(1234567), r'$1.234.567');
    });

    test('redondea y respeta el signo', () {
      expect(Formato.clp(1000.6), r'$1.001');
      expect(Formato.clp(-5000), r'-$5.000');
      expect(Formato.clp(0), r'$0');
    });

    test('nulo devuelve siVacio', () {
      expect(Formato.clp(null), '-');
    });
  });

  group('medida', () {
    test('acepta numero o texto NUMERIC de la API', () {
      expect(Formato.medida(2500, 'kg'), '2.500 kg');
      expect(Formato.medida('7.80', 'm'), '7,8 m');
    });

    test('sin dato o no numerico devuelve siVacio', () {
      expect(Formato.medida(null, 'm'), '');
      expect(Formato.medida('abc', 'm', siVacio: '-'), '-');
    });
  });
}
