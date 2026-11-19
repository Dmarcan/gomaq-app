import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';

/// Los datos propios y los avisos del usuario: `GET /api/usuarios/mi-perfil`.
typedef CargarPerfil = Future<Map<String, dynamic>> Function();

/// Guarda los cambios: `PATCH /api/usuarios/mi-perfil`. Devuelve el perfil ya actualizado.
typedef GuardarPerfil = Future<Map<String, dynamic>> Function(Map<String, dynamic> cambios);

Future<Map<String, dynamic>> _cargarPorDefecto() async =>
    Map<String, dynamic>.from(await ApiClient.instance.get('/api/usuarios/mi-perfil') as Map);

Future<Map<String, dynamic>> _guardarPorDefecto(Map<String, dynamic> cambios) async =>
    Map<String, dynamic>.from(await ApiClient.instance.patch('/api/usuarios/mi-perfil', cambios) as Map);

/// Un aviso de la lista que devuelve el servidor, con lo que la persona decidió en pantalla.
typedef _Aviso = ({String tipo, String titulo, String descripcion, bool original, bool actual});

/// "Mi perfil y mis avisos" (RF-05 y RF-06): la persona corrige su nombre y su teléfono, ve su correo (es su inicio
/// de sesión, no se cambia aquí) y elige qué avisos push recibe. Solo aparecen los avisos que le llegan por su rol.
/// Un cambio se guarda al pulsar "Guardar cambios"; nada se envía hasta entonces.
class MiPerfilScreen extends StatefulWidget {
  final CargarPerfil cargar;
  final GuardarPerfil guardar;
  const MiPerfilScreen({super.key, this.cargar = _cargarPorDefecto, this.guardar = _guardarPorDefecto});

  @override
  State<MiPerfilScreen> createState() => _MiPerfilScreenState();
}

class _MiPerfilScreenState extends State<MiPerfilScreen> {
  final _nombreCtrl = TextEditingController();
  final _telefonoCtrl = TextEditingController();
  Map<String, dynamic>? _perfil;
  List<_Aviso> _avisos = [];
  bool _cargando = true;
  bool _guardando = false;
  String? _error;
  String? _errorGuardar;

  @override
  void initState() {
    super.initState();
    _nombreCtrl.addListener(() => setState(() {}));
    _telefonoCtrl.addListener(() => setState(() {}));
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _telefonoCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      _aplicar(await widget.cargar());
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  void _aplicar(Map<String, dynamic> perfil) {
    if (!mounted) return;
    setState(() {
      _perfil = perfil;
      _nombreCtrl.text = '${perfil['nombre'] ?? ''}';
      _telefonoCtrl.text = '${perfil['telefono_whatsapp'] ?? ''}';
      _avisos = [
        for (final a in (perfil['avisos'] as List? ?? const []))
          (
            tipo: '${(a as Map)['tipo']}',
            titulo: '${a['titulo']}',
            descripcion: '${a['descripcion']}',
            original: a['activo'] == true,
            actual: a['activo'] == true,
          ),
      ];
    });
  }

  String get _nombreOriginal => '${_perfil?['nombre'] ?? ''}';
  String get _telefonoOriginal => '${_perfil?['telefono_whatsapp'] ?? ''}';

  /// Lo que cambió: el nombre, el teléfono (un teléfono vacío no se envía: no se puede borrar) y los avisos que
  /// la persona encendió o apagó.
  Map<String, dynamic> _cambios() {
    final nombre = _nombreCtrl.text.trim();
    final telefono = _telefonoCtrl.text.trim();
    final avisos = {for (final a in _avisos) if (a.actual != a.original) a.tipo: a.actual};
    return {
      if (nombre.isNotEmpty && nombre != _nombreOriginal.trim()) 'nombre': nombre,
      if (telefono.isNotEmpty && telefono != _telefonoOriginal.trim()) 'telefono_whatsapp': telefono,
      if (avisos.isNotEmpty) 'avisos': avisos,
    };
  }

  bool get _nombreVacio => _nombreCtrl.text.trim().isEmpty;
  bool get _hayCambios => _cambios().isNotEmpty;

  Future<void> _guardar() async {
    final cambios = _cambios();
    if (cambios.isEmpty || _nombreVacio) return;
    setState(() {
      _guardando = true;
      _errorGuardar = null;
    });
    try {
      final actualizado = await widget.guardar(cambios);
      if (!mounted) return;
      _aplicar(actualizado);
      if (cambios.containsKey('nombre')) {
        context.read<AuthService>().actualizarNombre('${actualizado['nombre'] ?? cambios['nombre']}');
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cambios guardados.')));
    } on ApiException catch (e) {
      if (mounted) setState(() => _errorGuardar = e.message);
    } catch (e) {
      if (mounted) setState(() => _errorGuardar = 'No se pudieron guardar los cambios: ${mensajeErrorCarga(e)}');
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Widget _datos() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const TituloSeccion('Mis datos'),
        TextField(
          controller: _nombreCtrl,
          maxLength: 150,
          textCapitalization: TextCapitalization.words,
          decoration: decoracionCampo('Nombre', obligatorio: true).copyWith(
            errorText: _nombreVacio ? 'El nombre no puede quedar vacío.' : null,
          ),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _telefonoCtrl,
          maxLength: 30,
          keyboardType: TextInputType.phone,
          decoration: decoracionCampo('Teléfono', ayuda: 'Para que la empresa pueda ubicarte. No se puede borrar, solo cambiar.'),
        ),
        const SizedBox(height: 8),
        // el correo es el inicio de sesión: se ve, pero no se cambia desde aquí
        LineaInfo(icono: Icons.mail_outline, texto: 'Correo: ${_perfil?['email'] ?? ''} (es tu inicio de sesión)'),
      ],
    );
  }

  Widget _avisosPush() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 16),
        const TituloSeccion('Mis avisos'),
        const Text(
          'Elige qué avisos recibes en este y en tus otros equipos. El correo de las facturas a los clientes no se configura aquí.',
          style: TextStyle(fontSize: 13, color: Colors.black54),
        ),
        const SizedBox(height: 4),
        if (_avisos.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('No hay avisos para tu perfil.')),
        for (var i = 0; i < _avisos.length; i++)
          SwitchListTile(
            key: ValueKey('aviso-${_avisos[i].tipo}'),
            contentPadding: EdgeInsets.zero,
            title: Text(_avisos[i].titulo),
            subtitle: Text(_avisos[i].descripcion),
            value: _avisos[i].actual,
            onChanged: _guardando
                ? null
                : (v) => setState(() {
                      final a = _avisos[i];
                      _avisos[i] = (tipo: a.tipo, titulo: a.titulo, descripcion: a.descripcion, original: a.original, actual: v);
                    }),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return EstadoError(titulo: 'No se pudo cargar tu perfil', mensaje: _error!, onReintentar: _cargar);
    }
    return Scaffold(
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(header: true, child: const Text('Mi perfil y mis avisos', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700))),
                  const SizedBox(height: 12),
                  _datos(),
                  _avisosPush(),
                  const SizedBox(height: 16),
                  // el resultado de guardar se anuncia solo
                  Semantics(
                    container: true,
                    liveRegion: true,
                    child: _errorGuardar == null
                        ? const SizedBox.shrink()
                        : Text(_errorGuardar!, style: const TextStyle(color: Colors.red, fontWeight: FontWeight.w600)),
                  ),
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(
                      onPressed: (_hayCambios && !_nombreVacio && !_guardando) ? _guardar : null,
                      child: _guardando
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Guardar cambios'),
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
