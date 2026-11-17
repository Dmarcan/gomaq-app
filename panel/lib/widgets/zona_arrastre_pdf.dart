import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

/// Resultado de revisar lo que el usuario soltó sobre la zona.
class ArchivoSoltado {
  const ArchivoSoltado.ok(this.archivo) : error = null;
  const ArchivoSoltado.error(this.error) : archivo = null;

  final PlatformFile? archivo;
  final String? error;
}

/// Convierte lo soltado en un [PlatformFile] (el mismo tipo que entrega
/// `FilePicker` con `withData: true`), para que siga el mismo camino que el clic.
/// Acepta un solo PDF.
Future<ArchivoSoltado> revisarArchivosSoltados(List<DropItem> archivos) async {
  if (archivos.isEmpty) return const ArchivoSoltado.error('No se recibió ningún archivo');
  if (archivos.length > 1) return const ArchivoSoltado.error('Suelta un solo PDF');
  final archivo = archivos.first;
  if (!archivo.name.toLowerCase().endsWith('.pdf')) {
    return const ArchivoSoltado.error('Solo se aceptan archivos PDF');
  }
  final bytes = await archivo.readAsBytes();
  return ArchivoSoltado.ok(PlatformFile(name: archivo.name, size: bytes.length, bytes: bytes));
}

/// Envuelve una zona de carga para que también reciba un PDF arrastrado desde el
/// explorador de archivos (web y escritorio). El clic y el teclado siguen siendo
/// del [builder]: el arrastre es una ayuda extra. En Android no hay arrastre y
/// el widget no cambia nada.
///
/// El [builder] recibe `arrastrando` para marcar la zona con algo más que color
/// (borde grueso y texto).
class ZonaArrastrePdf extends StatefulWidget {
  const ZonaArrastrePdf({
    super.key,
    required this.builder,
    required this.onArchivo,
    this.onError,
  });

  final Widget Function(BuildContext context, bool arrastrando) builder;

  /// Recibe el PDF soltado, igual que el resultado del selector de archivos.
  final Future<void> Function(PlatformFile archivo) onArchivo;

  /// Aviso cuando lo soltado no sirve. Por defecto, un SnackBar.
  final void Function(String mensaje)? onError;

  @override
  State<ZonaArrastrePdf> createState() => _ZonaArrastrePdfState();
}

class _ZonaArrastrePdfState extends State<ZonaArrastrePdf> {
  bool _arrastrando = false;

  void _fijar(bool valor) {
    if (mounted && _arrastrando != valor) setState(() => _arrastrando = valor);
  }

  Future<void> _soltado(List<DropItem> archivos) async {
    _fijar(false);
    final r = await revisarArchivosSoltados(archivos);
    if (!mounted) return;
    if (r.archivo == null) {
      final aviso = widget.onError;
      if (aviso != null) {
        aviso(r.error!);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r.error!)));
      }
      return;
    }
    await widget.onArchivo(r.archivo!);
  }

  @override
  Widget build(BuildContext context) {
    return DropTarget(
      onDragEntered: (_) => _fijar(true),
      onDragExited: (_) => _fijar(false),
      onDragDone: (d) => _soltado(d.files),
      child: widget.builder(context, _arrastrando),
    );
  }
}
