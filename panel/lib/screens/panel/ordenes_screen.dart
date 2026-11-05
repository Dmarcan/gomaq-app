import 'dart:async';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../widgets/asignar_mecanico.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/pestanas.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_vacio.dart';

// El detalle vive en orden_detalle.dart; se reexporta porque Facturación lo abre desde aquí.
export 'orden_detalle.dart' show abrirDetalleOrden;

/// Pestañas de la lista (los conteos salen de GET /ordenes-trabajo/resumen).
const pestanasOrdenes = <({String id, String etiqueta})>[
  (id: 'sin_asignar', etiqueta: 'Sin asignar'),
  (id: 'en_curso', etiqueta: 'En curso'),
  (id: 'finalizadas', etiqueta: 'Finalizadas'),
  (id: 'todas', etiqueta: 'Todas'),
];

const _estadosEnCurso = 'asignada,aceptada,en_camino,en_terreno,en_reparacion';

/// Parámetros de consulta de cada pestaña. `todas` admite además un filtro por estado.
Map<String, String> consultaPestanaOrdenes(String pestana, {String? estado}) {
  switch (pestana) {
    case 'sin_asignar':
      return {'sin_asignar': '1', 'dir': 'asc'};
    case 'en_curso':
      return {'estado': _estadosEnCurso};
    case 'finalizadas':
      return {'estado': 'finalizada'};
    default:
      return {'estado': ?estado};
  }
}

/// Suma la página nueva a lo ya cargado sin repetir órdenes: si entre dos páginas entra o sale una
/// orden, el desplazamiento por `offset` podría traer dos veces la misma.
List<dynamic> mezclarPaginaOrdenes(List<dynamic> existentes, List<dynamic> nuevas) {
  final vistos = {for (final o in existentes) (o as Map)['id']};
  return [
    ...existentes,
    for (final o in nuevas)
      if (vistos.add((o as Map)['id'])) o,
  ];
}

/// Antigüedad de una orden en palabras: "hace 3 h", "hace 2 días".
String antiguedadOrden(dynamic fecha, {DateTime? ahora}) {
  final f = DateTime.tryParse('$fecha')?.toLocal();
  if (f == null) return '-';
  final d = (ahora ?? DateTime.now()).difference(f);
  if (d.inMinutes < 1) return 'ahora';
  if (d.inMinutes < 60) return 'hace ${d.inMinutes} min';
  if (d.inHours < 24) return 'hace ${d.inHours} h';
  final dias = d.inDays;
  return dias == 1 ? 'hace 1 día' : 'hace $dias días';
}

class OrdenesScreen extends StatefulWidget {
  /// Abre el formulario de nueva OT al entrar (el botón del Dashboard llega con ?nueva=1).
  final bool abrirNueva;

  /// Equipo con el que se abre el formulario de nueva orden (desde el perfil del equipo).
  final int? maquinariaInicial;

  /// Pestaña con la que se abre (?pestana=): sin_asignar, en_curso, finalizadas o todas.
  final String? pestanaInicial;
  const OrdenesScreen({super.key, this.abrirNueva = false, this.maquinariaInicial, this.pestanaInicial});

  @override
  State<OrdenesScreen> createState() => _OrdenesScreenState();
}

class _OrdenesScreenState extends State<OrdenesScreen> {
  static const _porPagina = 50;

  List<dynamic> _ordenes = [];
  bool _cargando = true;
  bool _cargandoMas = false;
  bool _hayMas = false;
  int _total = 0;
  String? _error;
  Map<String, dynamic>? _resumen;

  late String _pestana = _pestanaValida(widget.pestanaInicial);

  // Búsqueda y filtro: la API ya los soportaba, pero la pantalla no los ofrecía
  String _busqueda = '';
  String? _estadoFiltro;
  Timer? _esperaBusqueda;

  // Cada carga de la lista lleva su número: una respuesta vieja (la pestaña cambió, o se buscó otra
  // cosa mientras llegaba) no pisa la lista, el error ni el indicador de la carga más reciente.
  int _generacion = 0;

  static const _estados = ['pendiente', 'asignada', 'aceptada', 'en_camino', 'en_terreno', 'en_reparacion', 'finalizada'];

  static String _pestanaValida(String? p) => pestanasOrdenes.any((x) => x.id == p) ? p! : 'todas';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _recargarTodo();
      if (widget.abrirNueva) {
        // se quita ?nueva=1 de la URL: si quedara, refrescar o recargar la página volvería a
        // abrir el formulario y un clic distraído crearía una OT duplicada
        // el equipo se lee antes de limpiar la URL: al cambiarla la pantalla se reconstruye con
        // maquinariaInicial en null, y el formulario abriria sin el equipo elegido
        final maquinaria = widget.maquinariaInicial;
        context.go('/ordenes?pestana=$_pestana');
        _abrirDialogoCrear(maquinariaInicial: maquinaria);
      }
    });
  }

  @override
  void didUpdateWidget(OrdenesScreen anterior) {
    super.didUpdateWidget(anterior);
    // la pestaña viene de la URL: un enlace del Dashboard o el clic en una pestaña la cambian
    final nueva = _pestanaValida(widget.pestanaInicial);
    if (widget.pestanaInicial != anterior.pestanaInicial && nueva != _pestana) {
      setState(() {
        _pestana = nueva;
        if (nueva != 'todas') _estadoFiltro = null;
      });
      _recargarTodo();
    }
  }

  @override
  void dispose() {
    _esperaBusqueda?.cancel();
    super.dispose();
  }

  void _buscar(String texto) {
    _esperaBusqueda?.cancel();
    _esperaBusqueda = Timer(const Duration(milliseconds: 350), () {
      _busqueda = texto.trim();
      _cargar();
    });
  }

  Future<void> _recargarTodo() async {
    await Future.wait([_cargar(), _cargarResumen()]);
  }

  /// Conteos de las pestañas. Si falla, las pestañas quedan sin número: la lista sigue sirviendo.
  Future<void> _cargarResumen() async {
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo/resumen');
      if (mounted && data is Map) setState(() => _resumen = Map<String, dynamic>.from(data));
    } catch (_) {}
  }

  String _consulta({required int offset}) {
    final params = <String, String>{
      'limit': '$_porPagina',
      'offset': '$offset',
      if (_busqueda.isNotEmpty) 'q': _busqueda,
      ...consultaPestanaOrdenes(_pestana, estado: _estadoFiltro),
    };
    return '?${Uri(queryParameters: params).query}';
  }

  Future<void> _cargar() async {
    final gen = ++_generacion;
    setState(() {
      _cargando = true;
      _cargandoMas = false;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo${_consulta(offset: 0)}');
      if (!mounted || gen != _generacion) return;
      setState(() {
        _ordenes = data['items'] as List;
        _total = (data['total'] as num?)?.toInt() ?? _ordenes.length;
        _hayMas = data['hay_mas'] == true;
      });
    } catch (e) {
      if (mounted && gen == _generacion) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted && gen == _generacion) setState(() => _cargando = false);
    }
  }

  Future<void> _cargarMas() async {
    final gen = _generacion;
    setState(() => _cargandoMas = true);
    try {
      final data = await ApiClient.instance.get('/api/ordenes-trabajo${_consulta(offset: _ordenes.length)}');
      if (!mounted || gen != _generacion) return;
      setState(() {
        _ordenes = mezclarPaginaOrdenes(_ordenes, data['items'] as List);
        _hayMas = data['hay_mas'] == true;
      });
    } catch (e) {
      if (mounted && gen == _generacion) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudieron cargar más órdenes. ${mensajeErrorCarga(e)}')));
      }
    } finally {
      if (mounted && gen == _generacion) setState(() => _cargandoMas = false);
    }
  }

  void _elegirPestana(String id) {
    if (id == _pestana) return;
    context.go('/ordenes?pestana=$id');
  }

  int? _conteo(String id) {
    final r = _resumen;
    if (r == null) return null;
    final v = id == 'finalizadas' ? r['finalizadas'] : r[id];
    return (v as num?)?.toInt();
  }

  Future<void> _abrirDialogoCrear({int? maquinariaInicial}) async {
    List<dynamic> maquinarias = [];
    try {
      maquinarias = (await ApiClient.instance.get('/api/maquinarias'))['items'];
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      return;
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No hubo respuesta del servidor. Revisa tu conexión e intenta de nuevo.')));
      }
      return;
    }

    int? maquinariaId = maquinarias.any((m) => m['id'] == maquinariaInicial) ? maquinariaInicial : null;
    final motivoCtrl = TextEditingController();

    if (!mounted) return;
    final creada = await mostrarFormulario(
      context,
      icono: Icons.assignment_add,
      titulo: 'Nueva orden de trabajo',
      subtitulo: 'Trabajo a hacer en un equipo',
      textoAccion: 'Crear orden',
      contenido: (context, redibujar) {
        final equipo = maquinarias.cast<Map<String, dynamic>?>().firstWhere((m) => m!['id'] == maquinariaId, orElse: () => null);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DropdownMenuFormField<int>(
              initialSelection: maquinariaId,
              expandedInsets: EdgeInsets.zero,
              enableFilter: true,
              requestFocusOnTap: true,
              label: const Text('Equipo *'),
              hintText: 'Busca por código o tipo',
              dropdownMenuEntries: [
                for (final m in maquinarias) DropdownMenuEntry<int>(value: m['id'] as int, label: '${m['codigo']} · ${m['tipo']}'),
              ],
              validator: (v) => v == null ? 'Elige el equipo de la orden.' : null,
              onSelected: (v) => redibujar(() => maquinariaId = v),
            ),
            if (equipo != null) ...[
              const SizedBox(height: 10),
              // el cliente no se pregunta: la base ya sabe quién tiene el equipo, y el servidor
              // lo copia a la orden al crearla
              LineaInfo(
                icono: Icons.business,
                texto: equipo['cliente'] != null ? 'Cliente: ${equipo['cliente']}' : 'Sin cliente: es una mantención interna',
              ),
            ],
            separadorCampos,
            TextFormField(
              controller: motivoCtrl,
              minLines: 2,
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
              decoration: decoracionCampo('Motivo', obligatorio: true, ayuda: 'Qué falla o qué trabajo se pide.'),
              validator: obligatorio('Escribe el motivo de la orden.'),
            ),
          ],
        );
      },
      alGuardar: () => ApiClient.instance.post('/api/ordenes-trabajo', {
        'maquinaria_id': maquinariaId,
        'motivo': motivoCtrl.text.trim(),
      }),
    );
    motivoCtrl.dispose();
    if (creada && mounted) {
      _recargarTodo();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Orden de trabajo creada')));
    }
  }

  Future<void> _abrirDetalle(Map<String, dynamic> orden) async {
    // push y no go: el botón Volver de la página regresa a esta lista con su pestaña. Al volver se
    // recargan la lista y los conteos: en el detalle se pudo asignar, valorizar o facturar.
    await context.push('/ordenes/${orden['id']}');
    if (mounted) _recargarTodo();
  }

  Future<void> _asignar(Map<String, dynamic> orden) async {
    if (await abrirAsignarMecanico(context, orden)) _recargarTodo();
  }

  Widget _estadoDeLaLista() {
    final filtrando = _busqueda.isNotEmpty || _estadoFiltro != null;
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return EstadoError(titulo: 'No se pudieron cargar las órdenes', mensaje: _error!, onReintentar: _recargarTodo);
    }
    if (_ordenes.isEmpty) {
      if (_pestana == 'sin_asignar' && !filtrando) {
        return const EstadoVacio(
          icono: Icons.task_alt,
          titulo: 'No hay órdenes por asignar',
          mensaje: 'Todas las órdenes ya tienen mecánico.',
        );
      }
      return EstadoVacio(
        icono: Icons.assignment_outlined,
        titulo: !filtrando && _pestana == 'todas' ? 'Aún no hay órdenes de trabajo' : 'No hay órdenes que mostrar',
        mensaje: !filtrando && _pestana == 'todas' ? 'Crea la primera con «Nueva OT».' : 'Prueba con otra pestaña, otro texto o quita el filtro de estado.',
      );
    }
    return LayoutBuilder(
      builder: (context, c) {
        final puedeAsignar = context.watch<AuthService>().esAdministrativo && _pestana == 'sin_asignar';
        // con la columna del botón Asignar la tabla necesita más ancho: entre 600 y 800 px el estado
        // quedaba aplastado, así que hasta 800 se muestran tarjetas
        final tabla = c.maxWidth >= (puedeAsignar ? 800 : 600);
        return RefreshIndicator(
          onRefresh: _recargarTodo,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text('$_total ${_total == 1 ? 'orden' : 'órdenes'}', style: const TextStyle(color: Colors.black54)),
              ),
              if (tabla) _EncabezadoTabla(conAccion: puedeAsignar),
              for (final o in _ordenes)
                tabla
                    ? _FilaTabla(orden: o as Map<String, dynamic>, onTap: () => _abrirDetalle(o), onAsignar: puedeAsignar ? () => _asignar(o) : null)
                    : _TarjetaOrden(orden: o as Map<String, dynamic>, onTap: () => _abrirDetalle(o), onAsignar: puedeAsignar ? () => _asignar(o) : null),
              if (_hayMas)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Center(
                    child: OutlinedButton(
                      onPressed: _cargandoMas ? null : _cargarMas,
                      child: Text(_cargandoMas ? 'Cargando...' : 'Cargar más'),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final puedeCrear = auth.esAdministrativo || auth.esGerente;

    return Scaffold(
      floatingActionButton: puedeCrear
          ? FloatingActionButton.extended(onPressed: _abrirDialogoCrear, icon: const Icon(Icons.add), label: const Text('Nueva OT'))
          : null,
      body: Column(
        children: [
          Pestanas(
            items: [for (final x in pestanasOrdenes) (id: x.id, etiqueta: x.etiqueta, cantidad: _conteo(x.id))],
            seleccionada: _pestana,
            onSeleccionar: _elegirPestana,
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: LayoutBuilder(
              builder: (context, caja) {
                final buscador = TextField(
                  onChanged: _buscar,
                  decoration: InputDecoration(
                    prefixIcon: const Icon(Icons.search),
                    hintText: caja.maxWidth < 600 ? 'Equipo, cliente o motivo' : 'Buscar por equipo, cliente o motivo...',
                    isDense: true,
                  ),
                );
                final selector = DropdownButton<String?>(
                  value: _estadoFiltro,
                  isExpanded: caja.maxWidth < 600,
                  hint: const Text('Todos los estados'),
                  items: [
                    const DropdownMenuItem<String?>(value: null, child: Text('Todos los estados')),
                    for (final e in _estados) DropdownMenuItem<String?>(value: e, child: Text(GomaqColors.etiquetaEstado(e))),
                  ],
                  onChanged: (v) {
                    setState(() => _estadoFiltro = v);
                    _cargar();
                  },
                );
                final conSelector = _pestana == 'todas';
                // Bajo 600 px el selector va debajo del buscador: al lado le dejaba unos 150 px al
                // texto y el aviso de qué se busca quedaba cortado.
                if (caja.maxWidth < 600) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [buscador, if (conSelector) ...[const SizedBox(height: 8), selector]],
                  );
                }
                return Row(
                  children: [
                    Expanded(child: buscador),
                    if (conSelector) ...[const SizedBox(width: 12), selector],
                  ],
                );
              },
            ),
          ),
          Expanded(child: _estadoDeLaLista()),
        ],
      ),
    );
  }
}

const _anchosColumnas = <int>[2, 3, 4, 3, 3, 2];

class _EncabezadoTabla extends StatelessWidget {
  final bool conAccion;
  const _EncabezadoTabla({required this.conAccion});

  @override
  Widget build(BuildContext context) {
    const estilo = TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.black54);
    const titulos = ['OT', 'Equipo', 'Cliente', 'Estado', 'Mecánico', 'Antigüedad'];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          for (var i = 0; i < titulos.length; i++) Expanded(flex: _anchosColumnas[i], child: Text(titulos[i], style: estilo)),
          if (conAccion) const SizedBox(width: 96),
        ],
      ),
    );
  }
}

class _FilaTabla extends StatelessWidget {
  final Map<String, dynamic> orden;
  final VoidCallback onTap;
  final VoidCallback? onAsignar;
  const _FilaTabla({required this.orden, required this.onTap, this.onAsignar});

  @override
  Widget build(BuildContext context) {
    final o = orden;
    Widget celda(int i, Widget hijo) => Expanded(flex: _anchosColumnas[i], child: Padding(padding: const EdgeInsets.only(right: 8), child: hijo));
    Text texto(dynamic v) => Text(v == null || '$v'.isEmpty ? '-' : '$v', maxLines: 2, overflow: TextOverflow.ellipsis);
    return Card(
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            children: [
              celda(0, Text('#${o['id']}', style: const TextStyle(fontWeight: FontWeight.w700))),
              celda(1, texto(o['maquinaria_codigo'])),
              celda(2, texto(o['cliente_nombre'])),
              celda(3, Align(alignment: Alignment.centerLeft, child: EstadoChip(estado: o['estado']))),
              celda(4, texto(o['mecanico_nombre'] ?? 'Sin asignar')),
              celda(5, Text(antiguedadOrden(o['fecha_creacion']))),
              if (onAsignar != null) SizedBox(width: 96, child: FilledButton(onPressed: onAsignar, child: const Text('Asignar'))),
            ],
          ),
        ),
      ),
    );
  }
}

class _TarjetaOrden extends StatelessWidget {
  final Map<String, dynamic> orden;
  final VoidCallback onTap;
  final VoidCallback? onAsignar;
  const _TarjetaOrden({required this.orden, required this.onTap, this.onAsignar});

  @override
  Widget build(BuildContext context) {
    final o = orden;
    return Card(
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(child: Text('OT #${o['id']} · ${o['maquinaria_codigo'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w700))),
                  EstadoChip(estado: o['estado']),
                ],
              ),
              const SizedBox(height: 4),
              Text('${o['cliente_nombre'] ?? 'Sin cliente'}'),
              if ((o['motivo'] ?? '').toString().isNotEmpty)
                Text('${o['motivo']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.black54)),
              const SizedBox(height: 4),
              Text(
                '${o['mecanico_nombre'] ?? 'Sin asignar'} · ${antiguedadOrden(o['fecha_creacion'])}',
                style: const TextStyle(fontSize: 12, color: Colors.black54),
              ),
              if (onAsignar != null) ...[
                const SizedBox(height: 8),
                Align(alignment: Alignment.centerRight, child: FilledButton(onPressed: onAsignar, child: const Text('Asignar'))),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
