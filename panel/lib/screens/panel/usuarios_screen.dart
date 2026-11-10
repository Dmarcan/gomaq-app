import 'dart:convert' show utf8;

import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/dialogos.dart';

class UsuariosScreen extends StatefulWidget {
  const UsuariosScreen({super.key});

  @override
  State<UsuariosScreen> createState() => _UsuariosScreenState();
}

class _UsuariosScreenState extends State<UsuariosScreen> {
  List<dynamic> _solicitudes = [];
  List<dynamic> _internos = [];
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
      final data = await ApiClient.instance.get('/api/usuarios/solicitudes');
      final usuarios = await ApiClient.instance.get('/api/usuarios');
      if (!mounted) return;
      setState(() {
        _solicitudes = data;
        // los clientes no reciben el aviso de mantencion: es operativo interno
        _internos = usuarios.where((u) => u['rol'] != 'cliente').toList();
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _vincularExistente(Map<String, dynamic> solicitud) async {
    List<dynamic> clientes = [];
    try {
      clientes = await ApiClient.instance.get('/api/clientes');
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      return;
    }

    int? clienteId;
    if (!mounted) return;
    final vinculada = await mostrarFormulario(
      context,
      icono: Icons.link,
      titulo: 'Vincular a un cliente',
      subtitulo: '${solicitud['nombre'] ?? 'Solicitud de cuenta'}',
      textoAccion: 'Vincular y activar',
      ancho: 440,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'La cuenta se activa y queda ligada a este cliente: solo verá sus equipos y sus órdenes.',
            style: TextStyle(fontSize: 13, color: Colors.black54),
          ),
          separadorCampos,
          DropdownMenuFormField<int>(
            expandedInsets: EdgeInsets.zero,
            enableFilter: true,
            requestFocusOnTap: true,
            label: const Text('Cliente *'),
            hintText: 'Busca por nombre',
            dropdownMenuEntries: [
              for (final c in clientes) DropdownMenuEntry<int>(value: c['id'] as int, label: '${c['nombre']}'),
            ],
            validator: (v) => v == null ? 'Elige el cliente al que se vincula la cuenta.' : null,
            onSelected: (v) => redibujar(() => clienteId = v),
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.post('/api/usuarios/solicitudes/${solicitud['id']}/aprobar', {'cliente_id': clienteId}),
    );
    if (vinculada && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cuenta activada')));
      _cargar();
    }
  }

  Future<void> _aprobar(int solicitudId, {int? clienteId}) async {
    try {
      await ApiClient.instance.post('/api/usuarios/solicitudes/$solicitudId/aprobar', {
        if (clienteId != null) 'cliente_id': clienteId,
      });
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cuenta activada')));
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Future<void> _rechazar(int solicitudId) async {
    final confirmado = await mostrarConfirmacion(
      context,
      titulo: '¿Rechazar esta solicitud de cuenta?',
      mensaje: 'La persona no podrá ingresar. Puede volver a postular más adelante con el mismo correo.',
      textoAccion: 'Rechazar solicitud',
      peligro: true,
    );
    if (!confirmado) return;
    try {
      await ApiClient.instance.post('/api/usuarios/solicitudes/$solicitudId/rechazar', {});
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  static const _rolesInternos = {
    'mecanico': 'Mecánico',
    'administrativo': 'Administrativo',
    'gerente': 'Gerente',
  };

  String _rolLegible(dynamic rol) => _rolesInternos[rol] ?? '$rol';

  /// Crea una cuenta interna. La contraseña la escribe quien crea la cuenta y se la entrega a la
  /// persona: no hay proveedor de correo para enviarla, y el sistema nunca la vuelve a mostrar.
  Future<void> _nuevaCuenta() async {
    final nombreCtrl = TextEditingController();
    final correoCtrl = TextEditingController();
    final claveCtrl = TextEditingController();
    final repetirCtrl = TextEditingController();
    String? rol;
    final creada = await mostrarFormulario(
      context,
      icono: Icons.person_add_alt_1,
      titulo: 'Nueva cuenta',
      subtitulo: 'Mecánico, administrativo o gerente',
      textoAccion: 'Crear cuenta',
      ancho: 460,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextFormField(
            controller: nombreCtrl,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: decoracionCampo('Nombre *'),
            validator: (v) => (v == null || v.trim().length < 2) ? 'Escribe el nombre de la persona.' : null,
          ),
          separadorCampos,
          TextFormField(
            controller: correoCtrl,
            keyboardType: TextInputType.emailAddress,
            decoration: decoracionCampo('Correo *', ayuda: 'Con este correo inicia sesión.'),
            validator: (v) {
              final t = (v ?? '').trim();
              return RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(t) ? null : 'Escribe un correo válido.';
            },
          ),
          separadorCampos,
          DropdownMenuFormField<String>(
            expandedInsets: EdgeInsets.zero,
            label: const Text('Rol *'),
            dropdownMenuEntries: [
              for (final e in _rolesInternos.entries) DropdownMenuEntry<String>(value: e.key, label: e.value),
            ],
            validator: (v) => v == null ? 'Elige el rol de la cuenta.' : null,
            onSelected: (v) => redibujar(() => rol = v),
          ),
          if (rol == 'gerente' || rol == 'administrativo')
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                rol == 'gerente'
                    ? 'El gerente puede valorizar reparaciones, cambiar las reglas de cobro y crear o desactivar cuentas.'
                    : 'El administrativo opera todo el panel y puede crear o desactivar cuentas.',
                style: const TextStyle(fontSize: 12, color: GomaqColors.advertenciaFuerte),
              ),
            ),
          separadorCampos,
          TextFormField(
            controller: claveCtrl,
            obscureText: true,
            decoration: decoracionCampo('Contraseña temporal *', ayuda: 'Mínimo 8 caracteres. Entrégasela en persona: el sistema no la envía ni la vuelve a mostrar.'),
            validator: (v) {
              final t = v ?? '';
              if (t.length < 8) return 'Mínimo 8 caracteres.';
              if (utf8.encode(t).length > 72) return 'Demasiado larga (máximo 72 bytes).';
              return null;
            },
          ),
          separadorCampos,
          TextFormField(
            controller: repetirCtrl,
            obscureText: true,
            decoration: decoracionCampo('Repetir contraseña *'),
            validator: (v) => v == claveCtrl.text ? null : 'Las contraseñas no coinciden.',
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.post('/api/usuarios', {
        'nombre': nombreCtrl.text.trim(),
        'email': correoCtrl.text.trim(),
        'rol': rol,
        'password': claveCtrl.text,
      }),
    );
    nombreCtrl.dispose();
    correoCtrl.dispose();
    claveCtrl.dispose();
    repetirCtrl.dispose();
    if (creada && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Cuenta creada. Entrégale la contraseña en persona: no se vuelve a mostrar.')),
      );
      _cargar();
    }
  }

  /// Restablece la contraseña de otra cuenta (la olvidó, o la cuenta está comprometida). No hay
  /// proveedor de correo: la escribe quien la restablece y se la entrega a la persona. Las sesiones
  /// que esa cuenta tenía abiertas se cierran.
  Future<void> _cambiarClave(Map<String, dynamic> usuario) async {
    final claveCtrl = TextEditingController();
    final repetirCtrl = TextEditingController();
    final hecho = await mostrarFormulario(
      context,
      icono: Icons.lock_reset,
      titulo: 'Restablecer contraseña',
      subtitulo: '${usuario['nombre']} · ${usuario['email']}',
      textoAccion: 'Restablecer',
      ancho: 440,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Su sesión actual se cierra y entra con la contraseña nueva. Entrégasela en persona: el sistema no la envía ni la vuelve a mostrar.',
            style: TextStyle(fontSize: 13, color: Colors.black54),
          ),
          separadorCampos,
          TextFormField(
            controller: claveCtrl,
            autofocus: true,
            obscureText: true,
            decoration: decoracionCampo('Contraseña nueva *', ayuda: 'Mínimo 8 caracteres.'),
            validator: (v) {
              final t = v ?? '';
              if (t.length < 8) return 'Mínimo 8 caracteres.';
              if (utf8.encode(t).length > 72) return 'Demasiado larga (máximo 72 bytes).';
              return null;
            },
          ),
          separadorCampos,
          TextFormField(
            controller: repetirCtrl,
            obscureText: true,
            decoration: decoracionCampo('Repetir contraseña *'),
            validator: (v) => v == claveCtrl.text ? null : 'Las contraseñas no coinciden.',
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.post('/api/usuarios/${usuario['id']}/password', {'password': claveCtrl.text}),
    );
    claveCtrl.dispose();
    repetirCtrl.dispose();
    if (hecho && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Contraseña restablecida. Entrégasela en persona: no se vuelve a mostrar.')),
      );
    }
  }

  /// Desactiva o reactiva una cuenta interna. Desactivada no puede iniciar sesión y su sesión
  /// vigente se corta en la siguiente petición. Los datos y las órdenes se conservan.
  Future<void> _cambiarEstado(Map<String, dynamic> usuario, {required bool activar}) async {
    if (!activar) {
      final confirmado = await mostrarConfirmacion(
        context,
        titulo: '¿Desactivar la cuenta de ${usuario['nombre']}?',
        mensaje:
            'No podrá iniciar sesión y su sesión actual se cierra. Sus órdenes y datos se conservan, y puedes reactivarla cuando quieras.',
        textoAccion: 'Desactivar cuenta',
        peligro: true,
      );
      if (!confirmado) return;
    }
    try {
      final actualizado = await ApiClient.instance.patch('/api/usuarios/${usuario['id']}/estado', {'activo': activar});
      if (!mounted) return;
      setState(() {
        final i = _internos.indexWhere((u) => u['id'] == usuario['id']);
        if (i != -1) _internos[i] = {..._internos[i] as Map<String, dynamic>, 'estado_cuenta': actualizado['estado_cuenta']};
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(activar ? 'Cuenta reactivada' : 'Cuenta desactivada')),
      );
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Widget _tarjetaCuentas() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    child: const Text('Cuentas del equipo', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  ),
                ),
                FilledButton.icon(
                  onPressed: _nuevaCuenta,
                  icon: const Icon(Icons.person_add_alt_1, size: 18),
                  label: const Text('Nueva cuenta'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Mecánicos, administrativos y gerentes. Una cuenta desactivada no puede entrar, pero conserva su historial.',
              style: TextStyle(fontSize: 13, color: Colors.grey[700]),
            ),
            const SizedBox(height: 8),
            if (_internos.isEmpty)
              const Text('No hay cuentas internas registradas')
            else
              ..._internos.map((u) {
                final activa = (u['estado_cuenta'] ?? 'activo') == 'activo';
                return ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(activa ? Icons.person_outline : Icons.person_off_outlined),
                  title: Text('${u['nombre']} · ${_rolLegible(u['rol'])}'),
                  // el estado va en texto y no solo en el icono (WCAG 1.4.1)
                  subtitle: Text(
                    activa ? '${u['email']}' : '${u['email']} · Desactivada',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: activa ? FontWeight.normal : FontWeight.w700,
                      color: activa ? null : GomaqColors.advertenciaFuerte,
                    ),
                  ),
                  trailing: Wrap(
                    spacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Semantics(
                        label: 'Restablecer contraseña de ${u['nombre']}',
                        excludeSemantics: true,
                        child: TextButton(onPressed: () => _cambiarClave(u), child: const Text('Contraseña')),
                      ),
                      if (activa)
                        TextButton(
                          onPressed: () => _cambiarEstado(u, activar: false),
                          child: Text('Desactivar', style: TextStyle(color: Theme.of(context).colorScheme.error)),
                        )
                      else
                        TextButton(onPressed: () => _cambiarEstado(u, activar: true), child: const Text('Reactivar')),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  Widget _dato(String etiqueta, String? valor) {
    if (valor == null || valor.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: RichText(
        text: TextSpan(
          style: const TextStyle(fontSize: 13, color: Colors.black87),
          children: [
            TextSpan(text: '$etiqueta: ', style: const TextStyle(fontWeight: FontWeight.w600)),
            TextSpan(text: valor),
          ],
        ),
      ),
    );
  }

  Future<void> _guardarAlertas(Map<String, dynamic> usuario, {bool? recibe, String? telefono}) async {
    try {
      final actualizado = await ApiClient.instance.patch('/api/usuarios/${usuario['id']}/alertas', {
        'recibe_alertas_mantencion': ?recibe,
        'telefono_whatsapp': ?telefono,
      });
      if (!mounted) return;
      setState(() {
        final i = _internos.indexWhere((u) => u['id'] == usuario['id']);
        if (i != -1) _internos[i] = actualizado;
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  Future<void> _editarWhatsapp(Map<String, dynamic> usuario) async {
    final ctrl = TextEditingController(text: usuario['telefono_whatsapp'] ?? '');
    final guardado = await mostrarFormulario(
      context,
      icono: Icons.chat,
      titulo: 'WhatsApp de ${usuario['nombre']}',
      subtitulo: 'Número al que llegan los avisos de mantención',
      textoAccion: 'Guardar número',
      ancho: 420,
      contenido: (context, redibujar) => TextFormField(
        controller: ctrl,
        autofocus: true,
        keyboardType: TextInputType.phone,
        decoration: decoracionCampo('Número', ayuda: 'Con código de país: +56 9 1234 5678. Déjalo en blanco para quitarlo.'),
        // vacío es válido: es la forma de quitar el número
        validator: (v) {
          if (v == null || v.trim().isEmpty) return null;
          final digitos = v.replaceAll(RegExp(r'[\s()-]'), '');
          return RegExp(r'^\+?\d{8,15}$').hasMatch(digitos) ? null : 'Escribe un número válido, por ejemplo +56 9 1234 5678.';
        },
      ),
      alGuardar: () async {
        final actualizado = await ApiClient.instance.patch('/api/usuarios/${usuario['id']}/alertas', {'telefono_whatsapp': ctrl.text.trim()});
        if (!mounted) return;
        setState(() {
          final i = _internos.indexWhere((u) => u['id'] == usuario['id']);
          if (i != -1) _internos[i] = actualizado;
        });
      },
    );
    ctrl.dispose();
    if (guardado && mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Número guardado')));
  }

  /// Quién recibe el aviso de mantención próxima. Se configura acá y no en el .env del
  /// servidor, para que cambiar el destinatario no exija entrar por SSH.
  Widget _tarjetaAlertas() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Alertas de mantención', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(
              'Quiénes reciben el aviso cuando un equipo queda a 50 h o menos de su mantención. '
              'Se envía por correo y, si hay número cargado, también por WhatsApp.',
              style: TextStyle(fontSize: 13, color: Colors.grey[700]),
            ),
            const SizedBox(height: 8),
            if (_internos.isEmpty)
              const Text('No hay usuarios internos registrados')
            else
              ..._internos.map((u) {
                final telefono = u['telefono_whatsapp'];
                return SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: u['recibe_alertas_mantencion'] == true,
                  onChanged: (v) => _guardarAlertas(u, recibe: v),
                  title: Text('${u['nombre']} · ${u['rol']}'),
                  subtitle: Row(
                    children: [
                      Expanded(
                        child: Text(
                          '${u['email']}${telefono == null || telefono.toString().isEmpty ? ' · sin WhatsApp' : ' · $telefono'}',
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                      TextButton(
                        onPressed: () => _editarWhatsapp(u),
                        child: const Text('WhatsApp', style: TextStyle(fontSize: 12)),
                      ),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text('Error: $_error'));

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        // +3: la tarjeta de cuentas, la de alertas de mantencion y el titulo de las solicitudes
        itemCount: _solicitudes.length + 3,
        itemBuilder: (context, index) {
          if (index == 0) return _tarjetaCuentas();
          if (index == 1) return _tarjetaAlertas();
          if (index == 2) {
            return Padding(
              padding: const EdgeInsets.only(top: 24, bottom: 8),
              child: Text(
                _solicitudes.isEmpty
                    ? 'No hay solicitudes de cuenta pendientes'
                    : 'Solicitudes de cuenta pendientes (${_solicitudes.length})',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              ),
            );
          }
          final i = index - 3;
          final s = _solicitudes[i];
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // las solicitudes anteriores a la migración 016 no traen el nombre de la empresa
                  Text(s['nombre_empresa'] ?? s['nombre_contacto'],
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  _dato('Contacto', s['nombre_contacto']),
                  _dato('Correo', s['email']),
                  _dato('RUT empresa', s['rut_empresa']),
                  _dato('WhatsApp', s['telefono_whatsapp']),
                  _dato('Horario de trabajo', s['horario_trabajo']),
                  _dato('Horario de colación', s['horario_colacion']),
                  _dato('Dirección', s['direccion']),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      FilledButton.icon(
                        onPressed: () => _aprobar(s['id']),
                        icon: const Icon(Icons.add_business, size: 16),
                        label: const Text('Crear cliente nuevo'),
                      ),
                      OutlinedButton.icon(
                        onPressed: () => _vincularExistente(s),
                        icon: const Icon(Icons.link, size: 16),
                        label: const Text('Vincular a cliente existente'),
                      ),
                      TextButton.icon(
                        onPressed: () => _rechazar(s['id']),
                        icon: const Icon(Icons.close, size: 16, color: GomaqColors.estadoNegativo),
                        label: const Text('Rechazar', style: TextStyle(color: GomaqColors.estadoNegativo)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
