import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import 'usuarios_screen.dart';
import '../widgets/estado_vacio.dart';

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

    if (!mounted) return;
    final creado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Nuevo cliente'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: nombreCtrl, decoration: const InputDecoration(labelText: 'Nombre / Razon social')),
                TextField(controller: rutCtrl, decoration: const InputDecoration(labelText: 'RUT (opcional)')),
                TextField(controller: emailCtrl, decoration: const InputDecoration(labelText: 'Email (opcional)')),
                TextField(controller: telefonoCtrl, decoration: const InputDecoration(labelText: 'Telefono (opcional, formato +569...)')),
                DropdownButtonFormField<int?>(
                  initialValue: ejecutivoId,
                  decoration: const InputDecoration(labelText: 'Ejecutivo asignado'),
                  items: [
                    const DropdownMenuItem<int?>(value: null, child: Text('Directo (sin ejecutivo)')),
                    for (final e in ejecutivos) DropdownMenuItem<int?>(value: e['id'], child: Text(e['nombre'])),
                  ],
                  onChanged: (v) => setDialogState(() => ejecutivoId = v),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Crear')),
          ],
        ),
      ),
    );

    if (creado != true) return;
    try {
      await ApiClient.instance.post('/api/clientes', {
        'nombre': nombreCtrl.text.trim(),
        'rut': rutCtrl.text.trim().isEmpty ? null : rutCtrl.text.trim(),
        'email': emailCtrl.text.trim().isEmpty ? null : emailCtrl.text.trim(),
        'telefono': telefonoCtrl.text.trim().isEmpty ? null : telefonoCtrl.text.trim(),
        'ejecutivo_id': ejecutivoId,
      });
      _cargar();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      }
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
