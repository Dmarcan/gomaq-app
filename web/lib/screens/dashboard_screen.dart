import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

class DashboardScreen extends StatefulWidget {
  final void Function(int seccion) onNavegar;
  const DashboardScreen({super.key, required this.onNavegar});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  Map<String, dynamic>? _resumen;
  Map<String, dynamic>? _ventasPorEjecutivo;
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
    try {
      final data = await ApiClient.instance.get('/api/dashboard/resumen');
      final ventas = await ApiClient.instance.get('/api/dashboard/ventas-por-ejecutivo');
      if (!mounted) return;
      setState(() {
        _resumen = data;
        _ventasPorEjecutivo = ventas;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Widget _tarjetaNumero(String numero, String etiqueta, {Color? color}) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey.shade200),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(numero, style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold, color: color)),
            const SizedBox(height: 4),
            Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black54)),
          ],
        ),
      ),
    );
  }

  Widget _tarjetaAtajo(String numero, String etiqueta, VoidCallback onTap) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: GomaqColors.primario.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(numero, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: GomaqColors.primario)),
              const SizedBox(height: 4),
              Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black87)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _filaEjecutivo(String nombre, double monto, double porcentaje) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          SizedBox(width: 140, child: Text(nombre, style: const TextStyle(fontSize: 13))),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: porcentaje / 100,
                minHeight: 10,
                backgroundColor: Colors.grey.shade200,
                color: GomaqColors.primario,
              ),
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 110,
            child: Text(
              '\$${monto.toStringAsFixed(0)} (${porcentaje.toStringAsFixed(0)}%)',
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 12, color: Colors.black54),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text('Error: $_error'));

    final flota = _resumen!['flota'];
    final atajos = _resumen!['atajos'];

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text('Vista general de los ${flota['total']} equipos de GOMAQ', style: const TextStyle(color: Colors.black54)),
          const SizedBox(height: 20),

          const Text('DISPONIBILIDAD COMERCIAL', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          const SizedBox(height: 8),
          Row(
            children: [
              _tarjetaNumero('${flota['arrendados']}', 'Equipos arrendados'),
              const SizedBox(width: 16),
              _tarjetaNumero('${flota['disponibles']}', 'Equipos disponibles'),
            ],
          ),
          const SizedBox(height: 24),

          const Text('ESTADO OPERATIVO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          const SizedBox(height: 8),
          Row(
            children: [
              _tarjetaNumero('${flota['operativas']}', 'Operativa', color: GomaqColors.estadoPositivo),
              const SizedBox(width: 16),
              _tarjetaNumero('${flota['en_mantencion']}', 'En mantención', color: GomaqColors.estadoAdvertencia),
              const SizedBox(width: 16),
              _tarjetaNumero('${flota['fuera_de_servicio']}', 'Fuera de servicio', color: GomaqColors.estadoNegativo),
            ],
          ),
          const SizedBox(height: 24),

          const Text('ATAJOS', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
          const SizedBox(height: 8),
          Row(
            children: [
              _tarjetaAtajo('${atajos['pendientes_facturar']}', 'Equipos pendientes de facturar', () => widget.onNavegar(3)),
              const SizedBox(width: 16),
              _tarjetaAtajo('${atajos['solicitudes_pendientes']}', 'Solicitudes pendientes', () => widget.onNavegar(7)),
              const SizedBox(width: 16),
              _tarjetaAtajo('${atajos['notificaciones_error']}', 'Notificaciones en error', () => widget.onNavegar(8)),
            ],
          ),
          const SizedBox(height: 24),

          if (_ventasPorEjecutivo != null && (_ventasPorEjecutivo!['ejecutivos'] as List).isNotEmpty) ...[
            const Text('VENTAS POR EJECUTIVO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 0.5)),
            const SizedBox(height: 12),
            for (final fila in (_ventasPorEjecutivo!['ejecutivos'] as List))
              _filaEjecutivo(
                fila['ejecutivo_nombre'] as String,
                (fila['monto'] as num).toDouble(),
                (fila['porcentaje'] as num).toDouble(),
              ),
            const SizedBox(height: 24),
          ],

          Row(
            children: [
              FilledButton.icon(
                onPressed: () => widget.onNavegar(5),
                icon: const Icon(Icons.add),
                label: const Text('Crear Orden de Trabajo'),
              ),
              const SizedBox(width: 12),
              OutlinedButton.icon(
                onPressed: () => widget.onNavegar(1),
                icon: const Icon(Icons.arrow_forward),
                label: const Text('Ver Detalle de Equipos'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
