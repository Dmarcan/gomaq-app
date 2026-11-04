import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/formato.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';
import 'facturacion_screen.dart' show FacturaPendienteDialog;

/// Pestaña "Arriendos en curso" de Facturación (solo lectura) con las reglas de cobro.
///
/// Muestra los equipos despachados que aún no vuelven: desde cuándo se cobran, cuántos días
/// van y cuántos cortes de facturación llevan sin facturar. El gerente puede editar las reglas
/// (día de facturación, hora de corte del despacho y si el día de la recepción cuenta); el
/// administrativo solo las ve. Cambiar la hora de corte afecta a los despachos nuevos.
class ArriendosEnCursoTab extends StatefulWidget {
  const ArriendosEnCursoTab({super.key});

  @override
  State<ArriendosEnCursoTab> createState() => _ArriendosEnCursoTabState();
}

class _ArriendosEnCursoTabState extends State<ArriendosEnCursoTab> {
  List<dynamic> _arriendos = [];
  Map<String, dynamic> _config = {};
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final resultados = await Future.wait([
        ApiClient.instance.get('/api/facturacion/arriendos-en-curso'),
        ApiClient.instance.get('/api/facturacion/configuracion'),
      ]);
      if (!mounted) return;
      setState(() {
        _arriendos = resultados[0]['arriendos'] ?? [];
        _config = Map<String, dynamic>.from(resultados[1] as Map);
      });
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _editarConfiguracion() async {
    var dia = (_config['dia_facturacion'] as num?)?.toInt() ?? 5;
    var hora = (_config['hora_corte_despacho'] as num?)?.toInt() ?? 13;
    var incluir = _config['incluir_dia_recepcion'] != false;
    var cierra = _config['corte_cierra_periodo'] != false;
    final guardado = await mostrarFormulario(
      context,
      icono: Icons.tune,
      titulo: 'Reglas de cobro',
      subtitulo: 'Cómo se cuentan los días de arriendo',
      textoAccion: 'Guardar',
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DropdownButtonFormField<int>(
            initialValue: dia,
            decoration: decoracionCampo('Día de facturación', ayuda: 'Día del mes en que cierra el período (1 a 28).'),
            items: [for (var d = 1; d <= 28; d++) DropdownMenuItem(value: d, child: Text('$d'))],
            onChanged: (v) => dia = v ?? dia,
          ),
          separadorCampos,
          DropdownButtonFormField<int>(
            initialValue: hora,
            decoration: decoracionCampo(
              'Hora de corte del despacho',
              ayuda: 'Un equipo despachado desde esta hora se cobra desde el día siguiente. Afecta solo a los despachos nuevos.',
            ),
            items: [for (var h = 0; h <= 23; h++) DropdownMenuItem(value: h, child: Text('${h.toString().padLeft(2, '0')}:00'))],
            onChanged: (v) => hora = v ?? hora,
          ),
          separadorCampos,
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('El día de la recepción cuenta'),
            subtitle: const Text('Si está apagado, el día en que vuelve el equipo no se cobra.'),
            value: incluir,
            onChanged: (v) => redibujar(() => incluir = v),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('El día de corte cierra el período'),
            subtitle: const Text('Si está apagado, cada período termina el día anterior al corte.'),
            value: cierra,
            onChanged: (v) => redibujar(() => cierra = v),
          ),
        ],
      ),
      alGuardar: () async {
        // solo lo que cambió: así no se pisa quién y cuándo tocó las demás reglas
        final cambios = <String, dynamic>{
          if (dia != _config['dia_facturacion']) 'dia_facturacion': dia,
          if (hora != _config['hora_corte_despacho']) 'hora_corte_despacho': hora,
          if (incluir != (_config['incluir_dia_recepcion'] != false)) 'incluir_dia_recepcion': incluir,
          if (cierra != (_config['corte_cierra_periodo'] != false)) 'corte_cierra_periodo': cierra,
        };
        if (cambios.isEmpty) return;
        await ApiClient.instance.put('/api/facturacion/configuracion', cambios);
      },
    );
    if (guardado) _cargar();
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return EstadoError(titulo: 'No se pudieron cargar los arriendos en curso', mensaje: _error!, onReintentar: _cargar);
    }
    final esGerente = context.watch<AuthService>().esGerente;
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _tarjetaConfiguracion(esGerente),
          const SizedBox(height: 8),
          if (_arriendos.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 48),
              child: Center(child: Text('No hay equipos arrendados en este momento')),
            )
          else
            for (final a in _arriendos) _tarjetaArriendo(a as Map<String, dynamic>),
        ],
      ),
    );
  }

  Widget _tarjetaConfiguracion(bool esGerente) {
    final dia = _config['dia_facturacion'] ?? 5;
    final hora = ((_config['hora_corte_despacho'] as num?)?.toInt() ?? 13).toString().padLeft(2, '0');
    final incluye = _config['incluir_dia_recepcion'] != false ? 'sí' : 'no';
    final cierra = _config['corte_cierra_periodo'] != false ? 'sí' : 'no';
    final quien = _config['actualizado_por'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.tune, color: GomaqColors.primario),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Reglas de cobro', style: TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Text('Día de facturación: $dia · Corte del despacho: $hora:00 · El día de la recepción cuenta: $incluye · El corte cierra el período: $cierra'),
                  if (quien != null)
                    Text(
                      'Cambiado por $quien el ${Formato.fecha(_config['actualizado_at'])}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ),
            if (esGerente) TextButton(onPressed: _editarConfiguracion, child: const Text('Editar')),
          ],
        ),
      ),
    );
  }

  Future<void> _facturarPeriodo(Map<String, dynamic> a) async {
    await showDialog(
      context: context,
      builder: (_) => FacturaPendienteDialog(item: {
        'tipo': 'arriendo',
        'id': a['guia_despacho_id'],
        'guia_despacho_id': a['guia_despacho_id'],
        'titulo': '${a['maquinaria_codigo']} · Arriendo',
        'cliente_nombre': a['cliente_nombre'],
      }),
    );
    _cargar();
  }

  Widget _tarjetaArriendo(Map<String, dynamic> a) {
    final periodos = (a['periodos_sin_facturar'] as num?)?.toInt() ?? 0;
    final aviso = a['aviso'] == true;
    final proximo = a['proximo_corte'];
    final puedeFacturar = context.watch<AuthService>().esAdministrativo && (a['opciones_hasta'] as List?)?.isNotEmpty == true;
    return Card(
      child: ListTile(
        leading: Icon(Icons.local_shipping, color: aviso ? GomaqColors.estadoAdvertencia : GomaqColors.primario),
        title: Text('${a['maquinaria_codigo']} · ${a['cliente_nombre'] ?? 'Sin cliente'}'),
        // el aviso va bajo el texto y no al costado: a 375 px un chip al lado deja el texto en una columna
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Desde ${Formato.fecha(a['desde'])} · ${a['dias']} día(s)'
              '${proximo != null ? ' · Próximo corte ${Formato.fecha(proximo)}' : ''}',
            ),
            if (aviso) ...[
              const SizedBox(height: 6),
              Chip(
                visualDensity: VisualDensity.compact,
                label: Text(periodos == 1 ? '1 período sin facturar' : '$periodos períodos sin facturar'),
              ),
            ],
            if (puedeFacturar)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: () => _facturarPeriodo(a),
                  icon: const Icon(Icons.receipt_long, size: 18),
                  label: const Text('Facturar período'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
