import 'dart:async';
import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

/// Costo real por equipo (entrevista el jefe de taller, punto 1).
///
/// Responde textualmente lo que él pidió: "no sabemos si en los tres meses que estuvo la
/// máquina se gastó más plata de la que dejaba el arriendo". Los equipos que salen a pérdida
/// aparecen primero, porque son los que hay que decidir.
class RentabilidadScreen extends StatefulWidget {
  const RentabilidadScreen({super.key});

  @override
  State<RentabilidadScreen> createState() => _RentabilidadScreenState();
}

class _RentabilidadScreenState extends State<RentabilidadScreen> {
  List<dynamic> _equipos = [];
  bool _cargando = true;
  String? _error;
  int _meses = 12;
  // la tabla armaba 500 filas de una vez: ahora llegan de a tramos desde el servidor
  static const _porPagina = 50;
  int _total = 0;
  bool _hayMas = false;
  bool _cargandoMas = false;
  String _busqueda = '';
  Map<String, dynamic> _resumen = const {};
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  String _consulta({required int offset}) {
    final hasta = DateTime.now();
    final desde = DateTime(hasta.year, hasta.month - _meses, hasta.day);
    final p = <String>[
      'desde=${desde.toIso8601String()}',
      'hasta=${hasta.toIso8601String()}',
      'limit=$_porPagina',
      'offset=$offset',
    ];
    if (_busqueda.trim().isNotEmpty) p.add('q=${Uri.encodeQueryComponent(_busqueda.trim())}');
    return '/api/rentabilidad?${p.join('&')}';
  }

  void _buscar(String texto) {
    setState(() => _busqueda = texto);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _cargar);
  }

  Future<void> _cargarMas() async {
    if (_cargandoMas || !_hayMas) return;
    setState(() => _cargandoMas = true);
    try {
      final data = await ApiClient.instance.get(_consulta(offset: _equipos.length));
      if (!mounted) return;
      setState(() {
        _equipos = [..._equipos, ...data['items']];
        _hayMas = data['hay_mas'] == true;
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoMas = false);
    }
  }

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
      final data = await ApiClient.instance.get(_consulta(offset: 0));
      if (!mounted) return;
      setState(() {
        _equipos = data['items'] ?? [];
        _total = data['total'] ?? 0;
        _hayMas = data['hay_mas'] == true;
        _resumen = Map<String, dynamic>.from(data['resumen'] ?? {});
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  String _clp(num? valor) {
    if (valor == null) return '-';
    final entero = valor.round().abs().toString();
    final conPuntos = entero.replaceAllMapped(
      RegExp(r'(\d)(?=(\d{3})+$)'),
      (m) => '${m[1]}.',
    );
    return '${valor < 0 ? '-' : ''}\$$conPuntos';
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Error: $_error'),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _cargar, child: const Text('Reintentar')),
          ],
        ),
      );
    }

    // del servidor y sobre toda la flota: contar solo la pagina cargada enganaria
    final aPerdida = (_resumen['a_perdida'] ?? 0) as int;
    final sinPrecio = (_resumen['lineas_sin_precio'] ?? 0) as int;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Costo por equipo', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        Text(
          'Gasto en repuestos contra lo facturado. El gasto cuenta todas las líneas, se hayan cobrado o no.',
          style: TextStyle(fontSize: 13, color: Colors.grey[700]),
        ),
        const SizedBox(height: 12),
        TextField(
          onChanged: _buscar,
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.search),
            hintText: 'Buscar por código o tipo...',
            border: OutlineInputBorder(),
            isDense: true,
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            const Text('Período: ', style: TextStyle(fontSize: 13)),
            DropdownButton<int>(
              value: _meses,
              items: const [
                DropdownMenuItem(value: 3, child: Text('Últimos 3 meses')),
                DropdownMenuItem(value: 6, child: Text('Últimos 6 meses')),
                DropdownMenuItem(value: 12, child: Text('Últimos 12 meses')),
                DropdownMenuItem(value: 24, child: Text('Últimos 24 meses')),
              ],
              onChanged: (v) {
                if (v == null) return;
                setState(() => _meses = v);
                _cargar();
              },
            ),
            const SizedBox(width: 24),
            if (aPerdida > 0)
              Text('$aPerdida equipo${aPerdida == 1 ? '' : 's'} a pérdida',
                  style: const TextStyle(color: GomaqColors.estadoNegativo, fontWeight: FontWeight.bold)),
          ],
        ),
        if (sinPrecio > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              // sin esto, un equipo con repuestos sin precio parece barato cuando en realidad
              // es que nadie cargó los montos
              '$sinPrecio línea${sinPrecio == 1 ? '' : 's'} de repuesto sin precio: el gasto real es mayor al que se muestra.',
              style: const TextStyle(fontSize: 12, color: GomaqColors.estadoAdvertencia),
            ),
          ),
        const SizedBox(height: 12),
        Expanded(
          child: _equipos.isEmpty
              ? const Center(child: Text('Sin equipos registrados'))
              : SingleChildScrollView(
                  child: Column(
                    children: [
                      DataTable(
                    columns: const [
                      DataColumn(label: Text('Equipo')),
                      DataColumn(label: Text('Tipo')),
                      DataColumn(label: Text('Gasto'), numeric: true),
                      DataColumn(label: Text('Facturado'), numeric: true),
                      DataColumn(label: Text('Margen'), numeric: true),
                      DataColumn(label: Text('%'), numeric: true),
                    ],
                    rows: [
                      for (final e in _equipos)
                        DataRow(
                          color: e['sale_a_perdida'] == true
                              ? WidgetStatePropertyAll(GomaqColors.estadoNegativo.withValues(alpha: 0.08))
                              : null,
                          cells: [
                            DataCell(Text(e['codigo'] ?? '')),
                            DataCell(Text(e['tipo'] ?? '')),
                            DataCell(Text(_clp(e['gasto']))),
                            DataCell(Text(_clp(e['ingreso']))),
                            DataCell(Text(
                              _clp(e['margen']),
                              style: TextStyle(
                                fontWeight: FontWeight.bold,
                                color: e['sale_a_perdida'] == true ? GomaqColors.estadoNegativo : GomaqColors.estadoPositivo,
                              ),
                            )),
                            DataCell(Text(e['margen_porcentaje'] == null
                                ? '-'
                                : '${(e['margen_porcentaje'] as num).toStringAsFixed(0)}%')),
                          ],
                        ),
                    ],
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        child: Column(
                          children: [
                            Text('Mostrando ${_equipos.length} de $_total equipos',
                                style: const TextStyle(fontSize: 12, color: Colors.black54)),
                            if (_hayMas) ...[
                              const SizedBox(height: 8),
                              OutlinedButton(
                                onPressed: _cargandoMas ? null : _cargarMas,
                                child: Text(_cargandoMas ? 'Cargando...' : 'Cargar más'),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }
}
