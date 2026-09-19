import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import 'usuarios_screen.dart';
import '../widgets/estado_vacio.dart';
import '../widgets/dialogos.dart';
import '../utils/rut.dart';

class ClientesScreen extends StatefulWidget {
  const ClientesScreen({super.key});

  @override
  State<ClientesScreen> createState() => _ClientesScreenState();
}

class _ClientesScreenState extends State<ClientesScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
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
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
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
                  decoration: decoracionCampo('RUT', ayuda: 'Por ejemplo 76.123.456-7.'),
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
      }),
    );
    for (final c in [nombreCtrl, rutCtrl, emailCtrl, telefonoCtrl]) {
      c.dispose();
    }
    if (creado && mounted) {
      _cargar();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cliente creado')));
    }
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
                ? Center(child: Text('Error: $_error'))
                : _clientes.isEmpty
                    ? const EstadoVacio(
                        icono: Icons.people_outline,
                        titulo: 'Aún no hay clientes',
                        mensaje: 'Agrégalos con «Nuevo cliente», o aprueba las cuentas que las empresas '
                            'solicitan desde el portal en la pestaña «Cuentas por aprobar».',
                      )
                    : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _clientes.length,
                    itemBuilder: (context, i) {
                      final c = _clientes[i];
                      return Card(
                        child: ListTile(
                          title: Text(c['nombre']),
                          subtitle: Text('${c['email'] ?? 'sin correo'} | ${c['telefono'] ?? 'sin teléfono'}'),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
