import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../services/pendientes_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/bloque_pendientes.dart';
import '../../widgets/estado_vacio.dart';

class DashboardScreen extends StatefulWidget {
  /// Navega a una ruta del panel. El filtro viaja como query en la URL, asi que el
  /// estado "Flota filtrada por arrendados" tambien se puede compartir y sobrevive a un F5.
  final void Function(String ruta, {Map<String, String>? filtro}) onNavegar;
  const DashboardScreen({super.key, required this.onNavegar});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  Map<String, dynamic>? _resumen;
  Map<String, dynamic>? _ventasPorEjecutivo;
  List<dynamic> _otsPorMes = [];
  bool _cargando = true;
  String? _error;

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
    // los pendientes se piden aparte: si fallan, el bloque muestra su error y el resto del dashboard sigue
    PendientesService.instance.cargar(forzar: true);
    try {
      // las tres consultas son independientes: en paralelo, cargan en lo que tarda la más lenta
      final r = await Future.wait([
        ApiClient.instance.get('/api/dashboard/resumen'),
        ApiClient.instance.get('/api/dashboard/ventas-por-ejecutivo'),
        ApiClient.instance.get('/api/dashboard/ots-por-mes'),
      ]);
      if (!mounted) return;
      setState(() {
        _resumen = r[0];
        _ventasPorEjecutivo = r[1];
        _otsPorMes = r[2] as List;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      // dato inesperado o fallo de red: un mensaje entendible en vez de la excepción en crudo
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  // ---------- helpers ----------

  /// Postgres devuelve COUNT(*) como string via JSON ("5"): parseo defensivo.
  static int _entero(dynamic v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;

  static String _miles(num n) {
    final s = n.round().toString();
    final b = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) b.write('.');
      b.write(s[i]);
    }
    return b.toString();
  }

  static const _nombresMes = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  static String _etiquetaMes(String yyyyMm) {
    final partes = yyyyMm.split('-');
    final mes = int.tryParse(partes.length > 1 ? partes[1] : '') ?? 0;
    return (mes >= 1 && mes <= 12) ? _nombresMes[mes - 1] : yyyyMm;
  }

  Widget _tituloSeccion(String texto) {
    return Text(texto, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5));
  }

  Widget _panelGrafico({required String titulo, required Widget child, double alto = 240}) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        border: Border.all(color: Colors.grey.shade200),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _tituloSeccion(titulo),
          const SizedBox(height: 16),
          SizedBox(height: alto, child: child),
        ],
      ),
    );
  }

  Widget _tarjetaNumero(String numero, String etiqueta, {Color? color, Color? colorTexto, VoidCallback? onTap}) {
    final contenido = Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        border: Border.all(color: color != null ? color.withValues(alpha: 0.3) : Colors.grey.shade200),
        color: color?.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(numero, style: TextStyle(fontFamily: 'Barlow', fontSize: 26, fontWeight: FontWeight.bold, color: colorTexto ?? color)),
          const SizedBox(height: 4),
          Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black54)),
        ],
      ),
    );
    if (onTap == null) return Expanded(child: contenido);
    return Expanded(child: InkWell(onTap: onTap, borderRadius: BorderRadius.circular(12), child: contenido));
  }

  // ---------- grafico 1: dona de estado operativo ----------

  Widget _donaEstadoFlota(Map<String, dynamic> flota) {
    final datos = [
      ('operativa', 'Operativa', _entero(flota['operativas']), GomaqColors.estadoPositivo),
      ('en_mantencion', 'En mantención', _entero(flota['en_mantencion']), GomaqColors.estadoAdvertencia),
      ('fuera_de_servicio', 'Fuera de servicio', _entero(flota['fuera_de_servicio']), GomaqColors.estadoNegativo),
    ];
    final total = datos.fold<int>(0, (acc, d) => acc + d.$3);

    if (total == 0) {
      return const Center(child: Text('Sin equipos registrados', style: TextStyle(color: Colors.black54)));
    }

    return Row(
      children: [
        Expanded(
          // El radio sale del espacio disponible: con radios fijos (46 + 34) la dona medía 160 px
          // y en pantallas angostas se salía de su tarjeta.
          child: LayoutBuilder(
            builder: (context, restricciones) {
              final radioTotal = (restricciones.biggest.shortestSide / 2 - 4).clamp(30.0, 80.0);
              final hueco = radioTotal * 0.58;
              return Stack(
            alignment: Alignment.center,
            children: [
              PieChart(
                PieChartData(
                  sectionsSpace: 2,
                  centerSpaceRadius: hueco,
                  sections: [
                    for (final d in datos)
                      if (d.$3 > 0)
                        PieChartSectionData(
                          value: d.$3.toDouble(),
                          color: d.$4,
                          radius: radioTotal - hueco,
                          showTitle: false,
                        ),
                  ],
                ),
              ),
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('$total', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                  const Text('equipos', style: TextStyle(fontSize: 12, color: Colors.black54)),
                ],
              ),
            ],
          );
            },
          ),
        ),
        const SizedBox(width: 8),
        // leyenda navegable: mantiene la funcionalidad de las tarjetas anteriores
        Expanded(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final d in datos)
                InkWell(
                  onTap: () => widget.onNavegar('/flota', filtro: {'estado': d.$1}),
                  borderRadius: BorderRadius.circular(6),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 4),
                    child: Row(
                      children: [
                        Container(
                          width: 10,
                          height: 10,
                          decoration: BoxDecoration(color: d.$4, borderRadius: BorderRadius.circular(3)),
                        ),
                        const SizedBox(width: 8),
                        Expanded(child: Text(d.$2, style: const TextStyle(fontSize: 13))),
                        Text('${d.$3}', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  // ---------- grafico 2: linea de OTs por mes ----------

  Widget _lineaOtsPorMes() {
    if (_otsPorMes.isEmpty) {
      return const Center(child: Text('Sin datos de órdenes de trabajo', style: TextStyle(color: Colors.black54)));
    }
    final puntos = <FlSpot>[];
    var maximo = 0.0;
    for (var i = 0; i < _otsPorMes.length; i++) {
      final total = _entero(_otsPorMes[i]['total']).toDouble();
      puntos.add(FlSpot(i.toDouble(), total));
      if (total > maximo) maximo = total;
    }
    final techoY = maximo < 4 ? 4.0 : (maximo * 1.25).ceilToDouble();

    return LineChart(
      LineChartData(
        minY: 0,
        maxY: techoY,
        gridData: FlGridData(
          drawVerticalLine: false,
          getDrawingHorizontalLine: (_) => FlLine(color: Colors.grey.shade200, strokeWidth: 1),
        ),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 32,
              interval: (techoY / 4).ceilToDouble(),
              getTitlesWidget: (v, _) => Text(
                v.toInt().toString(),
                style: const TextStyle(fontSize: 11, color: Colors.black54),
              ),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 26,
              interval: 1,
              getTitlesWidget: (v, _) {
                final i = v.toInt();
                if (i < 0 || i >= _otsPorMes.length || v != i.toDouble()) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    _etiquetaMes(_otsPorMes[i]['mes'] as String),
                    style: const TextStyle(fontSize: 11, color: Colors.black54),
                  ),
                );
              },
            ),
          ),
        ),
        lineTouchData: LineTouchData(
          touchTooltipData: LineTouchTooltipData(
            getTooltipItems: (spots) => [
              for (final s in spots)
                LineTooltipItem(
                  '${_etiquetaMes(_otsPorMes[s.x.toInt()]['mes'] as String)}: ${s.y.toInt()} OT${s.y.toInt() == 1 ? '' : 's'}',
                  const TextStyle(color: Colors.white, fontSize: 12),
                ),
            ],
          ),
        ),
        lineBarsData: [
          LineChartBarData(
            spots: puntos,
            color: GomaqColors.primario,
            barWidth: 2,
            isCurved: false,
            dotData: FlDotData(
              getDotPainter: (_, _, _, _) => FlDotCirclePainter(
                radius: 4,
                color: GomaqColors.primario,
                strokeWidth: 2,
                strokeColor: Colors.white,
              ),
            ),
            belowBarData: BarAreaData(
              show: true,
              color: GomaqColors.primario.withValues(alpha: 0.08),
            ),
          ),
        ],
      ),
    );
  }

  // ---------- grafico 3: barras de ventas por ejecutivo ----------

  Widget _barrasVentas(List ejecutivos) {
    var maximo = 0.0;
    for (final e in ejecutivos) {
      final m = (e['monto'] as num).toDouble();
      if (m > maximo) maximo = m;
    }
    final techoY = maximo <= 0 ? 1.0 : maximo * 1.2;

    return BarChart(
      BarChartData(
        maxY: techoY,
        alignment: BarChartAlignment.spaceAround,
        gridData: FlGridData(
          drawVerticalLine: false,
          getDrawingHorizontalLine: (_) => FlLine(color: Colors.grey.shade200, strokeWidth: 1),
        ),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          leftTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 30,
              getTitlesWidget: (v, _) {
                final i = v.toInt();
                if (i < 0 || i >= ejecutivos.length) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    ejecutivos[i]['ejecutivo_nombre'] as String,
                    style: const TextStyle(fontSize: 11, color: Colors.black54),
                    overflow: TextOverflow.ellipsis,
                  ),
                );
              },
            ),
          ),
        ),
        barTouchData: BarTouchData(
          touchTooltipData: BarTouchTooltipData(
            getTooltipItem: (_, groupIndex, rod, _) {
              final fila = ejecutivos[groupIndex];
              return BarTooltipItem(
                '${fila['ejecutivo_nombre']}\n\$${_miles(rod.toY)} (${(fila['porcentaje'] as num).toStringAsFixed(0)}%)',
                const TextStyle(color: Colors.white, fontSize: 12),
              );
            },
          ),
        ),
        barGroups: [
          for (var i = 0; i < ejecutivos.length; i++)
            BarChartGroupData(
              x: i,
              barRods: [
                BarChartRodData(
                  toY: (ejecutivos[i]['monto'] as num).toDouble(),
                  color: GomaqColors.primario,
                  width: 26,
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(4)),
                ),
              ],
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null && _resumen == null) {
      // /resumen falló: los pendientes (otra consulta) se muestran igual, y el resto dice su error
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          BloquePendientes(compacto: MediaQuery.sizeOf(context).width < 600, onNavegar: widget.onNavegar, rol: context.read<AuthService>().rol),
          const SizedBox(height: 16),
          EstadoError(titulo: 'No se pudo cargar el dashboard', mensaje: _error!, onReintentar: _cargar),
        ],
      );
    }

    final flota = _resumen!['flota'];
    final ejecutivos = (_ventasPorEjecutivo?['ejecutivos'] as List?) ?? const [];
    final totalVentas = (_ventasPorEjecutivo?['total_general'] as num?) ?? 0;

    // En un teléfono (<600 px) los bloques que iban lado a lado se apilan: la leyenda de la dona
    // quedaba de ~40 px (el texto bajaba una letra por línea) y los 4 atajos se cortaban.
    final compacto = MediaQuery.sizeOf(context).width < 600;

    final panelDona = _panelGrafico(titulo: 'ESTADO OPERATIVO', child: _donaEstadoFlota(flota));
    final panelLinea = _panelGrafico(titulo: 'ÓRDENES DE TRABAJO POR MES', child: _lineaOtsPorMes());

    final botonNuevaOt = FilledButton.icon(
      onPressed: () => widget.onNavegar('/ordenes', filtro: {'nueva': '1'}),
      icon: const Icon(Icons.add),
      label: const Text('Nueva orden de trabajo'),
    );
    final resumen = Text('Vista general de los ${flota['total']} equipos de GOMAQ',
        style: const TextStyle(color: Colors.black54));

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: EdgeInsets.all(compacto ? 16 : 24),
        children: [
          // La acción principal va arriba: antes "Crear Orden de Trabajo" quedaba al final de la
          // página, fuera de la vista, y además solo llevaba a la lista sin abrir el formulario.
          if (compacto)
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [resumen, const SizedBox(height: 12), botonNuevaOt],
            )
          else
            Row(children: [Expanded(child: resumen), botonNuevaOt]),
          const SizedBox(height: 20),

          // Lo accionable va primero: los pendientes quedaban bajo los gráficos, a casi dos pantallas
          // de scroll en un teléfono.
          BloquePendientes(compacto: compacto, onNavegar: widget.onNavegar, rol: context.read<AuthService>().rol),
          const SizedBox(height: 24),

          _tituloSeccion('DISPONIBILIDAD COMERCIAL'),
          const SizedBox(height: 8),
          Row(
            children: [
              _tarjetaNumero(
                '${flota['arrendados']}',
                'Equipos arrendados',
                color: GomaqColors.estadoAdvertencia,
                // el ámbar y el verde de marca no llegan al contraste mínimo como texto
                colorTexto: GomaqColors.textoEstado('en_terreno'),
                onTap: () => widget.onNavegar('/flota', filtro: {'disponibilidad': 'arrendados'}),
              ),
              const SizedBox(width: 16),
              _tarjetaNumero(
                '${flota['disponibles']}',
                'Equipos disponibles',
                color: GomaqColors.estadoPositivo,
                colorTexto: GomaqColors.textoEstado('operativa'),
                onTap: () => widget.onNavegar('/flota', filtro: {'disponibilidad': 'disponibles'}),
              ),
            ],
          ),
          const SizedBox(height: 24),

          // estado operativo (dona con leyenda navegable) + OTs por mes, lado a lado
          if (compacto)
            Column(children: [panelDona, const SizedBox(height: 16), panelLinea])
          else
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: panelDona),
                const SizedBox(width: 16),
                Expanded(child: panelLinea),
              ],
            ),
          const SizedBox(height: 24),

          if (ejecutivos.isNotEmpty) ...[
            _panelGrafico(
              titulo: 'VENTAS POR EJECUTIVO — TOTAL \$${_miles(totalVentas)}',
              alto: 220,
              child: _barrasVentas(ejecutivos),
            ),
            const SizedBox(height: 24),
          ],

          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              onPressed: () => widget.onNavegar('/flota'),
              icon: const Icon(Icons.arrow_forward),
              label: const Text('Ver toda la flota'),
            ),
          ),
        ],
      ),
    );
  }
}
