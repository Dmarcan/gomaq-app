import 'package:flutter/material.dart';

/// Paleta del rediseño industrial oscuro (proyecto Stitch "GOMAQ Field Service App").
/// El naranja primario se conserva de los mockups originales del informe.
class GomaqColors {
  GomaqColors._();

  /// Naranja de marca: iconos, bordes y acentos sobre el fondo oscuro (4,84:1 sobre el fondo, pero
  /// 4,36:1 sobre las tarjetas). Para texto chico usar [textoNaranja].
  static const primario = Color(0xFFEA5B1F);

  /// Naranja para texto chico (enlaces, botones de texto): llega a 4,5:1 sobre el fondo, las tarjetas
  /// y la tarjeta amarilla de seccion pendiente.
  static const textoNaranja = Color(0xFFF47A3F);

  /// Fondo de los botones con texto blanco. Blanco sobre el naranja de marca da 3,49:1 y
  /// WCAG AA pide 4,5:1; sobre este da 5,18:1.
  static const accion = Color(0xFFC2410C);

  // Tema oscuro industrial
  static const fondoOscuro = Color(0xFF1A1D21);
  static const superficieTarjeta = Color(0xFF22262B);
  static const superficieElevada = Color(0xFF2A2F35);
  static const bordeSutil = Color(0xFF33383F);
  /// Borde de los campos de texto: el sutil daba 1,29:1 contra la tarjeta y WCAG pide 3:1 para el
  /// limite de un componente (con sol directo el campo casi no se distinguia).
  static const bordeCampo = Color(0xFF737A84);
  static const textoPrimario = Color(0xFFF5F5F5);
  static const textoSecundario = Color(0xFF9BA1A8);

  // La app se usa en terreno con sol directo: los colores de estado van mas
  // saturados que en el panel web para mantener contraste sobre fondo oscuro.
  static const estadoPositivo = Color(0xFF4CAF6E); // finalizada
  static const estadoAdvertencia = Color(0xFFF59E0B); // en progreso
  // mas claro que el del panel: sobre el fondo oscuro el rojo anterior daba 3,91:1 como texto
  static const estadoNegativo = Color(0xFFF07A6B); // error / fuera de servicio
  static const estadoNeutro = Color(0xFF9BA1A8); // asignada / pendiente

  static Color colorEstado(String estado) {
    switch (estado) {
      case 'operativa':
      case 'enviado':
      case 'finalizada':
      case 'convertida':
        return estadoPositivo;
      case 'pendiente':
      case 'asignada':
      case 'aceptada':
        return estadoNeutro;
      case 'en_mantencion':
      case 'en_camino':
      case 'en_terreno':
      case 'en_reparacion':
        return estadoAdvertencia;
      default:
        return estadoNegativo;
    }
  }

  static Color fondoChip(String estado) => colorEstado(estado).withValues(alpha: 0.15);

  static String etiquetaEstado(String estado) {
    switch (estado) {
      case 'operativa':
        return 'Operativa';
      case 'en_mantencion':
        return 'En mantención';
      case 'fuera_de_servicio':
        return 'Fuera de servicio';
      case 'pendiente':
        return 'Pendiente';
      case 'asignada':
        return 'Asignada';
      case 'aceptada':
        return 'Aceptada';
      case 'en_camino':
        return 'En camino';
      case 'en_terreno':
        return 'En terreno';
      case 'en_reparacion':
        return 'En reparación';
      case 'finalizada':
        return 'Finalizada';
      default:
        return estado.replaceAll('_', ' ');
    }
  }
}

/// Inter para el texto corrido (con cifras tabulares, para alinear horómetros y cantidades) y Barlow
/// para títulos. Los archivos van dentro de la app (assets/fonts): la app trabaja sin conexión.
TextTheme _textoGomaq(TextTheme base) {
  const tabulares = [FontFeature.tabularFigures()];
  TextStyle? titulo(TextStyle? s) => s?.copyWith(fontFamily: 'Barlow', fontWeight: FontWeight.w600, letterSpacing: 0.2);
  TextStyle? cuerpo(TextStyle? s) => s?.copyWith(fontFeatures: tabulares);
  final conInter = base.apply(fontFamily: 'Inter');
  return conInter.copyWith(
    displayLarge: titulo(conInter.displayLarge),
    displayMedium: titulo(conInter.displayMedium),
    displaySmall: titulo(conInter.displaySmall),
    headlineLarge: titulo(conInter.headlineLarge),
    headlineMedium: titulo(conInter.headlineMedium),
    headlineSmall: titulo(conInter.headlineSmall),
    titleLarge: titulo(conInter.titleLarge),
    bodyLarge: cuerpo(conInter.bodyLarge),
    bodyMedium: cuerpo(conInter.bodyMedium),
    bodySmall: cuerpo(conInter.bodySmall),
  );
}

ThemeData construirTemaGomaq() {
  final colorScheme = ColorScheme.fromSeed(
    seedColor: GomaqColors.primario,
    primary: GomaqColors.primario,
    brightness: Brightness.dark,
    surface: GomaqColors.fondoOscuro,
  ).copyWith(
    // chips y controles segmentados salían en el tono que Material deriva de la semilla; aquí van
    // en el marrón oscuro de la marca
    secondaryContainer: const Color(0xFF3D2318),
    onSecondaryContainer: const Color(0xFFFFE6D8),
    surfaceTint: Colors.transparent,
  );

  final base = ThemeData(
    useMaterial3: true,
    fontFamily: 'Inter',
    colorScheme: colorScheme,
    scaffoldBackgroundColor: GomaqColors.fondoOscuro,
    appBarTheme: const AppBarTheme(
      backgroundColor: GomaqColors.fondoOscuro,
      foregroundColor: GomaqColors.textoPrimario,
      elevation: 0,
      scrolledUnderElevation: 1,
      centerTitle: true,
      titleTextStyle: TextStyle(
        color: GomaqColors.textoPrimario,
        fontSize: 18,
        fontWeight: FontWeight.w600,
        fontFamily: 'Barlow',
        letterSpacing: 0.5,
      ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: GomaqColors.superficieTarjeta,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: GomaqColors.bordeSutil),
      ),
      margin: const EdgeInsets.symmetric(vertical: 6),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: GomaqColors.accion,
        // 48 dp de alto como minimo: la app se usa en terreno, muchas veces con guantes
        minimumSize: const Size(64, 48),
        foregroundColor: Colors.white,
        disabledBackgroundColor: GomaqColors.superficieElevada,
        disabledForegroundColor: GomaqColors.textoSecundario,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        textStyle: const TextStyle(fontWeight: FontWeight.bold, letterSpacing: 0.5),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: GomaqColors.textoNaranja,
        minimumSize: const Size(64, 48),
        side: const BorderSide(color: GomaqColors.primario),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: GomaqColors.textoNaranja),
    ),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: GomaqColors.accion,
      foregroundColor: Colors.white,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: GomaqColors.superficieElevada,
      labelStyle: const TextStyle(color: GomaqColors.textoSecundario),
      hintStyle: const TextStyle(color: GomaqColors.textoSecundario),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: GomaqColors.bordeCampo),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: GomaqColors.bordeCampo),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: GomaqColors.primario, width: 2),
      ),
    ),
    chipTheme: ChipThemeData(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      side: BorderSide.none,
    ),
    dividerTheme: const DividerThemeData(color: GomaqColors.bordeSutil),
    listTileTheme: const ListTileThemeData(
      textColor: GomaqColors.textoPrimario,
      iconColor: GomaqColors.textoSecundario,
    ),
  );
  return base.copyWith(textTheme: _textoGomaq(base.textTheme));
}
