import 'package:flutter/material.dart';

/// Logotipo de GOMAQ. Elige la version segun el fondo: sobre un tema oscuro "GO" va en blanco (con
/// el negro original no se veria) y sobre uno claro va el logo original. Hoy la app es siempre
/// oscura; esto deja resuelto el logo para cuando tenga modo claro.
class LogoGomaq extends StatelessWidget {
  final double ancho;
  const LogoGomaq({super.key, this.ancho = 240});

  @override
  Widget build(BuildContext context) {
    final oscuro = Theme.of(context).brightness == Brightness.dark;
    return Image.asset(
      oscuro ? 'assets/logo_gomaq_sobre_oscuro.png' : 'assets/logo_gomaq_sobre_claro.png',
      width: ancho,
      semanticLabel: 'GOMAQ',
    );
  }
}
