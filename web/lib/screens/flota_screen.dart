import 'dart:async';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../widgets/estado_chip.dart';
import '../widgets/ficha_tecnica_campos.dart';
import 'maquinaria_perfil_screen.dart';

class FlotaScreen extends StatefulWidget {
  /// Filtro inicial recibido al llegar desde un número tocable del Dashboard,
  /// ej. {'disponibilidad': 'arrendados'} o {'estado': 'en_mantencion'}.
  /// Filtros que llegan por la URL (?estado=...&disponibilidad=...), para que el estado
  /// "Flota filtrada" sea compartible y sobreviva a un F5.
  final Map<String, String>? filtroInicial;
  const FlotaScreen({super.key, this.filtroInicial});

  @override
  State<FlotaScreen> createState() => _FlotaScreenState();
}

class _FlotaScreenState extends State<FlotaScreen> {
  List<dynamic> _maquinarias = [];
  bool _cargando = true;
  String? _error;
  String _busqueda = '';

  String? _filtroDisponibilidad;
  String? _filtroEstado;
  String? _filtroCategoria;
  String? _filtroCliente;
  String _orden = 'codigo';
  bool _filtrosExpandido = false;
  // paginacion en servidor: antes se bajaban los ~500 equipos y se filtraba en el panel
  static const _porPagina = 50;
  int _total = 0;
  bool _hayMas = false;
  bool _cargandoMas = false;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _filtroDisponibilidad = widget.filtroInicial?['disponibilidad'];
    _filtroEstado = widget.filtroInicial?['estado'];
    _filtrosExpandido = widget.filtroInicial != null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _cargar();
      _cargarClientes();
    });
  }

  int get _filtrosActivos =>
      [_filtroDisponibilidad, _filtroEstado, _filtroCategoria, _filtroCliente].where((f) => f != null).length;

  void _alternarFiltro(String grupo, String? valorActual, String valor) {
    setState(() {
      final nuevoValor = valorActual == valor ? null : valor;
      switch (grupo) {
        case 'disponibilidad':
          _filtroDisponibilidad = nuevoValor;
          break;
        case 'estado':
          _filtroEstado = nuevoValor;
          break;
        case 'categoria':
          _filtroCategoria = nuevoValor;
          break;
        case 'cliente':
          _filtroCliente = nuevoValor;
          break;
      }
    });
    // todos los filtros los resuelve el servidor
    _cargar();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  String _consulta({required int offset}) {
    final p = <String>['limit=$_porPagina', 'offset=$offset'];
    if (_busqueda.trim().isNotEmpty) p.add('q=${Uri.encodeQueryComponent(_busqueda.trim())}');
    if (_filtroEstado != null) p.add('estado=$_filtroEstado');
    if (_filtroCategoria != null) p.add('categoria=$_filtroCategoria');
    if (_filtroDisponibilidad != null) p.add('disponibilidad=$_filtroDisponibilidad');
    if (_filtroCliente != null) p.add('cliente_id=$_filtroCliente');
    return '/api/maquinarias?${p.join('&')}';
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get(_consulta(offset: 0));
      if (!mounted) return;
      setState(() {
        _maquinarias = data['items'];
        _total = data['total'] ?? 0;
        _hayMas = data['hay_mas'] == true;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _cargarMas() async {
    if (_cargandoMas || !_hayMas) return;
    setState(() => _cargandoMas = true);
    try {
      final data = await ApiClient.instance.get(_consulta(offset: _maquinarias.length));
      if (!mounted) return;
      setState(() {
        _maquinarias = [..._maquinarias, ...data['items']];
        _total = data['total'] ?? _total;
        _hayMas = data['hay_mas'] == true;
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoMas = false);
    }
  }

  /// La busqueda va al servidor, asi que se espera a que el usuario deje de escribir
  /// en vez de disparar una consulta por tecla.
  void _buscar(String texto) {
    setState(() => _busqueda = texto);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _cargar);
  }

  Future<void> _abrirDialogoCrear() async {
    final codigoCtrl = TextEditingController();
    final tipoCtrl = TextEditingController();
    final ubicacionCtrl = TextEditingController();
    final marcaCtrl = TextEditingController();
    final modeloCtrl = TextEditingController();
    final anioCtrl = TextEditingController();
    final descripcionCtrl = TextEditingController();
    final capacidadCargaCtrl = TextEditingController();
    final alturaTrabajoCtrl = TextEditingController();
    final numeroSerieCtrl = TextEditingController();
    final numeroMotorCtrl = TextEditingController();
    final numeroChasisCtrl = TextEditingController();
    final numeroMastilCtrl = TextEditingController();

    String? categoria;
    String? combustible;
    PlatformFile? foto;

    if (!mounted) return;
    final creado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          final mostrarFicha = categoria != null;

          return AlertDialog(
            title: const Text('Nueva maquinaria'),
            content: SizedBox(
              width: 420,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TextField(controller: codigoCtrl, decoration: const InputDecoration(labelText: 'Codigo (ej. GH-204)')),
                    TextField(controller: tipoCtrl, decoration: const InputDecoration(labelText: 'Tipo (ej. Grua Horquilla)')),
                    TextField(controller: ubicacionCtrl, decoration: const InputDecoration(labelText: 'Ubicacion (opcional)')),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: categoria,
                      decoration: const InputDecoration(labelText: 'Categoría (para la ficha técnica)'),
                      items: [for (final c in categoriasEquipo) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
                      onChanged: (v) => setDialogState(() {
                        // autocompleta "tipo" con la etiqueta de la categoria, salvo que el usuario
                        // ya haya escrito algo distinto al auto-relleno anterior (no se pisa su edicion)
                        final tipoActual = tipoCtrl.text.trim();
                        if (tipoActual.isEmpty || tipoActual == etiquetasCategoria[categoria]) {
                          tipoCtrl.text = v != null ? etiquetasCategoria[v]! : '';
                        }
                        categoria = v;
                      }),
                    ),
                    if (mostrarFicha) ...[
                      const SizedBox(height: 12),
                      const Text('FICHA TÉCNICA', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                      ...camposFichaTecnica(
                        categoria: categoria,
                        combustible: combustible,
                        onCombustibleChanged: (v) => setDialogState(() => combustible = v),
                        marcaCtrl: marcaCtrl,
                        modeloCtrl: modeloCtrl,
                        anioCtrl: anioCtrl,
                        capacidadCargaCtrl: capacidadCargaCtrl,
                        alturaTrabajoCtrl: alturaTrabajoCtrl,
                        numeroMastilCtrl: numeroMastilCtrl,
                        numeroMotorCtrl: numeroMotorCtrl,
                        numeroChasisCtrl: numeroChasisCtrl,
                        numeroSerieCtrl: numeroSerieCtrl,
                        descripcionCtrl: descripcionCtrl,
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: () async {
                          final resultado = await FilePicker.platform.pickFiles(
                            type: FileType.custom,
                            allowedExtensions: ['jpg', 'jpeg', 'png'],
                            withData: true,
                          );
                          if (resultado != null && resultado.files.single.bytes != null) {
                            setDialogState(() => foto = resultado.files.single);
                          }
                        },
                        icon: const Icon(Icons.image_outlined),
                        label: Text(foto?.name ?? 'Agregar foto (opcional)'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
              FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Crear')),
            ],
          );
        },
      ),
    );

    if (creado != true || codigoCtrl.text.trim().isEmpty || tipoCtrl.text.trim().isEmpty) return;
    try {
      await ApiClient.instance.postMultipart(
        '/api/maquinarias',
        bytes: foto?.bytes,
        filename: foto?.name,
        fields: {
          'codigo': codigoCtrl.text.trim(),
          'tipo': tipoCtrl.text.trim(),
          if (ubicacionCtrl.text.trim().isNotEmpty) 'ubicacion': ubicacionCtrl.text.trim(),
          if (categoria != null) 'categoria_equipo': categoria!,
          if (marcaCtrl.text.trim().isNotEmpty) 'marca': marcaCtrl.text.trim(),
          if (modeloCtrl.text.trim().isNotEmpty) 'modelo': modeloCtrl.text.trim(),
          if (anioCtrl.text.trim().isNotEmpty) 'anio': anioCtrl.text.trim(),
          if (descripcionCtrl.text.trim().isNotEmpty) 'descripcion': descripcionCtrl.text.trim(),
          if (capacidadCargaCtrl.text.trim().isNotEmpty) 'capacidad_carga': capacidadCargaCtrl.text.trim(),
          if (alturaTrabajoCtrl.text.trim().isNotEmpty) 'altura_trabajo': alturaTrabajoCtrl.text.trim(),
          if (numeroSerieCtrl.text.trim().isNotEmpty) 'numero_serie': numeroSerieCtrl.text.trim(),
          if (numeroMotorCtrl.text.trim().isNotEmpty) 'numero_motor': numeroMotorCtrl.text.trim(),
          if (numeroChasisCtrl.text.trim().isNotEmpty) 'numero_chasis': numeroChasisCtrl.text.trim(),
          if (numeroMastilCtrl.text.trim().isNotEmpty) 'numero_mastil': numeroMastilCtrl.text.trim(),
          'tipo_combustible': (categoria == 'transpaleta' || categoria == 'apilador') ? 'electrica' : (combustible ?? ''),
        },
      );
      _cargar();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      }
    }
  }

  /// Clientes para el filtro. Se piden aparte y NO se derivan de los equipos cargados:
  /// desde que la lista pagina, derivarlos solo mostraria los clientes de la primera pagina.
  List<dynamic> _clientes = [];

  Future<void> _cargarClientes() async {
    try {
      final data = await ApiClient.instance.get('/api/clientes');
      if (mounted) setState(() => _clientes = data);
    } on ApiException catch (_) {
      // el filtro por cliente queda sin opciones, pero la flota igual se ve
    }
  }

  /// Pie de la lista: cuantos equipos se ven de cuantos hay, y el boton para traer mas.
  Widget _pieDeLista(int mostrados) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        children: [
          Text(
            'Mostrando $mostrados de $_total equipos',
            style: const TextStyle(fontSize: 12, color: Colors.black54),
          ),
          if (_hayMas) ...[
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: _cargandoMas ? null : _cargarMas,
              child: Text(_cargandoMas ? 'Cargando...' : 'Cargar más'),
            ),
          ],
        ],
      ),
    );
  }

  List<dynamic> get _maquinariasFiltradas {
    // busqueda y filtros los resuelve el servidor; aca solo queda el orden de pantalla
    final filtradas = [..._maquinarias];

    filtradas.sort((a, b) {
      switch (_orden) {
        case 'estado':
          return (a['estado'] as String? ?? '').compareTo(b['estado'] as String? ?? '');
        case 'categoria':
          return (a['categoria_equipo'] as String? ?? '').compareTo(b['categoria_equipo'] as String? ?? '');
        default:
          return (a['codigo'] as String? ?? '').compareTo(b['codigo'] as String? ?? '');
      }
    });
    return filtradas;
  }

  @override
  Widget build(BuildContext context) {
    final puedeEscribir = context.watch<AuthService>().esAdministrativo;
    final maquinarias = _maquinariasFiltradas;

    return Scaffold(
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nueva maquinaria'),
            )
          : null,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    onChanged: _buscar,
                    decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search),
                      hintText: 'Buscar por código o tipo...',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: () => setState(() => _filtrosExpandido = !_filtrosExpandido),
                  icon: const Icon(Icons.filter_list, size: 18),
                  label: Text(_filtrosActivos > 0 ? 'Filtros ($_filtrosActivos)' : 'Filtros'),
                ),
                const SizedBox(width: 8),
                PopupMenuButton<String>(
                  icon: const Icon(Icons.sort),
                  tooltip: 'Ordenar',
                  onSelected: (v) => setState(() => _orden = v),
                  itemBuilder: (context) => const [
                    PopupMenuItem(value: 'codigo', child: Text('Ordenar por código')),
                    PopupMenuItem(value: 'estado', child: Text('Ordenar por estado')),
                    PopupMenuItem(value: 'categoria', child: Text('Ordenar por categoría')),
                  ],
                ),
              ],
            ),
          ),
          if (_filtrosExpandido)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      FilterChip(
                        label: const Text('Disponibles'),
                        selected: _filtroDisponibilidad == 'disponibles',
                        onSelected: (_) => _alternarFiltro('disponibilidad', _filtroDisponibilidad, 'disponibles'),
                      ),
                      FilterChip(
                        label: const Text('Arrendados'),
                        selected: _filtroDisponibilidad == 'arrendados',
                        onSelected: (_) => _alternarFiltro('disponibilidad', _filtroDisponibilidad, 'arrendados'),
                      ),
                      FilterChip(
                        label: const Text('Operativa'),
                        selected: _filtroEstado == 'operativa',
                        onSelected: (_) => _alternarFiltro('estado', _filtroEstado, 'operativa'),
                      ),
                      FilterChip(
                        label: const Text('En mantención'),
                        selected: _filtroEstado == 'en_mantencion',
                        onSelected: (_) => _alternarFiltro('estado', _filtroEstado, 'en_mantencion'),
                      ),
                      FilterChip(
                        label: const Text('Fuera de servicio'),
                        selected: _filtroEstado == 'fuera_de_servicio',
                        onSelected: (_) => _alternarFiltro('estado', _filtroEstado, 'fuera_de_servicio'),
                      ),
                      for (final c in categoriasEquipo)
                        FilterChip(
                          label: Text(c.etiqueta),
                          selected: _filtroCategoria == c.valor,
                          onSelected: (_) => _alternarFiltro('categoria', _filtroCategoria, c.valor),
                        ),
                      for (final c in _clientes)
                        FilterChip(
                          label: Text(c['nombre']),
                          selected: _filtroCliente == '${c['id']}',
                          onSelected: (_) => _alternarFiltro('cliente', _filtroCliente, '${c['id']}'),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _cargar,
              child: _cargando
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? Center(child: Text('Error: $_error'))
                      : maquinarias.isEmpty
                          ? const Center(child: Text('Sin resultados'))
                          : ListView.builder(
                              padding: const EdgeInsets.all(16),
                              // +1 por el pie: "cargar mas" o el conteo de lo que se muestra
                              itemCount: maquinarias.length + 1,
                              itemBuilder: (context, i) {
                                if (i == maquinarias.length) return _pieDeLista(maquinarias.length);
                                final m = maquinarias[i];
                                return Card(
                                  child: ListTile(
                                    leading: m['foto_url'] != null
                                        ? ClipRRect(
                                            borderRadius: BorderRadius.circular(6),
                                            child: Image.network(m['foto_url'], width: 44, height: 44, fit: BoxFit.cover),
                                          )
                                        : const CircleAvatar(child: Icon(Icons.precision_manufacturing)),
                                    title: Text('${m['codigo']} - ${m['tipo']}'),
                                    subtitle: Text('Cliente: ${m['cliente'] ?? '-'} | ${m['ubicacion'] ?? 'Sin ubicación'}'),
                                    trailing: EstadoChip(estado: m['estado']),
                                    onTap: () => Navigator.push(
                                      context,
                                      MaterialPageRoute(builder: (_) => MaquinariaPerfilScreen(maquinariaId: m['id'])),
                                    ),
                                  ),
                                );
                              },
                            ),
            ),
          ),
        ],
      ),
    );
  }
}
