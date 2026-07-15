import 'package:flutter/material.dart';

/// Paleta extraida de los mockups del informe (pptx_unzip/ppt/media/image20.png, image36.png)
class GomaqColors {
  GomaqColors._();

  static const primario = Color(0xFFEA5B1F);
  static const sidebarOscuro = Color(0xFF1B1210);
  static const sidebarResaltado = Color(0xFF3D2318);
  static const fondoCalido = Color(0xFFFDF6F1);

  static const estadoPositivo = Color(0xFF2F8F4E); // operativa / enviado
  static const estadoAdvertencia = Color(0xFFC9820A); // en_mantencion / pendiente
  static const estadoNegativo = Color(0xFFB23A2E); // fuera_de_servicio / error

  static Color colorEstado(String estado) {
    switch (estado) {
      case 'operativa':
      case 'enviado':
      case 'finalizada':
      case 'convertida':
        return estadoPositivo;
      case 'en_mantencion':
      case 'pendiente':
      case 'asignada':
      case 'en_terreno':
      case 'en_reparacion':
        return estadoAdvertencia;
      default:
        return estadoNegativo;
    }
  }

  static Color fondoChip(String estado) => colorEstado(estado).withValues(alpha: 0.15);
}

ThemeData construirTemaGomaq() {
  final colorScheme = ColorScheme.fromSeed(
    seedColor: GomaqColors.primario,
    primary: GomaqColors.primario,
    brightness: Brightness.light,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: Colors.white,
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.white,
      foregroundColor: Colors.black87,
      elevation: 0,
      scrolledUnderElevation: 1,
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Colors.grey.shade200),
      ),
      margin: const EdgeInsets.symmetric(vertical: 6),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: GomaqColors.primario,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: GomaqColors.primario,
        side: const BorderSide(color: GomaqColors.primario),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      ),
    ),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: GomaqColors.primario,
      foregroundColor: Colors.white,
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: GomaqColors.primario, width: 2),
      ),
    ),
    chipTheme: ChipThemeData(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      side: BorderSide.none,
    ),
  );
}
