import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/acciones_cuenta.dart';
import '../../widgets/codigo_cuenta_admin.dart';
import '../../widgets/dialogos.dart';
import '../../utils/invitaciones.dart';
import '../../utils/roles.dart';
import '../../widgets/estado_vacio.dart';

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
  bool _correoDisponible = false;
  String? _motivoSinCorreo;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  /// Si el canal correo está disponible (y si no, por qué). Si falla, se ofrece solo el canal manual.
  Future<(bool, String?)> _configCorreo() async {
    try {
      final c = await ApiClient.instance.get('/api/usuarios/invitaciones/config');
      return (c['correo_disponible'] == true, c['motivo'] as String?);
    } catch (_) {
      return (false, 'No se pudo consultar la configuración del correo.');
    }
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/usuarios/solicitudes');
      final usuarios = await ApiClient.instance.get('/api/usuarios');
      final config = await _configCorreo();
      if (!mounted) return;
      setState(() {
        _correoDisponible = config.$1;
        _motivoSinCorreo = config.$2;
        _solicitudes = data;
        // los clientes no reciben el aviso de mantencion: es operativo interno
        _internos = usuarios.where((u) => u['rol'] != 'cliente').toList();
      });
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _vincularExistente(Map<String, dynamic> solicitud) async {
    List<dynamic> clientes = [];
    try {
      clientes = await ApiClient.instance.get('/api/clientes');
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo cargar la lista de clientes: ${e.message}')));
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
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo activar la cuenta: ${e.message}')));
    }
  }

  /// Aprobar creando un cliente nuevo: crea la empresa y activa la cuenta, así que se confirma.
  Future<void> _crearClienteNuevo(Map<String, dynamic> solicitud) async {
    final empresa = solicitud['nombre_empresa'] ?? solicitud['nombre_contacto'];
    final confirmado = await mostrarConfirmacion(
      context,
      titulo: '¿Crear un cliente nuevo?',
      mensaje: 'Se creará el cliente $empresa y se activará la cuenta de ${solicitud['nombre_contacto']}, que podrá ingresar al portal.',
      textoAccion: 'Crear cliente',
    );
    if (!confirmado) return;
    await _aprobar(solicitud['id']);
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
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo rechazar la solicitud: ${e.message}')));
    }
  }

  String _rolLegible(dynamic rol) => nombreRol(rol);

  /// Invita una cuenta interna: nombre, correo y rol. Nunca la contraseña: la persona la elige al
  /// canjear el código, que le llega por correo o en un mensaje que se copia y se manda a mano.
  Future<void> _nuevaCuenta() async {
    final nombreCtrl = TextEditingController();
    final correoCtrl = TextEditingController();
    String? rol;
    String canal = _canalPorDefecto;
    Map<String, dynamic>? respuesta;
    final creada = await mostrarFormulario(
      context,
      icono: Icons.person_add_alt_1,
      titulo: 'Invitar una cuenta',
      subtitulo: 'Mecánico, administrativo o gerente',
      textoAccion: 'Invitar',
      ancho: 480,
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
            decoration: decoracionCampo(
              'Correo de acceso *',
              ayuda: 'Con este correo inicia sesión. Si la persona no tiene correo real, escribe uno que identifique su cuenta y usa "Copiar mensaje".',
            ),
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
              // solo un gerente puede crear otro gerente (el servidor también lo exige)
              for (final e in rolesInternos.entries)
                if (e.key != 'gerente' || context.read<AuthService>().rol == 'gerente')
                  DropdownMenuEntry<String>(value: e.key, label: e.value),
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
          SelectorCanalCodigo(
            canal: canal,
            correoDisponible: _correoDisponible,
            motivoSinCorreo: _motivoSinCorreo,
            alCambiar: (c) => redibujar(() => canal = c),
          ),
        ],
      ),
      alGuardar: () async {
        respuesta = Map<String, dynamic>.from(await ApiClient.instance.post('/api/usuarios/invitaciones', {
          'nombre': nombreCtrl.text.trim(),
          'email': correoCtrl.text.trim(),
          'rol': rol,
          'canal': canal,
        }));
      },
    );
    nombreCtrl.dispose();
    correoCtrl.dispose();
    final r = respuesta;
    if (!creada || r == null || !mounted) return;
    _cargar();
    final usuario = Map<String, dynamic>.from(r['usuario'] as Map);
    await _entregarCodigo(Map<String, dynamic>.from(r['invitacion'] as Map), usuario: usuario, invitacion: true);
  }

  String get _canalPorDefecto => _correoDisponible ? 'correo' : 'manual';

  /// Pide el canal y genera un código nuevo: invitación (cuenta pendiente) o restablecer (cuenta activa).
  Future<void> _nuevoCodigo(Map<String, dynamic> usuario, {required bool invitacion}) async {
    String canal = _canalPorDefecto;
    Map<String, dynamic>? respuesta;
    final hecho = await mostrarFormulario(
      context,
      icono: invitacion ? Icons.forward_to_inbox : Icons.lock_reset,
      titulo: invitacion ? 'Nuevo código de invitación' : 'Restablecer contraseña',
      subtitulo: '${usuario['nombre']} · ${usuario['email']}',
      textoAccion: 'Generar código',
      ancho: 460,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            invitacion
                ? 'El código anterior deja de servir. La persona activa su cuenta con este correo y el código nuevo.'
                : 'La persona elige una contraseña nueva con su correo de acceso y este código. Su contraseña actual '
                    'sigue sirviendo hasta que lo use; si la cuenta está comprometida, desactívala. '
                    'Si no tiene un correo real, "Olvidé mi contraseña" nunca le llegará: usa "Copiar mensaje".',
            style: const TextStyle(fontSize: 13, color: Colors.black54),
          ),
          separadorCampos,
          SelectorCanalCodigo(
            canal: canal,
            correoDisponible: _correoDisponible,
            motivoSinCorreo: _motivoSinCorreo,
            alCambiar: (c) => redibujar(() => canal = c),
          ),
        ],
      ),
      alGuardar: () async {
        respuesta = Map<String, dynamic>.from(await _pedirCodigo(usuario, invitacion: invitacion, canal: canal));
      },
    );
    final r = respuesta;
    if (!hecho || r == null || !mounted) return;
    if (invitacion) _cargar();
    await _entregarCodigo(r, usuario: usuario, invitacion: invitacion);
  }

  Future<dynamic> _pedirCodigo(Map<String, dynamic> usuario, {required bool invitacion, required String canal}) =>
      ApiClient.instance.post(
        invitacion ? '/api/usuarios/${usuario['id']}/invitacion' : '/api/usuarios/${usuario['id']}/codigo-restablecer',
        {'canal': canal},
      );

  /// Muestra el mensaje para copiar (canal manual) o avisa si el correo salió. Si el correo falló,
  /// ofrece generar un mensaje para copiar en su lugar.
  Future<void> _entregarCodigo(Map<String, dynamic> r, {required Map<String, dynamic> usuario, required bool invitacion}) async {
    final mensaje = r['mensaje'];
    if (mensaje is String) {
      await mostrarMensajeParaCopiar(
        context,
        titulo: invitacion ? 'Invitación lista para enviar' : 'Código para restablecer',
        mensaje: mensaje,
      );
      return;
    }
    if (r['enviado'] == true) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Código enviado a ${usuario['email']}')));
      return;
    }
    final copiar = await mostrarConfirmacion(
      context,
      titulo: 'No se pudo enviar el correo',
      mensaje: '${r['error'] ?? 'El correo no salió.'}\n\n¿Generar un mensaje para copiarlo y enviarlo a mano? El código del correo deja de servir.',
      textoAccion: 'Copiar mensaje',
    );
    if (!copiar || !mounted) return;
    try {
      final otro = Map<String, dynamic>.from(await _pedirCodigo(usuario, invitacion: invitacion, canal: 'manual'));
      if (mounted) await _entregarCodigo(otro, usuario: usuario, invitacion: invitacion);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo generar el código: ${e.message}')));
    }
  }

  /// Revoca una invitación que no se aceptó: la cuenta se borra (nunca pudo entrar).
  Future<void> _revocarInvitacion(Map<String, dynamic> usuario) async {
    final confirmado = await mostrarConfirmacion(
      context,
      titulo: '¿Revocar la invitación de ${usuario['nombre']}?',
      mensaje: 'El código deja de servir y la cuenta se elimina. Puedes volver a invitar ese correo cuando quieras.',
      textoAccion: 'Revocar invitación',
      peligro: true,
    );
    if (!confirmado) return;
    try {
      await ApiClient.instance.post('/api/usuarios/${usuario['id']}/invitacion/revocar', {});
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Invitación revocada')));
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo revocar la invitación: ${e.message}')));
    }
  }

  /// Desactiva o reactiva una cuenta interna. Desactivada no puede iniciar sesión y su sesión
  /// vigente se corta en la siguiente petición. Los datos y las órdenes se conservan.
  Future<void> _cambiarEstado(Map<String, dynamic> usuario, {required bool activar}) async {
    if (activar) {
      final confirmado = await mostrarConfirmacion(
        context,
        titulo: '¿Reactivar la cuenta de ${usuario['nombre']}?',
        mensaje: 'Podrá volver a iniciar sesión con su contraseña actual.',
        textoAccion: 'Reactivar cuenta',
      );
      if (!confirmado || !mounted) return;
    }
    if (!activar) {
      final aviso = avisoOtAbiertas(usuario['ot_abiertas']);
      final confirmado = await mostrarConfirmacion(
        context,
        titulo: '¿Desactivar la cuenta de ${usuario['nombre']}?',
        mensaje:
            'No podrá iniciar sesión y su sesión actual se cierra. Sus órdenes y datos se conservan, y puedes reactivarla cuando quieras.'
            '${aviso == null ? '' : '\n\n$aviso'}',
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
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo cambiar el estado de la cuenta: ${e.message}')));
    }
  }

  Widget _tarjetaCuentas() {
    final miId = context.watch<AuthService>().id;
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
                  label: const Text('Invitar cuenta'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Mecánicos, administrativos y gerentes. Cada persona elige su contraseña con el código de su invitación. '
              'Una cuenta desactivada no puede entrar, pero conserva su historial.',
              style: TextStyle(fontSize: 13, color: Colors.grey[700]),
            ),
            const SizedBox(height: 8),
            if (_internos.isEmpty)
              const Text('No hay cuentas internas registradas')
            else
              ..._internos.map((u) {
                final activa = (u['estado_cuenta'] ?? 'activo') == 'activo';
                final pendiente = u['estado_cuenta'] == 'pendiente';
                final invitacion = u['invitacion'] is Map ? Map<String, dynamic>.from(u['invitacion'] as Map) : null;
                final destacar = !activa && (!pendiente || invitacionRequiereAccion(invitacion));
                return ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(activa
                      ? Icons.person_outline
                      : pendiente
                          ? Icons.mark_email_unread_outlined
                          : Icons.person_off_outlined),
                  title: Text('${u['nombre']} · ${_rolLegible(u['rol'])}'),
                  // el estado va en texto y no solo en el icono (WCAG 1.4.1)
                  subtitle: Text(
                    activa
                        ? '${u['email']}'
                        : pendiente
                            ? '${u['email']} · ${textoEstadoInvitacion(invitacion)}'
                            : '${u['email']} · Desactivada',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: activa ? FontWeight.normal : FontWeight.w700,
                      color: destacar ? GomaqColors.advertenciaFuerte : null,
                    ),
                  ),
                  trailing: AccionesCuentaEquipo(
                    usuario: u,
                    esPropia: miId != null && '${u['id']}' == '$miId',
                    onClave: () => _nuevoCodigo(u, invitacion: false),
                    onDesactivar: () => _cambiarEstado(u, activar: false),
                    onReactivar: () => _cambiarEstado(u, activar: true),
                    onNuevaInvitacion: () => _nuevoCodigo(u, invitacion: true),
                    onRevocar: () => _revocarInvitacion(u),
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
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudieron guardar las alertas: ${e.message}')));
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
                  title: Text('${u['nombre']} · ${_rolLegible(u['rol'])}'),
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
    if (_error != null) return EstadoError(titulo: 'No se pudieron cargar las cuentas', mensaje: _error!, onReintentar: _cargar);

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        // +3: el titulo de las solicitudes (primero), y al final la tarjeta de cuentas y la de alertas
        itemCount: _solicitudes.length + 3,
        itemBuilder: (context, index) {
          if (index == _solicitudes.length + 1) return _tarjetaCuentas();
          if (index == _solicitudes.length + 2) return _tarjetaAlertas();
          if (index == 0) {
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                _solicitudes.isEmpty
                    ? 'No hay solicitudes de cuenta pendientes'
                    : 'Solicitudes de cuenta pendientes (${_solicitudes.length})',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              ),
            );
          }
          final i = index - 1;
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
                        onPressed: () => _crearClienteNuevo(s),
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
