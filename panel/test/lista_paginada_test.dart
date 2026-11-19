import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/widgets/lista_paginada.dart';

void main() {
  test('los parametros de pagina llevan el tamano y el desplazamiento como numeros', () {
    expect(ListaPaginada.parametrosPagina(0), 'limit=50&offset=0');
    expect(ListaPaginada.parametrosPagina(150), 'limit=50&offset=150');
  });
}
