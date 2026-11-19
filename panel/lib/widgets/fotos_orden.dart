import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import 'dialogos.dart';
import 'estado_vacio.dart';

/// Cuántas fotos se pueden adjuntar a un correo de factura (el mismo límite que aplica el servidor).
const maxFotosCorreo = 12;

/// Fotos de una orden de trabajo (antes y después): la vista previa de la factura (administrativo) y el
/// detalle de la orden en el portal del cliente (`paraCliente`, siempre con `cargador`: el cliente no
/// tiene acceso a /evidencia).
///
/// Con [seleccionable] (cuadro de la factura) cada foto lleva una casilla: las marcadas se adjuntan al
/// correo que recibe el cliente, junto al PDF. Arrancan marcadas las de [seleccionInicial] (la selección del
/// último correo de esa factura, para un reenvío) o, si no hay, todas hasta [maxFotosCorreo]. Cada cambio sale
/// por [alCambiarSeleccion], también la primera vez que cargan las fotos. El peso lo mide el servidor al
/// autorizar el envío: las fotos se reducen y, si no caben, él pide quitar algunas.
///
/// Las URLs vienen firmadas por una hora: si una vence mientras el cuadro sigue abierto, la miniatura
/// muestra un ícono en vez de romperse y el botón Recargar pide URLs nuevas (la selección se conserva).
class FotosOrden extends StatefulWidget {
  final Object ordenId;

  /// Cómo se piden las fotos; por defecto el servidor. Se puede reemplazar en las pruebas.
  final Future<List<dynamic>> Function()? cargador;
  /// En el portal del cliente: sin la nota del correo, que habla de lo que hace el administrativo.
  final bool paraCliente;

  /// Muestra una casilla por foto para elegir cuáles van adjuntas al correo.
  final bool seleccionable;
  final Set<int>? seleccionInicial;
  final ValueChanged<Set<int>>? alCambiarSeleccion;
  const FotosOrden({
    super.key,
    required this.ordenId,
    this.cargador,
    this.paraCliente = false,
    this.seleccionable = false,
    this.seleccionInicial,
    this.alCambiarSeleccion,
  });

  @override
  State<FotosOrden> createState() => _FotosOrdenState();
}

class _FotosOrdenState extends State<FotosOrden> {
  List<Map<String, dynamic>> _fotos = [];
  final Set<int> _elegidas = {};
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  int? _id(Map<String, dynamic> f) {
    final v = f['id'];
    return v is num ? v.toInt() : null;
  }

  /// Antes y después, en el orden en que se muestran (y en que se numeran en el correo).
  List<Map<String, dynamic>> get _enOrden => [
        for (final f in _fotos) if (f['tipo'] != 'despues') f,
        for (final f in _fotos) if (f['tipo'] == 'despues') f,
      ];

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = widget.cargador != null
          ? await widget.cargador!()
          : await ApiClient.instance.get('/api/ordenes-trabajo/${widget.ordenId}/evidencia') as List;
      if (!mounted) return;
      setState(() {
        _fotos = [for (final f in data) Map<String, dynamic>.from(f as Map)];
        if (widget.seleccionable) _ajustarSeleccion();
      });
      if (widget.seleccionable) widget.alCambiarSeleccion?.call(Set.of(_elegidas));
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  /// Primera carga: la selección del último correo o todas (hasta el máximo). Al recargar se conserva lo que
  /// la persona ya eligió, quitando lo que ya no existe.
  void _ajustarSeleccion() {
    final ids = [for (final f in _enOrden) if (_id(f) != null) _id(f)!];
    if (_elegidas.isNotEmpty) {
      _elegidas.removeWhere((id) => !ids.contains(id));
      return;
    }
    final previa = widget.seleccionInicial;
    if (previa != null && previa.any(ids.contains)) {
      _elegidas.addAll(previa.where(ids.contains).take(maxFotosCorreo));
    } else {
      _elegidas.addAll(ids.take(maxFotosCorreo));
    }
  }

  void _cambiar(int id, bool marcar) {
    if (marcar && _elegidas.length >= maxFotosCorreo) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('Se pueden adjuntar hasta $maxFotosCorreo fotos por correo.')),
      );
      return;
    }
    setState(() => marcar ? _elegidas.add(id) : _elegidas.remove(id));
    widget.alCambiarSeleccion?.call(Set.of(_elegidas));
  }

  void _todas() {
    setState(() {
      _elegidas
        ..clear()
        ..addAll([for (final f in _enOrden) if (_id(f) != null) _id(f)!].take(maxFotosCorreo));
    });
    widget.alCambiarSeleccion?.call(Set.of(_elegidas));
  }

  void _ninguna() {
    setState(_elegidas.clear);
    widget.alCambiarSeleccion?.call(Set.of(_elegidas));
  }

  void _ampliar(Map<String, dynamic> foto) {
    final url = foto['url'] as String?;
    if (url == null) return;
    showDialog<void>(
      context: context,
      builder: (_) => Dialog(
        child: InteractiveViewer(
          child: Image.network(
            url,
            fit: BoxFit.contain,
            errorBuilder: (_, _, _) => const Padding(
              padding: EdgeInsets.all(24),
              child: Text('La foto no se pudo cargar. Cierra y usa Recargar.'),
            ),
          ),
        ),
      ),
    );
  }

  Widget _miniatura(Map<String, dynamic> foto) {
    final url = foto['url'] as String?;
    final momento = foto['tipo'] == 'despues' ? 'después' : 'antes';
    return Semantics(
      button: url != null,
      label: url == null ? 'Foto $momento no disponible' : 'Ampliar foto $momento',
      excludeSemantics: true,
      child: InkWell(
      onTap: url == null ? null : () => _ampliar(foto),
      child: Container(
        width: 72,
        height: 72,
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey.shade300),
          borderRadius: BorderRadius.circular(8),
        ),
        clipBehavior: Clip.antiAlias,
        child: url == null
            ? const Icon(Icons.broken_image_outlined, color: GomaqColors.estadoNeutro)
            : Image.network(
                url,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const Tooltip(
                  message: 'La foto no se pudo cargar (el enlace puede haber vencido)',
                  child: Icon(Icons.broken_image_outlined, color: GomaqColors.estadoNeutro),
                ),
              ),
      ),
      ),
    );
  }

  /// Miniatura con su casilla "Enviar" debajo: un objetivo táctil de 44 px y un nombre que dice cuál foto es.
  Widget _conCasilla(Map<String, dynamic> foto, int posicion) {
    final id = _id(foto);
    final miniatura = _miniatura(foto);
    if (!widget.seleccionable || id == null) return miniatura;
    final momento = foto['tipo'] == 'despues' ? 'después' : 'antes';
    final marcada = _elegidas.contains(id);
    return SizedBox(
      width: 72,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          miniatura,
          Semantics(
            container: true,
            checked: marcada,
            label: 'Adjuntar al correo la foto $posicion de $momento',
            excludeSemantics: true,
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => _cambiar(id, !marcada),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    IgnorePointer(
                      child: SizedBox(
                        width: 24,
                        height: 24,
                        child: Checkbox(value: marcada, onChanged: (_) {}, materialTapTargetSize: MaterialTapTargetSize.shrinkWrap),
                      ),
                    ),
                    const SizedBox(width: 2),
                    // la etiqueta se achica antes de desbordar (fuente grande del sistema o de accesibilidad)
                    const Flexible(
                      child: FittedBox(fit: BoxFit.scaleDown, child: Text('Enviar', style: TextStyle(fontSize: 12))),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _grupo(String titulo, List<Map<String, dynamic>> fotos) {
    if (fotos.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(titulo, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [for (var i = 0; i < fotos.length; i++) _conCasilla(fotos[i], i + 1)],
          ),
        ],
      ),
    );
  }

  /// "3 de 5 fotos irán adjuntas al correo": se anuncia al lector de pantalla cuando cambia.
  Widget _resumenSeleccion() {
    final total = _fotos.where((f) => _id(f) != null).length;
    final n = _elegidas.length;
    final texto = n == 0
        ? 'No se adjuntará ninguna foto: el correo llevará solo la factura.'
        : '$n de $total ${total == 1 ? 'foto irá adjunta' : 'fotos irán adjuntas'} al correo, junto a la factura.';
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Semantics(
        liveRegion: true,
        child: Text(texto, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final antes = [for (final f in _fotos) if (f['tipo'] != 'despues') f];
    final despues = [for (final f in _fotos) if (f['tipo'] == 'despues') f];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: TituloSeccion(widget.paraCliente ? 'Fotos del trabajo' : 'Fotos de la orden')),
            if (!_cargando) TextButton.icon(onPressed: _cargar, icon: const Icon(Icons.refresh, size: 16), label: const Text('Recargar')),
          ],
        ),
        if (_cargando)
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator())
        else if (_error != null)
          Text('No se pudieron cargar las fotos: $_error', style: const TextStyle(color: GomaqColors.estadoNegativo))
        else if (_fotos.isEmpty)
          const Text('Esta orden no tiene fotos.')
        else ...[
          if (widget.seleccionable) ...[
            const Text('Elige las fotos que se envían al cliente junto a la factura. Se reducen de tamaño al enviar.',
                style: TextStyle(fontSize: 12, color: Colors.black54)),
            Wrap(
              spacing: 4,
              children: [
                TextButton(onPressed: _todas, child: const Text('Todas')),
                TextButton(onPressed: _elegidas.isEmpty ? null : _ninguna, child: const Text('Ninguna')),
              ],
            ),
          ],
          _grupo('Antes', antes),
          _grupo('Después', despues),
          if (widget.seleccionable) _resumenSeleccion(),
        ],
        if (!widget.paraCliente && !widget.seleccionable) ...[
          const SizedBox(height: 4),
          const Text('Las fotos no se adjuntan al correo.', style: TextStyle(fontSize: 12, color: Colors.black54)),
        ],
      ],
    );
  }
}
