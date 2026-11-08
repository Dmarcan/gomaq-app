import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/ubicacion.dart';
import '../../utils/validadores_acceso.dart';
import '../../widgets/campo_ubicacion.dart';

class RegistroClienteScreen extends StatefulWidget {
  const RegistroClienteScreen({super.key});

  @override
  State<RegistroClienteScreen> createState() => _RegistroClienteScreenState();
}

class _RegistroClienteScreenState extends State<RegistroClienteScreen> {
  final _nombreCtrl = TextEditingController();
  final _empresaCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmarCtrl = TextEditingController();
  final _rutCtrl = TextEditingController();
  final _whatsappCtrl = TextEditingController();
  final _horarioTrabajoCtrl = TextEditingController();
  final _horarioColacionCtrl = TextEditingController();
  final _direccionCtrl = TextEditingController();

  final _formKey = GlobalKey<FormState>();
  // una llave por campo, en el orden del formulario, para saber cuál es el primero con error
  final _llaveNombre = GlobalKey<FormFieldState<String>>();
  final _llaveCorreo = GlobalKey<FormFieldState<String>>();
  final _llavePassword = GlobalKey<FormFieldState<String>>();
  final _llaveConfirmar = GlobalKey<FormFieldState<String>>();
  final _llaveEmpresa = GlobalKey<FormFieldState<String>>();
  final _llaveRut = GlobalKey<FormFieldState<String>>();
  final _llaveTelefono = GlobalKey<FormFieldState<String>>();
  List<GlobalKey<FormFieldState<String>>> get _llavesCampos =>
      [_llaveNombre, _llaveCorreo, _llavePassword, _llaveConfirmar, _llaveEmpresa, _llaveRut, _llaveTelefono];
  bool _enviando = false;
  bool _verPassword = false;
  String? _error;
  bool _enviado = false;
  // ubicación de la empresa marcada con "Usar mi ubicación actual"; opcional
  Coordenada? _ubicacion;

  /// Lleva la vista al primer campo con error: en un teléfono el formulario no cabe y el error
  /// podía quedar fuera de pantalla sin que se viera por qué no se envió.
  void _irAlPrimerError() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final llave in _llavesCampos) {
        final ctx = llave.currentContext;
        if (ctx == null) continue;
        final campo = llave.currentState;
        if (campo != null && campo.hasError) {
          Scrollable.ensureVisible(ctx, alignment: 0.2, duration: const Duration(milliseconds: 250));
          return;
        }
      }
    });
  }

  Future<void> _registrar() async {
    // cada campo muestra su propio error; el formulario no se envía si alguno falla
    if (!(_formKey.currentState?.validate() ?? false)) {
      setState(() => _error = 'Revisa los campos marcados.');
      _irAlPrimerError();
      return;
    }

    setState(() {
      _enviando = true;
      _error = null;
    });
    try {
      await ApiClient.instance.post('/api/registro-cliente', {
        'nombre_contacto': _nombreCtrl.text.trim(),
        'nombre_empresa': _empresaCtrl.text.trim(),
        'email': _emailCtrl.text.trim(),
        'password': _passwordCtrl.text,
        'rut_empresa': _rutCtrl.text.trim().isEmpty ? null : _rutCtrl.text.trim(),
        'telefono_whatsapp': _whatsappCtrl.text.trim().isEmpty ? null : _whatsappCtrl.text.trim(),
        'horario_trabajo': _horarioTrabajoCtrl.text.trim().isEmpty ? null : _horarioTrabajoCtrl.text.trim(),
        'horario_colacion': _horarioColacionCtrl.text.trim().isEmpty ? null : _horarioColacionCtrl.text.trim(),
        'direccion': _direccionCtrl.text.trim().isEmpty ? null : _direccionCtrl.text.trim(),
        'latitud': _ubicacion?.latitud,
        'longitud': _ubicacion?.longitud,
      });
      if (mounted) setState(() => _enviado = true);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      // fallo de red/timeout: sin este catch el usuario quedaba sin spinner, sin error
      // y sin saber si su cuenta se creo (mismo manejo que el login)
      setState(() => _error = 'No se pudo conectar al servidor. Revisa tu conexión e intenta de nuevo.');
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: GomaqColors.fondoCalido,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: Colors.black87,
        leading: IconButton(
          tooltip: 'Volver al inicio de sesión',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/login'),
        ),
      ),
      body: Center(
        child: Card(
          child: Padding(
            padding: EdgeInsets.all(MediaQuery.sizeOf(context).width < 480 ? 20 : 32),
            child: SizedBox(
              width: 420,
              child: SingleChildScrollView(
                child: _enviado ? _construirConfirmacion() : _construirFormulario(),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _construirConfirmacion() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.check_circle, color: GomaqColors.estadoPositivo, size: 56),
        const SizedBox(height: 16),
        const Text('Solicitud de cuenta enviada', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        const Text(
          'GOMAQ revisará tu solicitud en horario hábil. Cuando esté aprobada podrás ingresar '
          'con este correo y esta contraseña. Si intentas entrar antes, verás que tu cuenta sigue en revisión.',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        FilledButton(onPressed: () => context.go('/login'), child: const Text('Volver al inicio de sesión')),
      ],
    );
  }

  /// Dos campos lado a lado cuando hay espacio; uno bajo el otro en un teléfono, donde cada uno
  /// quedaba de unos 140 px y las etiquetas se cortaban ("Repetir contra...").
  Widget _enFila(Widget a, Widget b) {
    return LayoutBuilder(
      builder: (context, c) {
        if (c.maxWidth < 380) {
          return Column(children: [a, const SizedBox(height: 12), b]);
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [Expanded(child: a), const SizedBox(width: 12), Expanded(child: b)],
        );
      },
    );
  }

  Widget _construirFormulario() {
    return Form(
      key: _formKey,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      child: AutofillGroup(child: _camposFormulario()),
    );
  }

  Widget _camposFormulario() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Crear cuenta de Cliente', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        const Text(
          'Completa tus datos. Un administrador revisará tu solicitud antes de activar tu cuenta. '
          'Los campos con * son obligatorios.',
          style: TextStyle(color: Colors.black54, fontSize: 13),
        ),
        const SizedBox(height: 20),
        TextFormField(
          key: _llaveNombre,
          controller: _nombreCtrl,
          decoration: const InputDecoration(labelText: 'Nombre de contacto *'),
          textCapitalization: TextCapitalization.words,
          autofillHints: const [AutofillHints.name],
          validator: (v) => validarObligatorio(v, 'Escribe tu nombre.'),
        ),
        const SizedBox(height: 12),
        TextFormField(
          key: _llaveCorreo,
          controller: _emailCtrl,
          decoration: const InputDecoration(labelText: 'Correo electrónico *'),
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          validator: validarCorreo,
        ),
        const SizedBox(height: 12),
        _enFila(
          TextFormField(
            key: _llavePassword,
            controller: _passwordCtrl,
            // al cambiar la contraseña se vuelve a validar la confirmación
            onChanged: (_) {
              if (_confirmarCtrl.text.isNotEmpty) _llaveConfirmar.currentState?.validate();
            },
            decoration: InputDecoration(
              labelText: 'Contraseña *',
              helperText: 'Mínimo $largoMinimoPassword caracteres',
              suffixIcon: IconButton(
                tooltip: _verPassword ? 'Ocultar contraseñas' : 'Mostrar contraseñas',
                icon: Icon(_verPassword ? Icons.visibility_off : Icons.visibility),
                onPressed: () => setState(() => _verPassword = !_verPassword),
              ),
            ),
            obscureText: !_verPassword,
            autofillHints: const [AutofillHints.newPassword],
            validator: validarPassword,
          ),
          TextFormField(
            key: _llaveConfirmar,
            controller: _confirmarCtrl,
            decoration: const InputDecoration(labelText: 'Repetir contraseña *'),
            obscureText: !_verPassword,
            autofillHints: const [AutofillHints.newPassword],
            validator: (v) => validarConfirmacion(v, _passwordCtrl.text),
          ),
        ),
        const SizedBox(height: 20),
        const Text('DATOS DE LA EMPRESA QUE REPRESENTAS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        TextFormField(
          key: _llaveEmpresa,
          controller: _empresaCtrl,
          decoration: const InputDecoration(labelText: 'Nombre de la empresa *'),
          textCapitalization: TextCapitalization.words,
          autofillHints: const [AutofillHints.organizationName],
          validator: (v) => validarObligatorio(v, 'Escribe el nombre de la empresa.'),
        ),
        const SizedBox(height: 12),
        TextFormField(
          key: _llaveRut,
          controller: _rutCtrl,
          maxLength: largoMaximoRut,
          decoration: const InputDecoration(labelText: 'RUT de la empresa', helperText: 'Por ejemplo 76.123.456-7.', counterText: ''),
          validator: validarRutOpcional,
        ),
        const SizedBox(height: 12),
        TextFormField(
          key: _llaveTelefono,
          controller: _whatsappCtrl,
          maxLength: largoMaximoTelefono,
          decoration: const InputDecoration(
            labelText: 'Teléfono de contacto (WhatsApp)',
            helperText: 'De 8 a 15 dígitos; puedes usar +, espacios o guiones. Ej.: +56 9 1234 5678.',
            counterText: '',
          ),
          keyboardType: TextInputType.phone,
          autofillHints: const [AutofillHints.telephoneNumber],
          validator: validarTelefonoOpcional,
        ),
        const SizedBox(height: 12),
        _enFila(
          TextField(
            controller: _horarioTrabajoCtrl,
            decoration: const InputDecoration(labelText: 'Horario de trabajo', hintText: 'ej. 08:00-18:00'),
          ),
          TextField(
            controller: _horarioColacionCtrl,
            decoration: const InputDecoration(labelText: 'Horario de colación', hintText: 'ej. 13:00-14:00'),
          ),
        ),
        const SizedBox(height: 12),
        TextField(controller: _direccionCtrl, decoration: const InputDecoration(labelText: 'Dirección'), maxLines: 2),
        const SizedBox(height: 8),
        CampoUbicacion(valor: _ubicacion, onChanged: (c) => setState(() => _ubicacion = c)),
        const SizedBox(height: 24),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Semantics(
              liveRegion: true,
              child: Text(_error!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
            ),
          ),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _enviando ? null : _registrar,
            child: _enviando
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Solicitar cuenta'),
          ),
        ),
      ],
    );
  }
}
