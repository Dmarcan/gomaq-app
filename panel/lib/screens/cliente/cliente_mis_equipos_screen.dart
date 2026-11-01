import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_vacio.dart';

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
    } catch (e) {
      // no solo ApiException: sin red ClienteApi deja pasar el error de socket o de timeout
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _solicitarAsistencia(Map<String, dynamic> maquinaria) async {
    // en un formulario, un clic fuera no debe botar lo escrito
    final enviada = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _SolicitarAsistenciaDialog(maquinaria: maquinaria),
    );
    if (enviada == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Asistencia solicitada. Te contactaremos pronto.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final nombre = (auth.nombre ?? '').trim();
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
                  child: Text((nombre.isEmpty ? '?' : nombre.substring(0, 1)).toUpperCase(), style: const TextStyle(color: Colors.white)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          if (_cargando)
            const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
          else if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: EstadoError(titulo: 'No se pudieron cargar tus equipos', mensaje: _error!, onReintentar: _cargar),
            )
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

  @override
  void dispose() {
    _descripcionCtrl.dispose();
    super.dispose();
  }

  Future<void> _elegirEvidencia(StateSetter redibujar) async {
    final resultado = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
    if (resultado != null && resultado.files.single.bytes != null) {
      redibujar(() => _evidencia = resultado.files.single);
    }
  }

  Future<void> _enviar() async {
    final descripcion = _descripcionCtrl.text.trim();
    if (_evidencia != null) {
      await ApiClient.instance.postMultipart(
        '/api/solicitudes',
        bytes: _evidencia!.bytes!,
        filename: _evidencia!.name,
        fields: {'maquinaria_id': '${widget.maquinaria['id']}', 'descripcion': descripcion, 'tipo': _tipo},
      );
    } else {
      await ApiClient.instance.post('/api/solicitudes', {
        'maquinaria_id': widget.maquinaria['id'],
        'descripcion': descripcion,
        'tipo': _tipo,
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final falla = _tipo == 'falla';
    return DialogoFormulario(
      icono: Icons.support_agent,
      titulo: 'Solicitar asistencia',
      subtitulo: '${widget.maquinaria['codigo']} · ${widget.maquinaria['tipo']}',
      textoAccion: 'Solicitar asistencia',
      ancho: 460,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('¿Qué necesitas?', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          // En un teléfono el cuadro mide ~300 px y dos opciones con icono y texto largo no caben
          // ("Mantención preventiva" se cortaba): con poco ancho se acortan los textos.
          LayoutBuilder(
            builder: (context, c) {
              final corto = c.maxWidth < 380;
              return SizedBox(
                width: double.infinity,
                child: SegmentedButton<String>(
                  showSelectedIcon: false,
                  segments: [
                    ButtonSegment(
                      value: 'falla',
                      label: Text(corto ? 'Falla' : 'Reportar una falla'),
                      icon: const Icon(Icons.warning_amber_rounded, size: 18),
                    ),
                    ButtonSegment(
                      value: 'mantencion_preventiva',
                      label: Text(corto ? 'Mantención' : 'Mantención preventiva'),
                      icon: const Icon(Icons.build_outlined, size: 18),
                    ),
                  ],
                  selected: {_tipo},
                  onSelectionChanged: (s) => redibujar(() => _tipo = s.first),
                ),
              );
            },
          ),
          separadorCampos,
          TextFormField(
            controller: _descripcionCtrl,
            minLines: 3,
            maxLines: 5,
            textCapitalization: TextCapitalization.sentences,
            decoration: decoracionCampo(
              falla ? 'Describe el problema' : 'Describe lo que necesitas',
              obligatorio: true,
              ayuda: falla ? 'Por ejemplo: la grúa presenta una fuga de aceite.' : 'Por ejemplo: toca la revisión de las 350 horas.',
            ),
            validator: obligatorio('Cuéntanos qué pasa para poder ayudarte.'),
          ),
          separadorCampos,
          OutlinedButton.icon(
            onPressed: () => _elegirEvidencia(redibujar),
            icon: const Icon(Icons.camera_alt),
            label: Text(_evidencia?.name ?? 'Adjuntar una foto (opcional)'),
          ),
        ],
      ),
      alGuardar: _enviar,
    );
  }
}
