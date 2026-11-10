import 'package:flutter/material.dart';
import '../services/api_client.dart';

/// La G de GOMAQ en gris, para estados vacíos del portal del cliente.
const gGomaqGris = 'assets/g_gomaq_gris.png';

/// Pantalla o lista sin datos: qué es, por qué está vacía y cómo empezar.
///
/// Antes varias secciones (Asistencias, el catálogo de Insumos) quedaban completamente en
/// blanco cuando no había datos, y no se distinguía de una pantalla que no cargó.
class EstadoVacio extends StatelessWidget {
  /// Ícono del estado. Si se pasa [imagen] no se usa (uno de los dos es obligatorio).
  final IconData? icono;

  /// Imagen decorativa (asset) en lugar del ícono, p. ej. la G gris de GOMAQ ([gGomaqGris]).
  final String? imagen;
  final String titulo;
  final String mensaje;
  final String? textoAccion;
  final VoidCallback? onAccion;

  const EstadoVacio({
    super.key,
    this.icono,
    this.imagen,
    required this.titulo,
    required this.mensaje,
    this.textoAccion,
    this.onAccion,
  }) : assert(icono != null || imagen != null, 'EstadoVacio necesita un icono o una imagen');

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (imagen != null)
                Image.asset(imagen!, height: 56, excludeFromSemantics: true)
              else
                Icon(icono, size: 56, color: Colors.grey.shade500),
              const SizedBox(height: 16),
              Text(titulo,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text(mensaje, textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade700)),
              if (textoAccion != null && onAccion != null) ...[
                const SizedBox(height: 20),
                FilledButton(onPressed: onAccion, child: Text(textoAccion!)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Texto para mostrar cuando una carga falla. ClienteApi deja pasar sin envolver los errores de
/// red (SocketException, TimeoutException, ClientException): sin esto se leían como lista vacía.
String mensajeErrorCarga(Object error) =>
    error is ApiException ? error.message : 'Sin conexión. Revisa tu internet y vuelve a intentar.';

/// Estado de error de una carga, con botón Reintentar.
class EstadoError extends StatelessWidget {
  final String titulo;
  final String mensaje;
  final VoidCallback onReintentar;

  const EstadoError({super.key, required this.titulo, required this.mensaje, required this.onReintentar});

  @override
  Widget build(BuildContext context) {
    return EstadoVacio(
      icono: Icons.cloud_off,
      titulo: titulo,
      mensaje: mensaje,
      textoAccion: 'Reintentar',
      onAccion: onReintentar,
    );
  }
}

/// Deja un estado vacío o de error dentro de un [RefreshIndicator]: ocupa todo el alto y se
/// puede tirar hacia abajo para recargar.
class EstadoRefrescable extends StatelessWidget {
  final Future<void> Function() onRefresh;
  final Widget child;

  const EstadoRefrescable({super.key, required this.onRefresh, required this.child});

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: LayoutBuilder(
        builder: (context, c) => ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [SizedBox(height: c.maxHeight, child: child)],
        ),
      ),
    );
  }
}
