import 'package:flutter/material.dart';

/// Paleta extraida de los mockups del informe (pptx_unzip/ppt/media/image20.png, image36.png)
class GomaqColors {
  GomaqColors._();

  /// Naranja de marca: logo, iconos y acentos. NO para texto ni para el fondo de un botón con
  /// texto blanco: blanco sobre este naranja da 3,49:1 y WCAG AA pide 4,5:1.
  static const primario = Color(0xFFEA5B1F);

  /// Naranja de acción: botones, enlaces y todo lo que lleve texto. 5,18:1 con blanco.
  static const accion = Color(0xFFC2410C);

  static const sidebarOscuro = Color(0xFF1B1210);
  static const sidebarResaltado = Color(0xFF3D2318);
  static const fondoCalido = Color(0xFFFDF6F1);

  static const estadoPositivo = Color(0xFF2F8F4E); // operativa / finalizada
  static const estadoAdvertencia = Color(0xFFC9820A); // en curso / en mantención
  static const estadoNegativo = Color(0xFFB23A2E); // fuera de servicio / error
  static const estadoNeutro = Color(0xFF6B7075); // pendiente / asignada

  /// Ámbar oscuro para TEXTO e ICONOS de advertencia sobre fondo claro (5,93:1 sobre blanco y 5,3:1
  /// sobre las tarjetas). El ámbar `estadoAdvertencia` solo sirve para puntos y bordes: como icono
  /// daba 2,85:1 sobre las tarjetas y WCAG pide 3:1.
  static const advertenciaFuerte = Color(0xFF8A5A00);

  /// Gris para algo que perdió vigencia (por ejemplo la posición de un furgón de hace más de 15
  /// minutos). El gris 500 de Material daba 2,68:1 con blanco; este da 4,6:1.
  static const grisApagado = Color(0xFF757575);

  // Texto sobre el fondo tenue de cada estado. Los colores de arriba sirven para puntos, bordes
  // e iconos, pero como texto no llegaban al contraste mínimo (el ámbar daba 2,69:1).
  static const _textoPositivo = Color(0xFF1F6B38); // 5,44:1
  static const _textoAdvertencia = advertenciaFuerte; // 5,07:1
  static const _textoNegativo = Color(0xFFB23A2E); // 4,71:1
  static const _textoNeutro = Color(0xFF4A4F54);

  /// Mismo criterio que la app del mecánico, para que un estado tenga el mismo color en
  /// las dos: gris lo que aún no empieza, ámbar lo que está en curso.
  static Color colorEstado(String estado) {
    switch (estado) {
      case 'operativa':
      case 'enviado':
      case 'finalizada':
      case 'convertida':
      case 'aprobada':
        return estadoPositivo;
      case 'pendiente':
      case 'cancelado':
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

  static Color textoEstado(String estado) {
    final base = colorEstado(estado);
    if (base == estadoPositivo) return _textoPositivo;
    if (base == estadoAdvertencia) return _textoAdvertencia;
    if (base == estadoNeutro) return _textoNeutro;
    return _textoNegativo;
  }

  static Color fondoChip(String estado) => colorEstado(estado).withValues(alpha: 0.15);

  /// Nombre de un estado para mostrarlo. Antes el panel mostraba el valor de la base tal cual
  /// ("en_terreno", "operativa"), que no es para personas.
  static String etiquetaEstado(String? estado) {
    switch (estado) {
      case null:
        return '-';
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
      case 'convertida':
        return 'Orden creada';
      case 'enviado':
        return 'Enviado';
      case 'error':
        return 'Error';
      case 'aprobada':
        return 'Aprobada';
      case 'rechazada':
        return 'Rechazada';
      default:
        final texto = estado.replaceAll('_', ' ');
        return texto.isEmpty ? texto : texto[0].toUpperCase() + texto.substring(1);
    }
  }
}

/// Borde visible cuando el control tiene el foco del teclado. Sin esto, navegar con Tab solo
/// mostraba un sombreado gris casi invisible (WCAG 2.4.7).
WidgetStateProperty<BorderSide?> _bordeFoco(Color color, {BorderSide? normal}) =>
    WidgetStateProperty.resolveWith(
      (estados) => estados.contains(WidgetState.focused) ? BorderSide(color: color, width: 2.5) : normal,
    );

/// Inter para el texto corrido (con cifras tabulares, para que las columnas de montos y horómetros
/// queden alineadas) y Barlow para títulos. Los archivos van dentro de la app (assets/fonts).
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
    // el primario del esquema es el que usan los enlaces, pestañas y botones de texto: tiene
    // que ser el naranja de acción, que sí cumple contraste sobre blanco
    primary: GomaqColors.accion,
    brightness: Brightness.light,
  ).copyWith(
    // chips, botones segmentados y barras de navegación se tiñen con estos: sin esto salían en el
    // tono que Material deriva de la semilla, no en uno de la marca
    secondaryContainer: const Color(0xFFFFE6D8),
    onSecondaryContainer: const Color(0xFF3D1A0A),
    surfaceTint: Colors.transparent,
  );

  final base = ThemeData(
    useMaterial3: true,
    fontFamily: 'Inter',
    colorScheme: colorScheme,
    scaffoldBackgroundColor: Colors.white,
    focusColor: GomaqColors.accion.withValues(alpha: 0.18),
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
        backgroundColor: GomaqColors.accion,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      ).copyWith(side: _bordeFoco(Colors.black87)),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: GomaqColors.accion,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      ).copyWith(side: _bordeFoco(Colors.black87, normal: const BorderSide(color: GomaqColors.accion))),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: GomaqColors.accion)
          .copyWith(side: _bordeFoco(GomaqColors.accion)),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: ButtonStyle(side: _bordeFoco(GomaqColors.accion)),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: GomaqColors.accion,
      foregroundColor: Colors.white,
      focusColor: Colors.black.withValues(alpha: 0.25),
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
  return base.copyWith(textTheme: _textoGomaq(base.textTheme));
}
