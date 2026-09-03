import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

/// Horometro y mantencion preventiva (entrevista el jefe de taller/la administrativa, 20-21 julio 2026).
///
/// Dos pestanas que responden a dos cosas distintas que pidieron:
///  - "Por medir": la agenda del mes. Los equipos arrendados a los que todavia no se les toma
///    la lectura; al registrarla desaparecen de la lista.
///  - "Mantencion": los equipos que ya cumplieron el intervalo o estan a 50 h o menos.
class HorometroScreen extends StatefulWidget {
  const HorometroScreen({super.key});

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

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
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
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _registrarLectura(Map<String, dynamic> equipo) async {
    final resultado = await showDialog<bool>(
      context: context,
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
            Text('Error: $_error'),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _cargar, child: const Text('Reintentar')),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.only(bottom: 4),
          child: Text('Horómetro y Mantención', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        ),
        Text(
          'La mantención preventiva se calcula con las horas de uso desde la última mantención.',
          style: TextStyle(fontSize: 13, color: Colors.grey[700]),
        ),
        const SizedBox(height: 12),
        TabBar(
          controller: _tabController,
          labelColor: GomaqColors.primario,
          indicatorColor: GomaqColors.primario,
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
      itemBuilder: (_, i) {
        final e = _pendientes[i] as Map<String, dynamic>;
        final ultima = e['ultima_lectura'];
        return ListTile(
          leading: const Icon(Icons.timer_outlined),
          title: Text('${e['codigo']} — ${e['tipo']}'),
          subtitle: Text(
            '${e['cliente_nombre'] ?? 'Sin cliente'}'
            '${ultima == null ? ' · sin lecturas previas' : ' · última: $ultima h'}',
          ),
          trailing: Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: () => _verHistorial(e['id'], e['codigo']),
                child: const Text('Historial'),
              ),
              ElevatedButton(
                onPressed: () => _registrarLectura(e),
                child: const Text('Registrar'),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _construirAlertas() {
    if (_alertas.isEmpty) {
      return _Vacio(
        icono: Icons.verified_outlined,
        titulo: 'Ningún equipo necesita mantención',
        detalle: 'Aparecen aquí al quedar $_horasAviso h o menos para cumplir su intervalo.',
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.only(top: 12),
      itemCount: _alertas.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final e = _alertas[i] as Map<String, dynamic>;
        final vencida = e['vencida'] == true;
        final restantes = (e['horas_restantes'] as num?) ?? 0;
        return ListTile(
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
          trailing: Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: () => _verHistorial(e['id'], e['codigo']),
                child: const Text('Historial'),
              ),
              OutlinedButton(
                onPressed: () => _marcarMantencion(e),
                child: const Text('Mantención hecha'),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _marcarMantencion(Map<String, dynamic> equipo) async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (_) => _DialogoReiniciar(equipo: equipo),
    );
    if (confirmado == true) _cargar();
  }
}

/// Registrar una lectura de horómetro desde el panel (origen 'panel').
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
  bool _guardando = false;
  String? _error;

  @override
  void dispose() {
    _valorCtrl.dispose();
    _obsCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final valor = double.tryParse(_valorCtrl.text.trim().replaceAll(',', '.'));
    if (valor == null || valor < 0) {
      setState(() => _error = 'Ingresa las horas del horómetro');
      return;
    }
    setState(() {
      _guardando = true;
      _error = null;
    });
    try {
      await ApiClient.instance.post('/api/horometro/maquinaria/${widget.equipo['id']}', {
        'valor': valor,
        'observacion': _obsCtrl.text.trim().isEmpty ? null : _obsCtrl.text.trim(),
        'reiniciar_contador': _reiniciar,
      });
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Horómetro de ${widget.equipo['codigo']}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _valorCtrl,
            autofocus: true,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Horas del horómetro', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _obsCtrl,
            decoration: const InputDecoration(labelText: 'Observación (opcional)', border: OutlineInputBorder()),
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: _reiniciar,
            onChanged: (v) => setState(() => _reiniciar = v ?? false),
            title: const Text('Se hizo la mantención preventiva'),
            subtitle: const Text('Reinicia el contador: esta lectura pasa a ser la base del próximo intervalo'),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: _guardando ? null : () => Navigator.pop(context), child: const Text('Cancelar')),
        ElevatedButton(onPressed: _guardando ? null : _guardar, child: Text(_guardando ? 'Guardando...' : 'Guardar')),
      ],
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
  late final TextEditingController _valorCtrl =
      TextEditingController(text: widget.equipo['ultima_lectura']?.toString() ?? '');
  bool _guardando = false;
  String? _error;

  @override
  void dispose() {
    _valorCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final valor = double.tryParse(_valorCtrl.text.trim().replaceAll(',', '.'));
    if (valor == null || valor < 0) {
      setState(() => _error = 'Indica a qué horómetro se hizo la mantención');
      return;
    }
    setState(() {
      _guardando = true;
      _error = null;
    });
    try {
      await ApiClient.instance
          .post('/api/horometro/maquinaria/${widget.equipo['id']}/reiniciar', {'valor': valor});
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Mantención de ${widget.equipo['codigo']}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'El contador vuelve a cero desde el horómetro que indiques, y el equipo deja de alertar.',
            style: TextStyle(fontSize: 13),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _valorCtrl,
            autofocus: true,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Horómetro de la mantención', border: OutlineInputBorder()),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: _guardando ? null : () => Navigator.pop(context), child: const Text('Cancelar')),
        ElevatedButton(
          onPressed: _guardando ? null : _guardar,
          child: Text(_guardando ? 'Guardando...' : 'Confirmar'),
        ),
      ],
    );
  }
}

/// Historial de lecturas del equipo, con el cliente que lo tenía en cada una.
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
    return AlertDialog(
      title: Text('Historial de ${widget.codigo}'),
      content: SizedBox(
        width: 520,
        height: 420,
        child: _error != null
            ? Center(child: Text('Error: $_error'))
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
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar'))],
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
        final fecha = DateTime.tryParse(l['fecha'] ?? '')?.toLocal();
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
            fecha == null ? '' : '${fecha.day}/${fecha.month}/${fecha.year}',
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
