import 'dart:math' as math;

/// Alto de una hoja inferior: la fraccion pedida del alto de la pantalla, pero nunca mas de lo que
/// queda libre una vez descontados el teclado y el espacio superior (barra de estado). Sin este
/// tope, con el teclado abierto la hoja se sale por arriba.
double alturaHojaInferior({
  required double altoPantalla,
  required double alturaTeclado,
  required double paddingSuperior,
  double fraccion = 0.75,
}) {
  final disponible = altoPantalla - alturaTeclado - paddingSuperior;
  return math.max(0, math.min(altoPantalla * fraccion, disponible));
}
