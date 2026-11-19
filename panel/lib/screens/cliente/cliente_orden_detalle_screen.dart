import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/formato.dart';
import '../../utils/seguimiento_cliente.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/fotos_orden.dart';

/// Detalle de una orden terminada para el cliente: equipo, motivo, diagnóstico, observación final,
/// línea de tiempo y fotos de antes y después. Sale de GET /api/ordenes-trabajo/mias/:id, que no
/// entrega montos, factura ni datos internos. Se abre desde el historial con Navigator (no con
/// go_router: el router devuelve al cliente a /portal si la ruta no es exactamente esa).
class ClienteOrdenDetalleScreen extends StatefulWidget {
  final int ordenId;

  /// Cómo se pide el detalle; por defecto el servidor. Se puede reemplazar en las pruebas.
  final Future<Map<String, dynamic>> Function()? cargador;
  const ClienteOrdenDetalleScreen({super.key, required this.ordenId, this.cargador});

  @override
  State<ClienteOrdenDetalleScreen> createState() => _ClienteOrdenDetalleScreenState();
}

class _ClienteOrdenDetalleScreenState extends State<ClienteOrdenDetalleScreen> {
  Map<String, dynamic>? _orden;
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<Map<String, dynamic>> _pedir() async {
    if (widget.cargador != null) return widget.cargador!();
    final data = await ApiClient.instance.get('/api/ordenes-trabajo/mias/${widget.ordenId}');
    return Map<String, dynamic>.from(data as Map);
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await _pedir();
      if (!mounted) return;
      setState(() => _orden = data);
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  /// "02/03/2026 10:42" en hora local, o null si no hay hora.
  String? _fechaHora(Object? valor) {
    if (valor is! String) return null;
    final hora = DateTime.tryParse(valor)?.toLocal();
    if (hora == null) return null;
    return '${Formato.fecha(valor)} ${horaCorta(hora)}';
  }

  Widget _texto(String titulo, String? valor) {
    if (valor == null || valor.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TituloSeccion(titulo),
          Text(valor),
        ],
      ),
    );
  }

  Widget _lineaDeTiempo(List<dynamic> pasos) {
    if (pasos.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const TituloSeccion('Línea de tiempo'),
          for (final p in pasos) _paso(Map<String, dynamic>.from(p as Map)),
        ],
      ),
    );
  }

  Widget _paso(Map<String, dynamic> paso) {
    final hora = _fechaHora(paso['ocurrio_en']);
    return Semantics(
      container: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const ExcludeSemantics(
              child: Padding(
                padding: EdgeInsets.only(right: 8, top: 1),
                child: Icon(Icons.check_circle, size: 18, color: GomaqColors.estadoPositivo),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${paso['texto']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  if (hora != null) Text(hora, style: const TextStyle(fontSize: 12.5, color: Colors.black87)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _contenido(Map<String, dynamic> o) {
    final cobro = etiquetaCobro(o['cobro'] as String?);
    final tecnico = o['mecanico_nombre'] as String?;
    final tipo = o['maquinaria_tipo'] as String?;
    final cierre = o['fecha_cierre'] ?? o['fecha_creacion'];
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        Semantics(
          header: true,
          child: Text(tituloOrden(o), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 4),
        if (tipo != null && tipo.isNotEmpty) Text(tipo),
        Text('Terminado el ${Formato.fecha(cierre)}${cobro != null ? ' · $cobro' : ''}'),
        if (explicacionCobro(o['cobro'] as String?) case final explicacion?) Text(explicacion),
        if (tecnico != null && tecnico.isNotEmpty) Text('Técnico: $tecnico'),
        const SizedBox(height: 12),
        _texto('Motivo', o['motivo'] as String?),
        _texto('Diagnóstico', o['diagnostico'] as String?),
        _texto('Observación final', o['observacion_final'] as String?),
        _lineaDeTiempo((o['linea_tiempo'] as List?) ?? const []),
        // el cliente no puede pedir /evidencia: las fotos ya vienen en este mismo detalle
        FotosOrden(
          ordenId: widget.ordenId,
          paraCliente: true,
          cargador: () async => (o['fotos'] as List?) ?? const [],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final Widget cuerpo;
    if (_cargando && _orden == null) {
      cuerpo = const Center(child: CircularProgressIndicator());
    } else if (_error != null) {
      cuerpo = EstadoRefrescable(
        onRefresh: _cargar,
        child: EstadoError(titulo: 'No se pudo cargar el detalle', mensaje: _error!, onReintentar: _cargar),
      );
    } else {
      cuerpo = RefreshIndicator(onRefresh: _cargar, child: _contenido(_orden!));
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Detalle de la orden')),
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 720), child: cuerpo),
        ),
      ),
    );
  }
}
