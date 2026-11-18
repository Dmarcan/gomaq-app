import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/formato.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';
import '../../utils/numeros.dart';

/// Dos pestanas: "Por medir" (la agenda del mes: equipos arrendados a los que todavia no se les
/// toma la lectura; al registrarla desaparecen de la lista) y "Mantencion" (equipos que ya
/// cumplieron el intervalo o estan a 50 h o menos).
class HorometroScreen extends StatefulWidget {
  /// Filtro que llega por la URL desde el dashboard: 'vencida' o 'proxima'. Abre la pestaña
  /// Mantención y deja solo esos equipos (el mismo criterio con que el dashboard cuenta).
  final String? filtroInicial;
  const HorometroScreen({super.key, this.filtroInicial});

  @override
  State<HorometroScreen> createState() => _HorometroScreenState();
}

class _HorometroScreenState extends State<HorometroScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<dynamic> _pendientes = [];
  List<dynamic> _alertas = [];
  int _horasAviso = 50;
  bool _cargando = true;
  String? _error;
  String? _filtro;

  /// Las alertas con el filtro del dashboard aplicado. Vencida = `vencida`; próxima = por vencer
  /// y aún no vencida (igual que contarAlertas del backend).
  List<dynamic> get _alertasVisibles => switch (_filtro) {
        'vencida' => _alertas.where((e) => e['vencida'] == true).toList(),
        'proxima' => _alertas.where((e) => e['por_vencer'] == true && e['vencida'] != true).toList(),
        _ => _alertas,
      };

  @override
  void initState() {
    super.initState();
    _filtro = (widget.filtroInicial == 'vencida' || widget.filtroInicial == 'proxima') ? widget.filtroInicial : null;
    _tabController = TabController(length: 2, vsync: this, initialIndex: _filtro != null ? 1 : 0);
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final pendientes = await ApiClient.instance.get('/api/horometro/pendientes');
      final alertas = await ApiClient.instance.get('/api/horometro/alertas');
      if (!mounted) return;
      setState(() {
        _pendientes = pendientes;
        _alertas = alertas['equipos'] ?? [];
        _horasAviso = alertas['horas_aviso'] ?? 50;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      // sin red o dato inesperado: un mensaje entendible y Reintentar, no una excepción suelta
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _registrarLectura(Map<String, dynamic> equipo) async {
    final resultado = await showDialog<bool>(
      context: context,
      // en un formulario, un clic fuera no debe botar lo escrito
      barrierDismissible: false,
      builder: (_) => _DialogoLectura(equipo: equipo),
    );
    if (resultado == true) _cargar();
  }

  Future<void> _verHistorial(int maquinariaId, String codigo) async {
    await showDialog<void>(
      context: context,
      builder: (_) => _DialogoHistorial(maquinariaId: maquinariaId, codigo: codigo),
    );
    if (mounted) _cargar();
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('No se pudo cargar el horómetro: $_error'),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _cargar, child: const Text('Reintentar')),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // el titulo lo pone el marco del panel (admin_dashboard_screen): repetirlo dejaria dos
        // encabezados uno encima del otro. Mismo margen de 24 px que el titulo del marco.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Text(
            'La mantención preventiva se calcula con las horas de uso desde la última mantención.',
            style: TextStyle(fontSize: 13, color: Colors.grey[700]),
          ),
        ),
        const SizedBox(height: 12),
        TabBar(
          controller: _tabController,
          labelColor: GomaqColors.accion,
          indicatorColor: GomaqColors.accion,
          tabs: [
            Tab(text: 'Por medir este mes (${_pendientes.length})'),
            Tab(text: 'Mantención (${_alertas.length})'),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [_construirPendientes(), _construirAlertas()],
          ),
        ),
      ],
    );
  }

  /// Fila de equipo con sus acciones. Con ancho de escritorio las acciones van a la derecha; en un
  /// telefono (<600 px) dejarian al titulo ~100 px (una palabra por linea), asi que pasan debajo.
  Widget _filaConAcciones(
    BuildContext context, {
    required Widget leading,
    required Widget title,
    required Widget subtitle,
    required List<Widget> acciones,
  }) {
    if (MediaQuery.sizeOf(context).width >= 600) {
      return ListTile(
        leading: leading,
        title: title,
        subtitle: subtitle,
        trailing: Wrap(spacing: 8, children: acciones),
      );
    }
    return Column(
      children: [
        ListTile(leading: leading, title: title, subtitle: subtitle),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
          child: Align(
            alignment: Alignment.centerRight,
            child: Wrap(spacing: 8, runSpacing: 8, children: acciones),
          ),
        ),
      ],
    );
  }

  Widget _construirPendientes() {
    if (_pendientes.isEmpty) {
      return const _Vacio(
        icono: Icons.check_circle_outline,
        titulo: 'No queda ningún equipo por medir este mes',
        detalle: 'Aparecen aquí los equipos arrendados sin lectura de horómetro en el mes en curso.',
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.only(top: 12),
      itemCount: _pendientes.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final e = _pendientes[i] as Map<String, dynamic>;
        final ultima = e['ultima_lectura'];
        return _filaConAcciones(
          context,
          leading: const Icon(Icons.timer_outlined),
          title: Text('${e['codigo']} — ${e['tipo']}'),
          subtitle: Text(
            '${e['cliente_nombre'] ?? 'Sin cliente'}'
            '${ultima == null ? ' · sin lecturas previas' : ' · última: $ultima h'}',
          ),
          acciones: [
            TextButton(
              onPressed: () => _verHistorial(e['id'], e['codigo']),
              child: const Text('Historial'),
            ),
            ElevatedButton(
              onPressed: () => _registrarLectura(e),
              child: const Text('Registrar'),
            ),
          ],
        );
      },
    );
  }

  Widget _construirAlertas() {
    final visibles = _alertasVisibles;
    if (visibles.isEmpty) {
      return Column(
        children: [
          if (_filtro != null) _chipFiltro(0),
          Expanded(
            child: _Vacio(
              icono: Icons.verified_outlined,
              titulo: _filtro == null ? 'Ningún equipo necesita mantención' : 'Ningún equipo con ese filtro',
              detalle: 'Aparecen aquí al quedar $_horasAviso h o menos para cumplir su intervalo.',
            ),
          ),
        ],
      );
    }
    return Column(
      children: [
        if (_filtro != null) _chipFiltro(visibles.length),
        Expanded(child: _listaAlertas(visibles)),
      ],
    );
  }

  Widget _chipFiltro(int cantidad) {
    final texto = _filtro == 'vencida' ? 'vencidas' : 'por vencer';
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 12, 24, 0),
      child: Row(
        children: [
          Expanded(child: Text('Mostrando solo las $texto ($cantidad)', style: const TextStyle(fontSize: 13))),
          TextButton(onPressed: () => context.go('/mantencion'), child: const Text('Ver todas')),
        ],
      ),
    );
  }

  Widget _listaAlertas(List<dynamic> visibles) {
    return ListView.separated(
      padding: const EdgeInsets.only(top: 12),
      itemCount: visibles.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final e = visibles[i] as Map<String, dynamic>;
        final vencida = e['vencida'] == true;
        final restantes = (e['horas_restantes'] as num?) ?? 0;
        return _filaConAcciones(
          context,
          leading: Icon(
            vencida ? Icons.error : Icons.warning_amber,
            color: vencida ? GomaqColors.estadoNegativo : GomaqColors.estadoAdvertencia,
          ),
          title: Text('${e['codigo']} — ${e['tipo']}'),
          subtitle: Text(
            vencida
                ? 'Vencida hace ${restantes.abs()} h de uso · lleva ${e['horas_usadas']} h de ${e['intervalo_mantencion_horas']}'
                : 'Faltan $restantes h · lleva ${e['horas_usadas']} h de ${e['intervalo_mantencion_horas']}',
            style: TextStyle(color: vencida ? GomaqColors.estadoNegativo : null),
          ),
          acciones: [
            TextButton(
              onPressed: () => _verHistorial(e['id'], e['codigo']),
              child: const Text('Historial'),
            ),
            OutlinedButton(
              onPressed: () => _marcarMantencion(e),
              child: const Text('Mantención hecha'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _marcarMantencion(Map<String, dynamic> equipo) async {
    final confirmado = await showDialog<bool>(
      context: context,
      // en un formulario, un clic fuera no debe botar lo escrito
      barrierDismissible: false,
      builder: (_) => _DialogoReiniciar(equipo: equipo),
    );
    if (confirmado == true) _cargar();
  }
}

class _DialogoLectura extends StatefulWidget {
  final Map<String, dynamic> equipo;
  const _DialogoLectura({required this.equipo});

  @override
  State<_DialogoLectura> createState() => _DialogoLecturaState();
}

class _DialogoLecturaState extends State<_DialogoLectura> {
  final _valorCtrl = TextEditingController();
  final _obsCtrl = TextEditingController();
  bool _reiniciar = false;

  @override
  void dispose() {
    _valorCtrl.dispose();
    _obsCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ultima = widget.equipo['ultima_lectura'];
    return DialogoFormulario(
      icono: Icons.timer,
      titulo: 'Horómetro de ${widget.equipo['codigo']}',
      subtitulo: ultima == null ? 'Todavía no tiene lecturas' : 'Última lectura: ${Formato.medida(ultima, 'h')}',
      textoAccion: 'Guardar lectura',
      ancho: 460,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextFormField(
            controller: _valorCtrl,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: decoracionCampo('Horas del horómetro', obligatorio: true, sufijo: 'h'),
            validator: (v) {
              final n = parsearNumero(v ?? '');
              return (n == null || n < 0) ? 'Escribe las horas que marca el horómetro.' : null;
            },
          ),
          separadorCampos,
          TextFormField(controller: _obsCtrl, decoration: decoracionCampo('Observación')),
          const SizedBox(height: 8),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _reiniciar,
            onChanged: (v) => redibujar(() => _reiniciar = v ?? false),
            title: const Text('Se hizo la mantención preventiva'),
            subtitle: const Text('Reinicia el contador: esta lectura pasa a ser la base del próximo intervalo.'),
          ),
        ],
      ),
      alGuardar: () async {
        final valor = parsearNumero(_valorCtrl.text);
        final anterior = num.tryParse('${widget.equipo['ultima_lectura'] ?? ''}');
        // un horómetro no baja, salvo que lo hayan cambiado: un error de tipeo (25 en vez de 250)
        // escondería una mantención, así que se pregunta antes de guardar
        if (valor != null && anterior != null && valor < anterior) {
          final seguir = await showDialog<bool>(
            context: context,
            builder: (dialogContext) => AlertDialog(
              title: const Text('La lectura es menor'),
              content: Text('Es menor que la última registrada (${Formato.medida(anterior, 'h')}). ¿Guardarla de todos modos?'),
              actions: [
                TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Revisar')),
                FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Guardar igual')),
              ],
            ),
          );
          if (seguir != true) throw ApiException(0, 'Revisa la lectura: es menor que la última registrada.');
        }
        await ApiClient.instance.post('/api/horometro/maquinaria/${widget.equipo['id']}', {
          'valor': valor,
          'observacion': _obsCtrl.text.trim().isEmpty ? null : _obsCtrl.text.trim(),
          'reiniciar_contador': _reiniciar,
        });
      },
    );
  }
}

/// Marcar una mantención como hecha sin pasar por una OT (correcciones y cargas históricas).
class _DialogoReiniciar extends StatefulWidget {
  final Map<String, dynamic> equipo;
  const _DialogoReiniciar({required this.equipo});

  @override
  State<_DialogoReiniciar> createState() => _DialogoReiniciarState();
}

class _DialogoReiniciarState extends State<_DialogoReiniciar> {
  late final TextEditingController _valorCtrl = TextEditingController(text: widget.equipo['ultima_lectura']?.toString() ?? '');

  @override
  void dispose() {
    _valorCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return DialogoFormulario(
      icono: Icons.build_circle_outlined,
      titulo: 'Mantención de ${widget.equipo['codigo']}',
      subtitulo: 'Marcar la mantención preventiva como hecha',
      textoAccion: 'Confirmar mantención',
      ancho: 440,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const LineaInfo(icono: Icons.info_outline, texto: 'El contador vuelve a cero desde el horómetro que indiques, y el equipo deja de alertar.'),
          separadorCampos,
          TextFormField(
            controller: _valorCtrl,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: decoracionCampo('Horómetro de la mantención', obligatorio: true, sufijo: 'h'),
            validator: (v) {
              final n = parsearNumero(v ?? '');
              return (n == null || n < 0) ? 'Indica a qué horómetro se hizo la mantención.' : null;
            },
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.post('/api/horometro/maquinaria/${widget.equipo['id']}/reiniciar', {'valor': parsearNumero(_valorCtrl.text)}),
    );
  }
}

class _DialogoHistorial extends StatefulWidget {
  final int maquinariaId;
  final String codigo;
  const _DialogoHistorial({required this.maquinariaId, required this.codigo});

  @override
  State<_DialogoHistorial> createState() => _DialogoHistorialState();
}

class _DialogoHistorialState extends State<_DialogoHistorial> {
  Map<String, dynamic>? _datos;
  String? _error;

  static const _etiquetaOrigen = {
    'movil': 'App del mecánico',
    'panel': 'Panel',
    'guia': 'Guía de despacho',
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    try {
      final datos = await ApiClient.instance.get('/api/horometro/maquinaria/${widget.maquinariaId}');
      if (mounted) setState(() => _datos = datos);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final datos = _datos;
    return CuadroDialogo(
      icono: Icons.history,
      titulo: 'Historial de ${widget.codigo}',
      subtitulo: 'Lecturas del horómetro y quién tenía el equipo',
      ancho: 560,
      cuerpo: SizedBox(
        height: 400,
        child: _error != null
            ? Center(child: Text('No se pudo cargar el historial del equipo: $_error'))
            : datos == null
                ? const Center(child: CircularProgressIndicator())
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _resumen(datos),
                      const Divider(),
                      Expanded(child: _lista(datos['lecturas'] as List<dynamic>)),
                    ],
                  ),
      ),
      acciones: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar'))],
    );
  }

  Widget _resumen(Map<String, dynamic> datos) {
    final estado = datos['estado_mantencion'] as Map<String, dynamic>;
    final maquinaria = datos['maquinaria'] as Map<String, dynamic>;
    if (estado['horas_usadas'] == null) {
      return const Text('Todavía no hay lecturas para este equipo.');
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Última lectura: ${datos['ultima_lectura']} h', style: const TextStyle(fontWeight: FontWeight.bold)),
        Text('Lleva ${estado['horas_usadas']} h de ${maquinaria['intervalo_mantencion_horas']} h del intervalo'),
        Text(
          maquinaria['horometro_ultima_mantencion'] == null
              ? 'Sin mantención registrada: se cuenta desde 0'
              : 'Última mantención al horómetro ${maquinaria['horometro_ultima_mantencion']} h',
          style: TextStyle(fontSize: 12, color: Colors.grey[700]),
        ),
      ],
    );
  }

  Widget _lista(List<dynamic> lecturas) {
    if (lecturas.isEmpty) return const Center(child: Text('Sin lecturas registradas'));
    return ListView.separated(
      itemCount: lecturas.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final l = lecturas[i] as Map<String, dynamic>;
        return ListTile(
          dense: true,
          title: Text('${l['valor']} h'),
          subtitle: Text(
            '${_etiquetaOrigen[l['origen']] ?? l['origen']}'
            '${l['cliente_nombre'] != null ? ' · ${l['cliente_nombre']}' : ''}'
            '${l['usuario_nombre'] != null ? ' · ${l['usuario_nombre']}' : ''}'
            '${l['observacion'] != null ? '\n${l['observacion']}' : ''}',
          ),
          trailing: Text(
            Formato.fecha(l['fecha'], siVacio: ''),
            style: const TextStyle(fontSize: 12),
          ),
        );
      },
    );
  }
}

class _Vacio extends StatelessWidget {
  final IconData icono;
  final String titulo;
  final String detalle;
  const _Vacio({required this.icono, required this.titulo, required this.detalle});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icono, size: 56, color: Colors.grey),
          const SizedBox(height: 12),
          Text(titulo, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40),
            child: Text(detalle, textAlign: TextAlign.center, style: TextStyle(color: Colors.grey[700])),
          ),
        ],
      ),
    );
  }
}
