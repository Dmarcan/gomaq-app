import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/estado_chip.dart';
import '../widgets/estado_vacio.dart';

class ClienteMisEquiposScreen extends StatefulWidget {
  const ClienteMisEquiposScreen({super.key});

  @override
  State<ClienteMisEquiposScreen> createState() => _ClienteMisEquiposScreenState();
}

class _ClienteMisEquiposScreenState extends State<ClienteMisEquiposScreen> {
  List<dynamic> _maquinarias = [];
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
      final data = await ApiClient.instance.get('/api/maquinarias/mias');
      if (!mounted) return;
      setState(() => _maquinarias = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _solicitarAsistencia(Map<String, dynamic> maquinaria) async {
    await showDialog(context: context, builder: (_) => _SolicitarAsistenciaDialog(maquinaria: maquinaria));
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: GomaqColors.primario, borderRadius: BorderRadius.circular(16)),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Hola,', style: TextStyle(color: Colors.white70, fontSize: 14)),
                      Text(auth.nombre ?? '', style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold)),
                    ],
                  ),
                ),
                CircleAvatar(
                  backgroundColor: Colors.white24,
                  child: Text((auth.nombre ?? '?').substring(0, 1).toUpperCase(), style: const TextStyle(color: Colors.white)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          if (_cargando)
            const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
          else if (_error != null)
            Center(child: Text('Error: $_error'))
          else if (_maquinarias.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 32),
              child: EstadoVacio(
                icono: Icons.local_shipping_outlined,
                titulo: 'Aún no tienes equipos',
                mensaje: 'Cuando GOMAQ te entregue un equipo en arriendo, aparecerá aquí.',
              ),
            )
          else
            for (final m in _maquinarias)
              Card(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ListTile(
                        title: Text('${m['codigo']} - ${m['tipo']}'),
                        subtitle: Text(m['ubicacion'] ?? 'Sin ubicación registrada'),
                        trailing: EstadoChip(estado: m['estado']),
                      ),
                      // Antes la única forma de pedir asistencia era tocar la tarjeta, y nada lo
                      // indicaba: un cliente con un equipo en falla no encontraba cómo pedir ayuda.
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: OutlinedButton.icon(
                          onPressed: () => _solicitarAsistencia(m),
                          icon: const Icon(Icons.support_agent, size: 18),
                          label: const Text('Solicitar asistencia'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
        ],
      ),
    );
  }
}

class _SolicitarAsistenciaDialog extends StatefulWidget {
  final Map<String, dynamic> maquinaria;
  const _SolicitarAsistenciaDialog({required this.maquinaria});

  @override
  State<_SolicitarAsistenciaDialog> createState() => _SolicitarAsistenciaDialogState();
}

class _SolicitarAsistenciaDialogState extends State<_SolicitarAsistenciaDialog> {
  final _descripcionCtrl = TextEditingController();
  String _tipo = 'falla';
  PlatformFile? _evidencia;
  bool _enviando = false;

  Future<void> _elegirEvidencia() async {
    final resultado = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
    if (resultado != null && resultado.files.single.bytes != null) {
      setState(() => _evidencia = resultado.files.single);
    }
  }

  Future<void> _enviar() async {
    if (_descripcionCtrl.text.trim().isEmpty) return;
    setState(() => _enviando = true);
    try {
      if (_evidencia != null) {
        await ApiClient.instance.postMultipart(
          '/api/solicitudes',
          bytes: _evidencia!.bytes!,
          filename: _evidencia!.name,
          fields: {
            'maquinaria_id': '${widget.maquinaria['id']}',
            'descripcion': _descripcionCtrl.text.trim(),
            'tipo': _tipo,
          },
        );
      } else {
        await ApiClient.instance.post('/api/solicitudes', {
          'maquinaria_id': widget.maquinaria['id'],
          'descripcion': _descripcionCtrl.text.trim(),
          'tipo': _tipo,
        });
      }
      if (mounted) {
        // capturar el messenger ANTES del pop: despues el context del dialogo esta muerto
        // y la confirmacion nunca se mostraria
        final messenger = ScaffoldMessenger.of(context);
        Navigator.pop(context);
        messenger.showSnackBar(
          const SnackBar(content: Text('Asistencia solicitada. Te contactaremos pronto.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  Widget _botonTipo(String valor, String etiqueta) {
    final activo = _tipo == valor;
    return Expanded(
      child: OutlinedButton(
        onPressed: () => setState(() => _tipo = valor),
        style: OutlinedButton.styleFrom(
          backgroundColor: activo ? GomaqColors.accion : Colors.white,
          foregroundColor: activo ? Colors.white : GomaqColors.accion,
        ),
        child: Text(etiqueta, textAlign: TextAlign.center),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Solicitar asistencia - ${widget.maquinaria['codigo']}'),
      content: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('TIPO DE SOLICITUD', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Row(
              children: [
                _botonTipo('falla', 'Reportar falla'),
                const SizedBox(width: 8),
                _botonTipo('mantencion_preventiva', 'Mantención preventiva'),
              ],
            ),
            const SizedBox(height: 16),
            const Text('DESCRIBE EL PROBLEMA', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            TextField(
              controller: _descripcionCtrl,
              maxLines: 4,
              decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'Ej: La grúa presenta una fuga de aceite...'),
            ),
            const SizedBox(height: 16),
            const Text('EVIDENCIA (OPCIONAL)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _elegirEvidencia,
              icon: const Icon(Icons.camera_alt),
              label: Text(_evidencia?.name ?? 'Adjuntar foto del equipo'),
            ),
          ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
        FilledButton(
          onPressed: _enviando ? null : _enviar,
          child: _enviando
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Solicitar asistencia'),
        ),
      ],
    );
  }
}
