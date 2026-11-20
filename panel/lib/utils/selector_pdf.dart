import 'package:file_picker/file_picker.dart';

/// Tope de un PDF que sube el panel (el backend rechaza sobre 10 MB; avisar antes evita subirlo entero).
const maxBytesPdf = 10 * 1024 * 1024;

/// Abre el selector del sistema y devuelve el PDF elegido ya leido en memoria, o null si la persona
/// cancela o el archivo no trae bytes.
Future<PlatformFile?> elegirPdf() async {
  final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
  final archivo = resultado?.files.single;
  if (archivo == null || archivo.bytes == null) return null;
  return archivo;
}
