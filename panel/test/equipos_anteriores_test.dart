import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/equipos_anteriores.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  group('soloEquiposAnteriores', () {
    test('deja solo los que ya no están con el cliente', () {
      final r = soloEquiposAnteriores([
        {'id': 1, 'codigo': 'A', 'actual': true},
        {'id': 2, 'codigo': 'B', 'actual': false},
        {'id': 3, 'codigo': 'C'},
      ]);
      expect(r.map((e) => e['id']), [2, 3]);
    });

    test('tolera una respuesta que no es una lista', () {
      expect(soloEquiposAnteriores(null), isEmpty);
      expect(soloEquiposAnteriores({'error': 'x'}), isEmpty);
    });
  });

  group('rangoDocumentos', () {
    test('muestra el período entre el primer y el último documento', () {
      expect(rangoDocumentos('2026-02-02T12:00:00.000Z', '2026-02-10T12:00:00.000Z'),
          'Documentos entre 02/02/2026 y 10/02/2026');
    });

    test('un solo día', () {
      expect(rangoDocumentos('2026-02-02T12:00:00.000Z', '2026-02-02T15:00:00.000Z'), 'Documentos del 02/02/2026');
    });

    test('sin fechas', () {
      expect(rangoDocumentos(null, null), 'Con documentos tuyos');
    });
  });
}
