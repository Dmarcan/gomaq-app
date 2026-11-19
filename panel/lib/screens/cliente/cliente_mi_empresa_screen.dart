import 'package:flutter/material.dart';
import '../../services/mi_empresa_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/ubicacion.dart';
import '../../utils/validadores_acceso.dart';
import '../../widgets/campo_ubicacion.dart';
import '../../widgets/estado_vacio.dart';

/// Largos máximos que acepta el servidor (backend/src/utils/fichaCliente.js).
const _largoHorario = 100;
const _largoDireccion = 300;
const _largoCorreo = 150;

/// "Mi empresa": el cliente ve los datos de su empresa y actualiza los de contacto. Razón social,
/// RUT, giro y plazo de pago son de solo lectura: los cambia GOMAQ.
class ClienteMiEmpresaScreen extends StatefulWidget {
  /// Se puede reemplazar en las pruebas; por defecto habla con el servidor.
  final MiEmpresaService servicio;

  /// Se puede reemplazar en las pruebas; por defecto pide el GPS o el navegador.
  final ObtenerUbicacion obtenerUbicacion;

  const ClienteMiEmpresaScreen({
    super.key,
    this.servicio = const MiEmpresaService(),
    this.obtenerUbicacion = obtenerUbicacionActual,
  });

  @override
  State<ClienteMiEmpresaScreen> createState() => _ClienteMiEmpresaScreenState();
}

class _ClienteMiEmpresaScreenState extends State<ClienteMiEmpresaScreen> {
  final _formKey = GlobalKey<FormState>();
  final _correoCtrl = TextEditingController();
  final _telefonoCtrl = TextEditingController();
  final _horarioTrabajoCtrl = TextEditingController();
  final _horarioColacionCtrl = TextEditingController();
  final _direccionCtrl = TextEditingController();

  Map<String, dynamic>? _ficha; // lo último que confirmó el servidor
  Coordenada? _ubicacion;
  bool _cargando = true;
  bool _guardando = false;
  String? _errorCarga;
  String? _errorGuardar;
  String? _exito;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _correoCtrl.dispose();
    _telefonoCtrl.dispose();
    _horarioTrabajoCtrl.dispose();
    _horarioColacionCtrl.dispose();
    _direccionCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _errorCarga = null;
    });
    try {
      final ficha = await widget.servicio.cargar();
      if (!mounted) return;
      _aplicarFicha(ficha);
    } catch (e) {
      // no solo ApiException: sin red ClienteApi deja pasar el error de socket o de timeout
      if (mounted) setState(() => _errorCarga = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  void _aplicarFicha(Map<String, dynamic> ficha) {
    setState(() {
      _ficha = ficha;
      _correoCtrl.text = _texto(ficha['email']);
      _telefonoCtrl.text = _texto(ficha['telefono']);
      _horarioTrabajoCtrl.text = _texto(ficha['horario_trabajo']);
      _horarioColacionCtrl.text = _texto(ficha['horario_colacion']);
      _direccionCtrl.text = _texto(ficha['direccion']);
      _ubicacion = _coordenadaDe(ficha);
    });
  }

  static String _texto(Object? v) => (v as String?) ?? '';

  static Coordenada? _coordenadaDe(Map<String, dynamic> ficha) {
    final lat = ficha['latitud'];
    final lng = ficha['longitud'];
    if (lat is num && lng is num) return Coordenada(lat.toDouble(), lng.toDouble());
    return null;
  }

  /// Solo lo que el cliente modificó respecto de lo que tiene el servidor.
  Map<String, dynamic> _cambios() {
    final ficha = _ficha ?? const <String, dynamic>{};
    final cambios = <String, dynamic>{};
    void texto(String campo, TextEditingController ctrl) {
      final nuevo = ctrl.text.trim();
      if (nuevo != _texto(ficha[campo]).trim()) cambios[campo] = nuevo;
    }

    texto('email', _correoCtrl);
    texto('telefono', _telefonoCtrl);
    texto('horario_trabajo', _horarioTrabajoCtrl);
    texto('horario_colacion', _horarioColacionCtrl);
    texto('direccion', _direccionCtrl);
    if (_ubicacion != _coordenadaDe(ficha)) {
      cambios['latitud'] = _ubicacion?.latitud;
      cambios['longitud'] = _ubicacion?.longitud;
    }
    return cambios;
  }

  Future<void> _guardar() async {
    if (_guardando || _ficha == null) return;
    setState(() {
      _errorGuardar = null;
      _exito = null;
    });
    if (!_formKey.currentState!.validate()) return;
    final cambios = _cambios();
    if (cambios.isEmpty) {
      setState(() => _exito = 'No hay cambios por guardar.');
      return;
    }
    setState(() => _guardando = true);
    try {
      final ficha = await widget.servicio.guardar(cambios);
      if (!mounted) return;
      _aplicarFicha(ficha);
      setState(() => _exito = 'Datos guardados.');
    } catch (e) {
      if (mounted) setState(() => _errorGuardar = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_errorCarga != null || _ficha == null) {
      return EstadoRefrescable(
        onRefresh: _cargar,
        child: EstadoError(
          titulo: 'No se pudieron cargar los datos de tu empresa',
          mensaje: _errorCarga ?? 'Vuelve a intentar.',
          onReintentar: _cargar,
        ),
      );
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                header: true,
                child: const Text('Mi empresa', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
              ),
              const SizedBox(height: 12),
              _bloqueSoloLectura(),
              const SizedBox(height: 20),
              _formulario(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _bloqueSoloLectura() {
    final f = _ficha!;
    final plazo = f['plazo_pago_dias'];
    final filas = <(String, String)>[
      ('Razón social', _texto(f['nombre'])),
      ('RUT', _texto(f['rut'])),
      ('Giro', _texto(f['giro'])),
      ('Plazo de pago', plazo is int ? (plazo == 0 ? 'Contado' : '$plazo días') : ''),
    ];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: const Text('Datos de la empresa', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ),
            const SizedBox(height: 8),
            for (final (etiqueta, valor) in filas)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: MergeSemantics(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(etiqueta, style: const TextStyle(color: Colors.black54, fontSize: 12)),
                      Text(valor.isEmpty ? 'Sin registrar' : valor),
                    ],
                  ),
                ),
              ),
            const SizedBox(height: 8),
            const Text(
              'Para cambiar estos datos, contacta a GOMAQ.',
              style: TextStyle(color: GomaqColors.advertenciaFuerte, fontWeight: FontWeight.w600, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }

  /// Dos campos lado a lado desde 600 px de ancho; apilados en un teléfono.
  Widget _enFila(Widget a, Widget b) => LayoutBuilder(
        builder: (context, c) {
          if (c.maxWidth < 600) {
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [a, const SizedBox(height: 12), b]);
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [Expanded(child: a), const SizedBox(width: 12), Expanded(child: b)],
          );
        },
      );

  Widget _formulario() {
    return Form(
      key: _formKey,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            child: const Text('Datos de contacto', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          ),
          const SizedBox(height: 4),
          const Text(
            'El correo es el de los avisos y las facturas de tu empresa; no es el correo con que inicias sesión.',
            style: TextStyle(color: Colors.black54, fontSize: 13),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _correoCtrl,
            maxLength: _largoCorreo,
            decoration: const InputDecoration(labelText: 'Correo de la empresa *', counterText: ''),
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            validator: validarCorreo,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _telefonoCtrl,
            maxLength: largoMaximoTelefono,
            decoration: const InputDecoration(
              labelText: 'Teléfono de contacto',
              helperText: 'De 8 a 15 dígitos; puedes usar +, espacios o guiones.',
              helperMaxLines: 2,
              counterText: '',
            ),
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.next,
            validator: validarTelefonoOpcional,
          ),
          const SizedBox(height: 12),
          _enFila(
            TextFormField(
              controller: _horarioTrabajoCtrl,
              maxLength: _largoHorario,
              decoration: const InputDecoration(labelText: 'Horario de trabajo', hintText: 'ej. 08:00-18:00', counterText: ''),
              textInputAction: TextInputAction.next,
            ),
            TextFormField(
              controller: _horarioColacionCtrl,
              maxLength: _largoHorario,
              decoration: const InputDecoration(labelText: 'Horario de colación', hintText: 'ej. 13:00-14:00', counterText: ''),
              textInputAction: TextInputAction.next,
            ),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _direccionCtrl,
            maxLength: _largoDireccion,
            decoration: const InputDecoration(labelText: 'Dirección', counterText: ''),
            textInputAction: TextInputAction.done,
            onFieldSubmitted: (_) => _guardar(),
          ),
          const SizedBox(height: 8),
          CampoUbicacion(
            valor: _ubicacion,
            obtener: widget.obtenerUbicacion,
            onChanged: (c) => setState(() => _ubicacion = c),
          ),
          const SizedBox(height: 20),
          if (_errorGuardar != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Semantics(
                liveRegion: true,
                child: Text(_errorGuardar!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
              ),
            ),
          if (_exito != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Semantics(
                liveRegion: true,
                child: Text(_exito!, style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
            ),
          FilledButton(
            onPressed: _guardando ? null : _guardar,
            child: _guardando
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Guardar'),
          ),
        ],
      ),
    );
  }
}
