import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';

class GuiasScreen extends StatefulWidget {
  const GuiasScreen({super.key});

  @override
  State<GuiasScreen> createState() => _GuiasScreenState();
}

class _GuiasScreenState extends State<GuiasScreen> {
  List<dynamic> _maquinarias = [];
  List<dynamic> _clientes = [];
  Map<String, dynamic>? _seleccionada;
  int? _clienteId;
  String _tipo = 'despacho';
  PlatformFile? _archivo;
  bool _subiendo = false;
  bool _cargando = true;
  bool _detectando = false;
  bool _huboDeteccion = false;
  DateTime _fecha = DateTime.now();
  TimeOfDay _hora = TimeOfDay.now();
  bool _fallido = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargarDatos());
  }

  List<dynamic> get _maquinariasDisponibles =>
      _maquinarias.where((m) => m['estado'] != 'fuera_de_servicio').toList();

  Future<void> _cargarDatos() async {
    try {
      final maquinarias = await ApiClient.instance.get('/api/maquinarias');
      final clientes = await ApiClient.instance.get('/api/clientes');
      if (mounted) {
        setState(() {
          _maquinarias = maquinarias;
          _clientes = clientes;
        });
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _elegirArchivo() async {
    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado == null || resultado.files.single.bytes == null) return;
    setState(() {
      _archivo = resultado.files.single;
      _huboDeteccion = false;
    });
    await _detectarDatos();
  }

  Future<void> _detectarDatos() async {
    if (_archivo == null) return;
    setState(() => _detectando = true);
    try {
      final resultado = await ApiClient.instance.postMultipart(
        '/api/maquinarias/guias/detectar',
        bytes: _archivo!.bytes,
        filename: _archivo!.name,
      );
      if (!mounted) return;
      setState(() {
        _huboDeteccion = true;
        if (resultado['tipo_detectado'] != null) _tipo = resultado['tipo_detectado'];
        if (resultado['fecha_hora_detectada'] != null) {
          final detectada = DateTime.parse(resultado['fecha_hora_detectada']).toLocal();
          _fecha = detectada;
          _hora = TimeOfDay(hour: detectada.hour, minute: detectada.minute);
        }
        if (resultado['cliente_detectado'] != null) _clienteId = resultado['cliente_detectado']['id'];
      });
    } on ApiException catch (_) {
      // deteccion best-effort: si falla, el usuario sigue llenando a mano sin interrupcion
    } finally {
      if (mounted) setState(() => _detectando = false);
    }
  }

  Future<void> _elegirFecha() async {
    final elegida = await showDatePicker(
      context: context,
      initialDate: _fecha,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (elegida != null) setState(() => _fecha = elegida);
  }

  Future<void> _elegirHora() async {
    final elegida = await showTimePicker(context: context, initialTime: _hora);
    if (elegida != null) setState(() => _hora = elegida);
  }

  Future<void> _guardar() async {
    if (_seleccionada == null || _archivo == null) return;
    if (_tipo == 'despacho' && !_fallido && _clienteId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Selecciona el cliente al que se despacha el equipo')),
      );
      return;
    }
    setState(() => _subiendo = true);
    try {
      final fechaHora = DateTime(_fecha.year, _fecha.month, _fecha.day, _hora.hour, _hora.minute);
      await ApiClient.instance.postMultipart(
        '/api/maquinarias/${_seleccionada!['id']}/guias',
        bytes: _archivo!.bytes!,
        filename: _archivo!.name,
        fields: {
          'tipo': _tipo,
          'fecha_hora': fechaHora.toIso8601String(),
          'fallido': _fallido.toString(),
          if (_tipo == 'despacho' && _clienteId != null) 'cliente_id': _clienteId.toString(),
        },
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Guia guardada correctamente')));
        setState(() {
          _archivo = null;
          _fallido = false;
          _huboDeteccion = false;
          _clienteId = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _subiendo = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());

    // el registro de guias es exclusivo de Administrativo (backend igual);
    // al Gerente se le explica en vez de mostrarle un formulario que le fallara
    if (!context.watch<AuthService>().esAdministrativo) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.description_outlined, size: 56, color: Colors.grey),
              SizedBox(height: 16),
              Text('El registro de guías lo realiza Administrativo', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              SizedBox(height: 8),
              Text(
                'Los días de arriendo calculados a partir de las guías se ven en Facturación y en el perfil de cada equipo.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.black54),
              ),
            ],
          ),
        ),
      );
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('El sistema calcula automáticamente los días de arriendo al cruzar ambos documentos',
                style: TextStyle(color: Colors.black54)),
            const SizedBox(height: 20),
            const Text('EQUIPO ASOCIADO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            DropdownButtonFormField<Map<String, dynamic>>(
              initialValue: _seleccionada,
              items: _maquinariasDisponibles
                  .map<DropdownMenuItem<Map<String, dynamic>>>(
                    (m) => DropdownMenuItem(value: m, child: Text('${m['codigo']} - ${m['tipo']}')),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _seleccionada = v),
              decoration: const InputDecoration(border: OutlineInputBorder()),
            ),
            const SizedBox(height: 20),
            const Text('DOCUMENTO PDF', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            InkWell(
              onTap: _elegirArchivo,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(32),
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey.shade400, style: BorderStyle.solid),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  children: [
                    const Icon(Icons.upload_file, size: 32, color: Colors.grey),
                    const SizedBox(height: 8),
                    Text(_archivo?.name ?? 'Haz clic para buscar el PDF de la guía', textAlign: TextAlign.center),
                    if (_archivo == null) const Text('Solo PDF · hasta 10 MB', style: TextStyle(fontSize: 12, color: Colors.grey)),
                  ],
                ),
              ),
            ),
            if (_detectando) ...[
              const SizedBox(height: 12),
              const Row(
                children: [
                  SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 8),
                  Text('Leyendo el PDF para detectar fecha, hora y tipo...', style: TextStyle(fontSize: 12, color: Colors.black54)),
                ],
              ),
            ],
            if (_archivo != null && !_detectando) ...[
              const SizedBox(height: 20),
              if (_huboDeteccion)
                const Padding(
                  padding: EdgeInsets.only(bottom: 8),
                  child: Text(
                    'Revisa lo que se detectó y corrige si algo está mal antes de guardar',
                    style: TextStyle(fontSize: 12, color: Colors.black54, fontStyle: FontStyle.italic),
                  ),
                ),
              const Text('TIPO DE DOCUMENTO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(child: _botonTipo('despacho', 'Guía de Despacho')),
                  const SizedBox(width: 12),
                  Expanded(child: _botonTipo('recepcion', 'Guía de Recepción')),
                ],
              ),
              if (_tipo == 'despacho') ...[
                const SizedBox(height: 20),
                const Text('CLIENTE', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                const Text(
                  'El equipo quedará marcado como arrendado a este cliente',
                  style: TextStyle(fontSize: 12, color: Colors.black54),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<int>(
                  initialValue: _clienteId,
                  decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'Selecciona el cliente'),
                  items: _clientes
                      .map<DropdownMenuItem<int>>((c) => DropdownMenuItem(value: c['id'], child: Text(c['nombre'])))
                      .toList(),
                  onChanged: (v) => setState(() => _clienteId = v),
                ),
              ],
              const SizedBox(height: 20),
              const Text('FECHA Y HORA DE SALIDA/LLEGADA', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _elegirFecha,
                      icon: const Icon(Icons.calendar_today, size: 16),
                      label: Text('${_fecha.day}/${_fecha.month}/${_fecha.year}'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _elegirHora,
                      icon: const Icon(Icons.access_time, size: 16),
                      label: Text(_hora.format(context)),
                    ),
                  ),
                ],
              ),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(_tipo == 'despacho' ? 'Marcar como despacho fallido' : 'Marcar como retiro fallido'),
                subtitle: const Text('El equipo no se usó o el retiro no se concretó: no se factura ni cuenta como día de arriendo'),
                value: _fallido,
                onChanged: (v) => setState(() => _fallido = v ?? false),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: (_seleccionada != null && _archivo != null && !_subiendo && !_detectando) ? _guardar : null,
              child: _subiendo
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Guardar Guía'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _botonTipo(String valor, String etiqueta) {
    final activo = _tipo == valor;
    return OutlinedButton(
      onPressed: () => setState(() => _tipo = valor),
      style: OutlinedButton.styleFrom(
        backgroundColor: activo ? GomaqColors.primario : Colors.white,
        foregroundColor: activo ? Colors.white : GomaqColors.primario,
      ),
      child: Text(etiqueta),
    );
  }
}
