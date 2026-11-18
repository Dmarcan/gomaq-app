import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import '../utils/numeros.dart';

/// Piezas compartidas de los cuadros que se abren sobre el panel (crear, editar, confirmar). Si
/// falta un campo obligatorio el cuadro sigue abierto y dice que falta: nunca se cierra sin avisar.
///
///  - [CuadroDialogo]: el marco (encabezado con ícono, cuerpo que se desplaza, pie con acciones).
///  - [DialogoFormulario] / [mostrarFormulario]: un formulario dentro de ese marco, con
///    validación, envío al servidor dentro del mismo cuadro y errores del servidor a la vista.
///  - [mostrarConfirmacion]: la pregunta de sí o no, con la variante de acción destructiva.
///  - [decoracionCampo], validadores, [LineaInfo] y [TituloSeccion]: lo que va adentro.

const separadorCampos = SizedBox(height: 14);

/// El marco visual de un cuadro: encabezado con ícono, cuerpo con scroll y pie de acciones.
class CuadroDialogo extends StatelessWidget {
  final IconData icono;
  final String titulo;
  final String? subtitulo;
  final Widget cuerpo;

  /// Botones del pie, de izquierda a derecha. Vacío = sin pie.
  final List<Widget> acciones;
  final double ancho;

  /// Si se puede cerrar con la X del encabezado (se apaga mientras se guarda).
  final bool cerrable;

  /// Qué hace la X del encabezado. Por defecto cierra el cuadro sin más.
  final VoidCallback? alCerrar;

  const CuadroDialogo({
    super.key,
    required this.icono,
    required this.titulo,
    this.subtitulo,
    required this.cuerpo,
    this.acciones = const [],
    this.ancho = 480,
    this.cerrable = true,
    this.alCerrar,
  });

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.white,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      clipBehavior: Clip.antiAlias,
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
      child: Semantics(
        scopesRoute: true,
        namesRoute: true,
        explicitChildNodes: true,
        label: titulo,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: ancho),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _cabecera(context),
              const Divider(height: 1),
              Flexible(child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(20, 18, 20, 20), child: cuerpo)),
              if (acciones.isNotEmpty)
                Container(
                  color: GomaqColors.fondoCalido,
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                  // Wrap y no Row: en un telefono (375 px) dos botones con texto largo no caben en
                  // una fila y el segundo baja a la linea siguiente
                  child: Wrap(
                    alignment: WrapAlignment.end,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    runSpacing: 8,
                    children: acciones,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _cabecera(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 8, 14),
      child: Row(
        children: [
          ExcludeSemantics(
            child: Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: GomaqColors.primario.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icono, color: GomaqColors.accion, size: 22),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(header: true, child: Text(titulo, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                if (subtitulo != null) Text(subtitulo!, style: const TextStyle(fontSize: 13, color: Colors.black54)),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close),
            tooltip: 'Cerrar',
            onPressed: cerrable ? (alCerrar ?? () => Navigator.of(context).pop()) : null,
          ),
        ],
      ),
    );
  }
}

/// Formulario dentro de un [CuadroDialogo].
///
/// Al pulsar el botón principal: valida los campos (si falta alguno, muestra el aviso en su
/// lugar y NO cierra), llama a [alGuardar] con el botón en estado de carga y, si el servidor
/// rechaza el envío, deja el mensaje dentro del cuadro con lo escrito intacto. Solo se cierra
/// cuando se guardó. Ctrl+Enter también guarda.
class DialogoFormulario extends StatefulWidget {
  final IconData icono;
  final String titulo;
  final String? subtitulo;
  final String textoAccion;
  final double ancho;

  /// Los campos. Recibe un `StateSetter` para redibujar el formulario cuando un campo cambia
  /// lo que otro muestra (una categoría que decide qué campos aparecen).
  final Widget Function(BuildContext context, StateSetter redibujar) contenido;

  /// Se llama con los campos ya validados. Lanzar [ApiException] deja el mensaje en el cuadro.
  final Future<void> Function() alGuardar;

  /// Si se da y devuelve `false`, el botón de guardar queda deshabilitado (el formulario debe decir el
  /// motivo en un texto visible). Se evalúa en cada redibujo del cuadro.
  final bool Function()? puedeGuardar;

  const DialogoFormulario({
    super.key,
    required this.icono,
    required this.titulo,
    this.subtitulo,
    required this.textoAccion,
    required this.contenido,
    required this.alGuardar,
    this.puedeGuardar,
    this.ancho = 480,
  });

  @override
  State<DialogoFormulario> createState() => _DialogoFormularioState();
}

class _DialogoFormularioState extends State<DialogoFormulario> {
  final _formulario = GlobalKey<FormState>();
  bool _guardando = false;
  String? _error;

  Future<void> _guardar() async {
    if (_guardando) return;
    // los avisos de cada campo aparecen ahí mismo y el cuadro sigue abierto
    if (!(_formulario.currentState?.validate() ?? false)) return;
    setState(() {
      _guardando = true;
      _error = null;
    });
    try {
      await widget.alGuardar();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      // cualquier fallo, no solo ApiException: sin red el error es de socket o de timeout, y el
      // cuadro se quedaria en "Guardando..." sin poder cerrarse
      if (mounted) {
        setState(() {
          _error = e is ApiException ? e.message : 'Sin conexión. Revisa tu internet y vuelve a intentar.';
          _guardando = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // mientras se envía no se puede cerrar: el envío seguiría sin que nadie vea su resultado
      canPop: !_guardando,
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.enter, control: true): _guardar,
        },
        child: CuadroDialogo(
          icono: widget.icono,
          titulo: widget.titulo,
          subtitulo: widget.subtitulo,
          ancho: widget.ancho,
          cerrable: !_guardando,
          cuerpo: Form(
            key: _formulario,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error != null) ...[
                  _avisoError(_error!),
                  const SizedBox(height: 14),
                ],
                widget.contenido(context, setState),
              ],
            ),
          ),
          acciones: [
            TextButton(onPressed: _guardando ? null : () => Navigator.of(context).pop(), child: const Text('Cancelar')),
            FilledButton(
              onPressed: (_guardando || !(widget.puedeGuardar?.call() ?? true)) ? null : _guardar,
              child: _guardando
                  ? const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
                        SizedBox(width: 8),
                        Text('Guardando...'),
                      ],
                    )
                  : Text(widget.textoAccion),
            ),
          ],
        ),
      ),
    );
  }

  Widget _avisoError(String mensaje) {
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: GomaqColors.estadoNegativo.withValues(alpha: 0.08),
          border: Border.all(color: GomaqColors.estadoNegativo.withValues(alpha: 0.4)),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(padding: EdgeInsets.only(top: 1), child: Icon(Icons.error_outline, size: 18, color: GomaqColors.estadoNegativo)),
            const SizedBox(width: 8),
            Expanded(child: Text(mensaje, style: const TextStyle(color: GomaqColors.estadoNegativo, fontSize: 13))),
          ],
        ),
      ),
    );
  }
}

/// Abre un formulario y devuelve `true` si se guardó, `false` si se canceló.
///
/// No se cierra al tocar fuera: en un formulario, un clic distraído no debe botar lo escrito.
Future<bool> mostrarFormulario(
  BuildContext context, {
  required IconData icono,
  required String titulo,
  String? subtitulo,
  required String textoAccion,
  required Widget Function(BuildContext context, StateSetter redibujar) contenido,
  required Future<void> Function() alGuardar,
  bool Function()? puedeGuardar,
  double ancho = 480,
}) async {
  final guardado = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => DialogoFormulario(
      icono: icono,
      titulo: titulo,
      subtitulo: subtitulo,
      textoAccion: textoAccion,
      contenido: contenido,
      alGuardar: alGuardar,
      puedeGuardar: puedeGuardar,
      ancho: ancho,
    ),
  );
  return guardado == true;
}

/// Pregunta de sí o no. `peligro` pinta el botón como acción destructiva (rechazar, eliminar).
Future<bool> mostrarConfirmacion(
  BuildContext context, {
  required String titulo,
  required String mensaje,
  required String textoAccion,
  IconData icono = Icons.help_outline,
  bool peligro = false,
  String textoCancelar = 'Cancelar',
}) async {
  final confirmado = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => CuadroDialogo(
      icono: peligro ? Icons.warning_amber_rounded : icono,
      titulo: titulo,
      ancho: 420,
      cuerpo: Text(mensaje, style: const TextStyle(fontSize: 14, height: 1.4)),
      acciones: [
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(textoCancelar)),
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(true),
          style: peligro ? FilledButton.styleFrom(backgroundColor: GomaqColors.estadoNegativo) : null,
          child: Text(textoAccion),
        ),
      ],
    ),
  );
  return confirmado == true;
}

/// Aspecto común de los campos de un formulario. El asterisco de los obligatorios va en la
/// etiqueta, para que también lo lea un lector de pantalla.
InputDecoration decoracionCampo(
  String etiqueta, {
  bool obligatorio = false,
  String? ayuda,
  String? prefijo,
  String? sufijo,
  IconData? icono,
}) {
  return InputDecoration(
    labelText: obligatorio ? '$etiqueta *' : etiqueta,
    helperText: ayuda,
    helperMaxLines: 2,
    errorMaxLines: 2,
    prefixText: prefijo,
    suffixText: sufijo,
    prefixIcon: icono == null ? null : Icon(icono, size: 20),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
  );
}

/// Validador: el campo no puede quedar vacío.
String? Function(String?) obligatorio(String mensaje) => (v) => (v == null || v.trim().isEmpty) ? mensaje : null;

/// Validador: un número mayor que cero. `monto` lee pesos ("18.500"); si no, un número común.
String? Function(String?) numeroPositivo(String mensaje, {bool monto = false}) => (v) {
      final n = (monto ? parsearMonto : parsearNumero)(v ?? '');
      return (n == null || n <= 0) ? mensaje : null;
    };

/// Validador: puede quedar vacío, pero si se escribe algo tiene que ser un número (no negativo).
String? Function(String?) numeroOpcional(String mensaje, {bool monto = false}) => (v) {
      if (v == null || v.trim().isEmpty) return null;
      final n = (monto ? parsearMonto : parsearNumero)(v);
      return (n == null || n < 0) ? mensaje : null;
    };

/// Una línea gris con un dato que se ve pero no se edita (el cliente de un equipo, por ejemplo).
class LineaInfo extends StatelessWidget {
  final IconData? icono;
  final String texto;
  const LineaInfo({super.key, this.icono, required this.texto});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: Colors.grey.shade100, borderRadius: BorderRadius.circular(10)),
      child: Row(
        children: [
          if (icono != null) ...[
            ExcludeSemantics(child: Icon(icono, size: 18, color: Colors.black54)),
            const SizedBox(width: 8),
          ],
          Expanded(child: Text(texto, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }
}

/// Encabezado de una sección dentro de un formulario largo ("Ficha técnica").
class TituloSeccion extends StatelessWidget {
  final String texto;
  const TituloSeccion(this.texto, {super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 10),
      child: Semantics(header: true, child: Text(texto, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700))),
    );
  }
}
