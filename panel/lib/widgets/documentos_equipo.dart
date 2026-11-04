import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import '../utils/enlaces.dart';
import '../utils/formato.dart';
import 'estado_vacio.dart';

/// Documentos de un equipo: guías de despacho y recepción, órdenes de trabajo y facturas.
///
/// Lo que cada persona ve lo decide el servidor (`GET /api/maquinarias/:id/documentos`): un
/// cliente solo recibe los documentos de sus propios arriendos del equipo, aunque el equipo haya
/// pasado por otros clientes. Administrativo y gerente ven todo y, con [filtrarPorCliente], pueden
/// elegir un cliente (los documentos sin cliente aparecen como "Sin cliente").
class DocumentosEquipo extends StatefulWidget {
  final int maquinariaId;
  final bool filtrarPorCliente;
  const DocumentosEquipo({super.key, required this.maquinariaId, this.filtrarPorCliente = false});

  @override
  State<DocumentosEquipo> createState() => _DocumentosEquipoState();
}

class _DocumentosEquipoState extends State<DocumentosEquipo> {
  static const _sinCliente = -1;

  List<Map<String, dynamic>> _documentos = [];
  // el texto de cada fila se arma una vez al cargar, no en cada redibujo
  final Map<Map<String, dynamic>, String> _detalles = Map.identity();
  DateTime? _cargadoEn;
  bool _cargando = true;
  String? _error;
  int? _filtroCliente; // null = todos, _sinCliente = documentos sin cliente

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/maquinarias/${widget.maquinariaId}/documentos');
      if (!mounted) return;
      _fijarDocumentos([for (final d in (data['documentos'] as List)) Map<String, dynamic>.from(d as Map)]);
    } on ApiException catch (e) {
      if (!mounted) return;
      // 404 para el cliente es "no tienes documentos de este equipo": una lista vacía, no un error
      if (e.statusCode == 404) {
        _fijarDocumentos([]);
      } else {
        setState(() => _error = e.message);
      }
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  void _fijarDocumentos(List<Map<String, dynamic>> documentos) {
    _detalles.clear();
    setState(() {
      _documentos = documentos;
      _cargadoEn = DateTime.now();
      for (final d in documentos) {
        _detalles[d] = _detalle(d);
      }
    });
  }

  /// Los enlaces firmados duran 1 hora: si la pantalla lleva abierta casi todo ese tiempo, se
  /// vuelven a pedir en vez de abrir uno vencido (que mostraría un error del almacenamiento).
  Future<void> _abrir(Map<String, dynamic> d) async {
    final carga = _cargadoEn;
    if (carga != null && DateTime.now().difference(carga) > const Duration(minutes: 50)) {
      await _cargar();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Los enlaces se actualizaron. Vuelve a tocar el documento.')));
      }
      return;
    }
    await abrirEnlace('${d['url']}');
  }

  static const _titulos = {
    'guia_despacho': 'Guía de despacho',
    'guia_recepcion': 'Guía de recepción',
    'orden_trabajo': 'Orden de trabajo',
    'factura': 'Factura',
  };

  static const _iconos = {
    'guia_despacho': Icons.local_shipping_outlined,
    'guia_recepcion': Icons.assignment_return_outlined,
    'orden_trabajo': Icons.build_outlined,
    'factura': Icons.receipt_long_outlined,
  };

  String _titulo(Map<String, dynamic> d) {
    final base = _titulos[d['tipo']] ?? 'Documento';
    return switch (d['tipo']) {
      'orden_trabajo' => '$base #${d['id']}',
      'factura' => d['folio'] == null ? base : '$base ${d['folio']}',
      _ => base,
    };
  }

  String _detalle(Map<String, dynamic> d) {
    final partes = <String>[Formato.fecha(d['fecha'])];
    if (d['tipo'] == 'factura' && d['periodo_desde'] != null && d['periodo_hasta'] != null) {
      partes.add('Período ${Formato.fecha(d['periodo_desde'])} al ${Formato.fecha(d['periodo_hasta'])}');
    }
    if (d['tipo'] == 'orden_trabajo') {
      if (d['estado'] != null) partes.add('${d['estado']}'.replaceAll('_', ' '));
      if (d['motivo'] != null && '${d['motivo']}'.trim().isNotEmpty) partes.add('${d['motivo']}');
    }
    if (d['fallido'] == true) partes.add('Intento fallido');
    if (d['sin_documento'] == true) partes.add('Sin documento adjunto');
    if (widget.filtrarPorCliente) partes.add(d['cliente_nombre'] == null ? 'Sin cliente' : '${d['cliente_nombre']}');
    return partes.join(' · ');
  }

  List<Map<String, dynamic>> get _visibles {
    final filtro = _filtroCliente;
    if (filtro == null) return _documentos;
    return [
      for (final d in _documentos)
        if (filtro == _sinCliente ? d['cliente_id'] == null : d['cliente_id'] == filtro) d,
    ];
  }

  Widget _filtro() {
    final clientes = <int, String>{};
    var haySinCliente = false;
    for (final d in _documentos) {
      final id = d['cliente_id'];
      if (id == null) {
        haySinCliente = true;
      } else {
        clientes[id as int] = '${d['cliente_nombre'] ?? 'Cliente $id'}';
      }
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DropdownButtonFormField<int?>(
        initialValue: _filtroCliente,
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'Cliente', isDense: true),
        items: [
          const DropdownMenuItem<int?>(value: null, child: Text('Todos los clientes')),
          for (final e in clientes.entries) DropdownMenuItem<int?>(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis)),
          if (haySinCliente) const DropdownMenuItem<int?>(value: _sinCliente, child: Text('Sin cliente')),
        ],
        onChanged: (v) => setState(() => _filtroCliente = v),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()));
    if (_error != null) {
      return EstadoError(titulo: 'No se pudieron cargar los documentos', mensaje: _error!, onReintentar: _cargar);
    }
    final visibles = _visibles;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.filtrarPorCliente && _documentos.isNotEmpty) _filtro(),
        if (visibles.isEmpty)
          const Padding(padding: EdgeInsets.symmetric(vertical: 32), child: Center(child: Text('No hay documentos de este equipo')))
        else
          for (final d in visibles)
            Card(
              child: ListTile(
                leading: Icon(_iconos[d['tipo']] ?? Icons.description_outlined, color: GomaqColors.primario),
                title: Text(_titulo(d)),
                subtitle: Text(_detalles[d] ?? ''),
                isThreeLine: (_detalles[d] ?? '').length > 60,
                trailing: d['url'] == null
                    ? null
                    : IconButton(
                        tooltip: 'Abrir el documento',
                        icon: const Icon(Icons.open_in_new),
                        onPressed: () => _abrir(d),
                      ),
              ),
            ),
      ],
    );
  }
}
