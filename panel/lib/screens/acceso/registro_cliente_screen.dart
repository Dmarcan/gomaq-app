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
  // verificación del correo: si el servidor envió un código, se pide antes de la confirmación final
  bool _pedirCodigo = false;
  bool _correoVerificado = false;
  bool _verificando = false;
  final _codigoCtrl = TextEditingController();
  String? _errorCodigo;
  String? _avisoCodigo;
  // ubicación de la empresa marcada con "Usar mi ubicación actual"; opcional
  Coordenada? _ubicacion;

  /// Lleva la vista al primer campo con error: en un telefono el formulario no cabe y el error
  /// puede quedar fuera de pantalla.
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
      final respuesta = await ApiClient.instance.post('/api/registro-cliente', {
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
      if (mounted) {
        setState(() {
          _enviado = true;
          _pedirCodigo = respuesta is Map && respuesta['verificacion'] == 'enviada';
        });
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      // fallo de red o timeout: sin este catch el usuario queda sin spinner, sin error y sin saber
      // si su cuenta se creo (mismo manejo que el login)
      setState(() => _error = 'No se pudo conectar al servidor. Revisa tu conexión e intenta de nuevo.');
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  Future<void> _verificarCodigo() async {
    final codigo = _codigoCtrl.text.replaceAll(RegExp(r'\D'), '');
    if (codigo.length != 6) {
      setState(() => _errorCodigo = 'Escribe los 6 dígitos del código.');
      return;
    }
    setState(() {
      _verificando = true;
      _errorCodigo = null;
      _avisoCodigo = null;
    });
    try {
      await ApiClient.instance.post('/api/registro-cliente/verificar', {'email': _emailCtrl.text.trim(), 'codigo': codigo});
      if (mounted) setState(() => _correoVerificado = true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errorCodigo = e.message);
    } catch (_) {
      if (mounted) setState(() => _errorCodigo = 'No se pudo conectar al servidor. Revisa tu conexión e intenta de nuevo.');
    } finally {
      if (mounted) setState(() => _verificando = false);
    }
  }

  Future<void> _reenviarCodigo() async {
    setState(() {
      _verificando = true;
      _errorCodigo = null;
      _avisoCodigo = null;
    });
    try {
      await ApiClient.instance.post('/api/registro-cliente/reenviar-codigo', {'email': _emailCtrl.text.trim()});
      if (mounted) setState(() => _avisoCodigo = 'Si no pasó el último minuto, espera un poco: te enviamos un código nuevo (revisa también el spam).');
    } on ApiException catch (e) {
      if (mounted) setState(() => _errorCodigo = e.message);
    } catch (_) {
      if (mounted) setState(() => _errorCodigo = 'No se pudo conectar al servidor. Revisa tu conexión e intenta de nuevo.');
    } finally {
      if (mounted) setState(() => _verificando = false);
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
                child: !_enviado
                    ? _construirFormulario()
                    : (_pedirCodigo && !_correoVerificado)
                        ? _construirVerificacion()
                        : _construirConfirmacion(),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _construirVerificacion() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.mark_email_unread_outlined, color: GomaqColors.estadoPositivo, size: 56),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          child: const Text('Confirma tu correo',
              textAlign: TextAlign.center, style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        ),
        const SizedBox(height: 8),
        Text(
          'Te enviamos un código de 6 dígitos a ${_emailCtrl.text.trim()}. Escríbelo aquí para confirmar que el correo es tuyo. '
          'Tu solicitud ya quedó registrada.',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _codigoCtrl,
          keyboardType: TextInputType.number,
          maxLength: 7,
          autofocus: true,
          autofillHints: const [AutofillHints.oneTimeCode],
          onSubmitted: (_) => _verificarCodigo(),
          decoration: const InputDecoration(labelText: 'Código de 6 dígitos', border: OutlineInputBorder(), counterText: ''),
        ),
        if (_errorCodigo != null)
          Semantics(
            liveRegion: true,
            child: Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_errorCodigo!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
            ),
          ),
        if (_avisoCodigo != null)
          Semantics(
            liveRegion: true,
            child: Padding(padding: const EdgeInsets.only(top: 8), child: Text(_avisoCodigo!)),
          ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _verificando ? null : _verificarCodigo,
          child: _verificando
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Confirmar correo'),
        ),
        TextButton(onPressed: _verificando ? null : _reenviarCodigo, child: const Text('Enviar un código nuevo')),
        TextButton(
          onPressed: _verificando ? null : () => setState(() => _pedirCodigo = false),
          child: const Text('Confirmarlo después'),
        ),
      ],
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
        Text(
          '${_correoVerificado ? 'Tu correo quedó confirmado. ' : ''}GOMAQ revisará tu solicitud en horario hábil. Cuando esté aprobada podrás ingresar '
          'con este correo y esta contraseña. Si intentas entrar antes, verás que tu cuenta sigue en revisión.',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        FilledButton(onPressed: () => context.go('/login'), child: const Text('Volver al inicio de sesión')),
      ],
    );
  }

  /// Dos campos lado a lado cuando hay espacio; uno bajo el otro en un telefono, donde cada uno
  /// quedaria de unos 140 px y las etiquetas se cortarian.
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
          decoration: const InputDecoration(labelText: 'RUT de la empresa', helperText: 'Por ejemplo 76.123.456-0.', counterText: ''),
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
