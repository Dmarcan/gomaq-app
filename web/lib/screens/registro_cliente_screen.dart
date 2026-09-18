import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';

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

  bool _enviando = false;
  String? _error;
  bool _enviado = false;

  Future<void> _registrar() async {
    if (_nombreCtrl.text.trim().isEmpty || _empresaCtrl.text.trim().isEmpty ||
        _emailCtrl.text.trim().isEmpty || _passwordCtrl.text.isEmpty) {
      setState(() => _error = 'Completa tu nombre, el de la empresa, tu correo y una contraseña');
      return;
    }
    if (_passwordCtrl.text.length < 8) {
      setState(() => _error = 'La contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (_passwordCtrl.text != _confirmarCtrl.text) {
      setState(() => _error = 'Las contraseñas no coinciden');
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
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: Colors.black87),
      body: Center(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(32),
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
        const Text('Solicitud enviada', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        const Text(
          'Revisaremos tu solicitud de cuenta. Cuando esté aprobada podrás ingresar '
          'con este correo y contraseña.',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Volver al inicio de sesión')),
      ],
    );
  }

  Widget _construirFormulario() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Crear cuenta de Cliente', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        const Text(
          'Completa tus datos. Un administrador revisará tu solicitud antes de activar tu cuenta.',
          style: TextStyle(color: Colors.black54, fontSize: 13),
        ),
        const SizedBox(height: 20),
        TextField(controller: _nombreCtrl, decoration: const InputDecoration(labelText: 'Nombre de contacto')),
        const SizedBox(height: 12),
        TextField(controller: _emailCtrl, decoration: const InputDecoration(labelText: 'Correo electrónico'), keyboardType: TextInputType.emailAddress),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _passwordCtrl,
                decoration: const InputDecoration(labelText: 'Contraseña'),
                obscureText: true,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                controller: _confirmarCtrl,
                decoration: const InputDecoration(labelText: 'Confirmar'),
                obscureText: true,
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        const Text('DATOS DE LA EMPRESA QUE REPRESENTAS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        TextField(controller: _empresaCtrl, decoration: const InputDecoration(labelText: 'Nombre de la empresa')),
        const SizedBox(height: 12),
        TextField(controller: _rutCtrl, decoration: const InputDecoration(labelText: 'RUT de la empresa')),
        const SizedBox(height: 12),
        TextField(controller: _whatsappCtrl, decoration: const InputDecoration(labelText: 'Teléfono de contacto (WhatsApp)')),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _horarioTrabajoCtrl,
                decoration: const InputDecoration(labelText: 'Horario de trabajo', hintText: 'ej. 08:00-18:00'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                controller: _horarioColacionCtrl,
                decoration: const InputDecoration(labelText: 'Horario de colación', hintText: 'ej. 13:00-14:00'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(controller: _direccionCtrl, decoration: const InputDecoration(labelText: 'Dirección'), maxLines: 2),
        const SizedBox(height: 24),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Text(_error!, style: const TextStyle(color: Colors.red)),
          ),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _enviando ? null : _registrar,
            child: _enviando
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Enviar solicitud'),
          ),
        ),
      ],
    );
  }
}
