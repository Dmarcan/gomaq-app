import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import 'usuarios_screen.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/dialogos.dart';
import '../../utils/rut.dart';
import '../../utils/ubicacion.dart';
import '../../widgets/buscador_direccion.dart';
import '../../widgets/selector_plazo_pago.dart';

class ClientesScreen extends StatefulWidget {
  /// Pestaña con la que se abre: 'cuentas' (Cuentas por aprobar) llega desde el menú y el dashboard.
  final String? pestanaInicial;
  const ClientesScreen({super.key, this.pestanaInicial});

  @override
  State<ClientesScreen> createState() => _ClientesScreenState();
}

class _ClientesScreenState extends State<ClientesScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this, initialIndex: widget.pestanaInicial == 'cuentas' ? 1 : 0);
    // el título y el ítem del menú siguen a la pestaña: Cuentas por aprobar es /cuentas y Clientes /clientes
    _tabController.addListener(() {
      if (_tabController.indexIsChanging) return;
      final ruta = _tabController.index == 1 ? '/cuentas' : '/clientes';
      if (GoRouterState.of(context).uri.path != ruta) context.go(ruta);
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        // sin título: el marco del panel ya muestra el nombre de la sección justo arriba
        toolbarHeight: 0,
        bottom: TabBar(
          controller: _tabController,
          tabs: const [Tab(text: 'Clientes'), Tab(text: 'Cuentas por aprobar')],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: const [_ClientesListaBody(), UsuariosScreen()],
      ),
    );
  }
}

class _ClientesListaBody extends StatefulWidget {
  const _ClientesListaBody();

  @override
  State<_ClientesListaBody> createState() => _ClientesListaBodyState();
}

class _ClientesListaBodyState extends State<_ClientesListaBody> {
  List<dynamic> _clientes = [];
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
      final data = await ApiClient.instance.get('/api/clientes');
      if (!mounted) return;
      setState(() => _clientes = data);
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  /// Ubicación del cliente en el mapa: se escribe su dirección y se elige una sugerencia. Sirve al
  /// técnico para llegar y a la oficina para ver el equipo en el mapa. Solo cambia la ficha del
  /// cliente: las OT ya creadas conservan el destino con que se crearon.
  Future<void> _ubicarCliente(Map<String, dynamic> cliente) async {
    final lat = double.tryParse('${cliente['latitud']}');
    final lng = double.tryParse('${cliente['longitud']}');
    Coordenada? valor = (lat != null && lng != null) ? Coordenada(lat, lng) : null;
    final direccion = cliente['direccion']?.toString();
    final guardado = await mostrarFormulario(
      context,
      icono: Icons.place_outlined,
      titulo: 'Ubicación de ${cliente['nombre']}',
      subtitulo: 'Escribe la dirección y elige una sugerencia',
      textoAccion: 'Guardar ubicación',
      ancho: 520,
      contenido: (context, redibujar) => BuscadorDireccion(
        valor: valor,
        textoInicial: direccion,
        onChanged: (c) => redibujar(() => valor = c),
      ),
      alGuardar: () async {
        await ApiClient.instance.patch('/api/clientes/${cliente['id']}/ubicacion', {
          'latitud': valor?.latitud,
          'longitud': valor?.longitud,
        });
      },
    );
    if (guardado && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ubicación guardada')));
      await _cargar();
    }
  }

  /// Edita la ficha de un cliente existente. El correo de aquí es el de los avisos y las facturas: no es el
  /// correo con que la persona inicia sesión en el portal, que no se toca.
  Future<void> _editarCliente(Map<String, dynamic> c) async {
    final nombreCtrl = TextEditingController(text: c['nombre']?.toString() ?? '');
    final rutCtrl = TextEditingController(text: c['rut']?.toString() ?? '');
    final emailCtrl = TextEditingController(text: c['email']?.toString() ?? '');
    final telefonoCtrl = TextEditingController(text: c['telefono']?.toString() ?? '');
    final direccionCtrl = TextEditingController(text: c['direccion']?.toString() ?? '');
    final giroCtrl = TextEditingController(text: c['giro']?.toString() ?? '');
    // sin valor por defecto: un cliente cargado sin plazo obliga a elegirlo la primera vez que se edita
    int? plazo = c['plazo_pago_dias'] is int ? c['plazo_pago_dias'] as int : int.tryParse('${c['plazo_pago_dias'] ?? ''}');
    // vacío se envía como cadena vacía: el servidor lo guarda como "sin dato"
    String texto(TextEditingController x) => x.text.trim();
    final tieneCuenta = c['tiene_cuenta'] == true;

    final editado = await mostrarFormulario(
      context,
      icono: Icons.edit_outlined,
      titulo: 'Editar cliente',
      subtitulo: c['nombre']?.toString() ?? '',
      textoAccion: 'Guardar cambios',
      ancho: 520,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextFormField(
            controller: nombreCtrl,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: decoracionCampo('Nombre o razón social', obligatorio: true),
            validator: obligatorio('Escribe el nombre del cliente.'),
          ),
          separadorCampos,
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextFormField(
                  controller: rutCtrl,
                  decoration: decoracionCampo('RUT', ayuda: 'Por ejemplo 76.123.456-0.'),
                  validator: (v) => (v == null || v.trim().isEmpty || rutEsValido(v)) ? null : 'El RUT no es válido. Revisa el dígito verificador.',
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  controller: telefonoCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: decoracionCampo('Teléfono', ayuda: 'Con código de país: +56 9 1234 5678.'),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) return null;
                    final digitos = v.replaceAll(RegExp(r'[\s()-]'), '');
                    return RegExp(r'^\+?\d{8,15}$').hasMatch(digitos) ? null : 'Escribe un teléfono válido, por ejemplo +56 9 1234 5678.';
                  },
                ),
              ),
            ],
          ),
          separadorCampos,
          TextFormField(
            controller: emailCtrl,
            keyboardType: TextInputType.emailAddress,
            decoration: decoracionCampo('Correo para avisos y facturas', ayuda: 'No es el correo con que el cliente inicia sesión en el portal.'),
            validator: (v) => (v == null || v.trim().isEmpty || RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v.trim())) ? null : 'Escribe un correo válido, por ejemplo nombre@empresa.cl.',
          ),
          separadorCampos,
          TextFormField(
            controller: direccionCtrl,
            textCapitalization: TextCapitalization.sentences,
            decoration: decoracionCampo('Dirección'),
          ),
          separadorCampos,
          TextFormField(
            controller: giroCtrl,
            textCapitalization: TextCapitalization.sentences,
            decoration: decoracionCampo('Giro', ayuda: 'A qué se dedica la empresa.'),
          ),
          separadorCampos,
          SelectorPlazoPago(valor: plazo, onChanged: (v) => plazo = v),
          separadorCampos,
          LineaInfo(
            icono: tieneCuenta ? Icons.verified_user_outlined : Icons.person_off_outlined,
            texto: tieneCuenta
                ? 'Este cliente tiene una cuenta en el portal. Cambiar el correo de esta ficha no cambia su acceso.'
                : 'Este cliente todavía no tiene cuenta en el portal.',
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.patch('/api/clientes/${c['id']}', {
        'nombre': texto(nombreCtrl),
        'rut': texto(rutCtrl),
        'email': texto(emailCtrl),
        'telefono': texto(telefonoCtrl),
        'direccion': texto(direccionCtrl),
        'giro': texto(giroCtrl),
        'plazo_pago_dias': plazo,
      }),
    );
    for (final x in [nombreCtrl, rutCtrl, emailCtrl, telefonoCtrl, direccionCtrl, giroCtrl]) {
      x.dispose();
    }
    if (editado && mounted) {
      _cargar();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cliente actualizado')));
    }
  }

  Future<void> _abrirDialogoCrear() async {
    List<dynamic> ejecutivos = [];
    try {
      ejecutivos = await ApiClient.instance.get('/api/ejecutivos');
    } on ApiException catch (_) {
      // si falla la carga de ejecutivos igual se puede crear el cliente como "directo"
    }

    final nombreCtrl = TextEditingController();
    final rutCtrl = TextEditingController();
    final emailCtrl = TextEditingController();
    final telefonoCtrl = TextEditingController();
    final giroCtrl = TextEditingController();
    int? plazo; // sin valor por defecto: hay que elegirlo
    int? ejecutivoId;
    String? texto(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();

    if (!mounted) return;
    final creado = await mostrarFormulario(
      context,
      icono: Icons.person_add,
      titulo: 'Nuevo cliente',
      subtitulo: 'Empresa o persona a la que se arrienda',
      textoAccion: 'Crear cliente',
      ancho: 520,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextFormField(
            controller: nombreCtrl,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: decoracionCampo('Nombre o razón social', obligatorio: true),
            validator: obligatorio('Escribe el nombre del cliente.'),
          ),
          separadorCampos,
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextFormField(
                  controller: rutCtrl,
                  decoration: decoracionCampo('RUT', ayuda: 'Por ejemplo 76.123.456-0.'),
                  validator: (v) => (v == null || v.trim().isEmpty || rutEsValido(v)) ? null : 'El RUT no es válido. Revisa el dígito verificador.',
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  controller: telefonoCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: decoracionCampo('Teléfono', ayuda: 'Con código de país: +56 9 1234 5678.'),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) return null;
                    final digitos = v.replaceAll(RegExp(r'[\s()-]'), '');
                    return RegExp(r'^\+?\d{8,15}$').hasMatch(digitos) ? null : 'Escribe un teléfono válido, por ejemplo +56 9 1234 5678.';
                  },
                ),
              ),
            ],
          ),
          separadorCampos,
          TextFormField(
            controller: emailCtrl,
            keyboardType: TextInputType.emailAddress,
            decoration: decoracionCampo('Correo', ayuda: 'Ahí se le envían los avisos y las facturas.'),
            validator: (v) => (v == null || v.trim().isEmpty || RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v.trim())) ? null : 'Escribe un correo válido, por ejemplo nombre@empresa.cl.',
          ),
          separadorCampos,
          TextFormField(
            controller: giroCtrl,
            textCapitalization: TextCapitalization.sentences,
            decoration: decoracionCampo('Giro', ayuda: 'A qué se dedica la empresa.'),
          ),
          separadorCampos,
          SelectorPlazoPago(valor: plazo, onChanged: (v) => plazo = v),
          separadorCampos,
          DropdownButtonFormField<int?>(
            initialValue: ejecutivoId,
            isExpanded: true,
            decoration: decoracionCampo('Ejecutivo asignado'),
            items: [
              const DropdownMenuItem<int?>(value: null, child: Text('Directo (sin ejecutivo)')),
              for (final e in ejecutivos) DropdownMenuItem<int?>(value: e['id'], child: Text(e['nombre'])),
            ],
            onChanged: (v) => redibujar(() => ejecutivoId = v),
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.post('/api/clientes', {
        'nombre': nombreCtrl.text.trim(),
        'rut': texto(rutCtrl),
        'email': texto(emailCtrl),
        'telefono': texto(telefonoCtrl),
        'ejecutivo_id': ejecutivoId,
        'giro': texto(giroCtrl),
        'plazo_pago_dias': plazo,
      }),
    );
    for (final c in [nombreCtrl, rutCtrl, emailCtrl, telefonoCtrl, giroCtrl]) {
      c.dispose();
    }
    if (creado && mounted) {
      _cargar();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cliente creado')));
    }
  }

  /// Plazo habitual de pago en la lista. Sin plazo se marca con icono y texto, no solo con color.
  Widget _marcaPlazo(dynamic valor) {
    final dias = valor is int ? valor : int.tryParse('${valor ?? ''}');
    if (dias == null) {
      return const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.warning_amber_rounded, size: 18, color: GomaqColors.advertenciaFuerte),
          SizedBox(width: 6),
          Flexible(child: Text('Sin plazo de pago', style: TextStyle(color: GomaqColors.advertenciaFuerte, fontWeight: FontWeight.w600))),
        ],
      );
    }
    return Text('Plazo de pago: ${etiquetaPlazoPago(dias)}', style: TextStyle(color: Colors.grey.shade700));
  }

  @override
  Widget build(BuildContext context) {
    final puedeEscribir = context.watch<AuthService>().esAdministrativo || context.watch<AuthService>().esGerente;

    return Scaffold(
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nuevo cliente'),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? EstadoError(titulo: 'No se pudieron cargar los clientes', mensaje: _error!, onReintentar: _cargar)
                : _clientes.isEmpty
                    ? const EstadoVacio(
                        icono: Icons.people_outline,
                        titulo: 'Aún no hay clientes',
                        mensaje: 'Agrégalos con «Nuevo cliente», o aprueba las cuentas que las empresas '
                            'solicitan desde el portal en la pestaña «Cuentas por aprobar».',
                      )
                    : ListView.builder(
                    // abajo queda espacio para que el botón flotante no tape la última tarjeta
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 88),
                    itemCount: _clientes.length,
                    itemBuilder: (context, i) {
                      final c = _clientes[i];
                      final ubicado = c['latitud'] != null;
                      // los datos del cliente ocupan todo el ancho y la acción va debajo: a un lado,
                      // en un teléfono el botón se comía la mitad y partía el nombre y el correo
                      return Card(
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              // toda esta parte abre el historial del cliente (Tab y Enter o Espacio también)
                              Semantics(
                                button: true,
                                label: 'Ver historial de ${c['nombre']}',
                                excludeSemantics: true,
                                onTap: () => context.push('/clientes/${c['id']}'),
                                child: InkWell(
                                  borderRadius: BorderRadius.circular(8),
                                  onTap: () => context.push('/clientes/${c['id']}'),
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
                                    child: Row(
                                      children: [
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: [
                                              Text(c['nombre'].toString(), style: Theme.of(context).textTheme.titleMedium),
                                              const SizedBox(height: 2),
                                              Text(
                                                '${c['email'] ?? 'sin correo'} | ${c['telefono'] ?? 'sin teléfono'}',
                                                style: TextStyle(color: Colors.grey.shade700),
                                              ),
                                              if (c['giro'] != null) Text('Giro: ${c['giro']}', style: TextStyle(color: Colors.grey.shade700)),
                                              const SizedBox(height: 2),
                                              _marcaPlazo(c['plazo_pago_dias']),
                                            ],
                                          ),
                                        ),
                                        Icon(Icons.chevron_right, color: Colors.grey.shade600),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(height: 4),
                              Wrap(
                                alignment: WrapAlignment.spaceBetween,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(
                                        ubicado ? Icons.check_circle : Icons.location_off_outlined,
                                        size: 18,
                                        color: ubicado ? GomaqColors.estadoPositivo : GomaqColors.advertenciaFuerte,
                                      ),
                                      const SizedBox(width: 6),
                                      Text(ubicado ? 'Ubicación marcada' : 'Sin ubicación en el mapa'),
                                    ],
                                  ),
                                  if (puedeEscribir)
                                    TextButton.icon(
                                      onPressed: () => _editarCliente(Map<String, dynamic>.from(c as Map)),
                                      icon: const Icon(Icons.edit_outlined),
                                      label: const Text('Editar datos'),
                                    ),
                                  TextButton.icon(
                                    onPressed: () => _ubicarCliente(Map<String, dynamic>.from(c as Map)),
                                    icon: const Icon(Icons.place_outlined),
                                    label: Text(ubicado ? 'Cambiar ubicación' : 'Ubicar'),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
