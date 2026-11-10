import 'dart:async';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/formato.dart';
import '../../utils/numeros.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_equipo.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/ficha_tecnica_campos.dart';
import '../../widgets/pestanas.dart';

/// Flota: los equipos de GOMAQ en una tabla, con una pestaña por categoría.
///
/// Lo que se quiere resolver de un vistazo es cuál es cuál y en qué estado está. Por eso cada
/// pestaña cambia la columna de medida (capacidad en kg para grúas y traspaletas, altura de
/// trabajo para los alzahombres) y el estado siempre lleva ícono y texto, no solo color.
class FlotaScreen extends StatefulWidget {
  /// Filtros que llegan por la URL (?estado=...&disponibilidad=...), para que "Flota filtrada"
  /// sea compartible y sobreviva a un F5. Los usa el Dashboard desde sus números tocables.
  final Map<String, String>? filtroInicial;
  const FlotaScreen({super.key, this.filtroInicial});

  @override
  State<FlotaScreen> createState() => _FlotaScreenState();
}

/// Una columna de la tabla. `orden` es el nombre que entiende el servidor (null = no ordenable);
/// `minAncho` oculta la columna cuando el panel está angosto, en vez de apretar todas.
typedef _Columna = ({String id, String titulo, int flex, String? orden, double minAncho});

const _pluralCategoria = {
  'grua_horquilla': 'Grúas horquilla',
  'alzahombre': 'Alzahombres',
  'transpaleta': 'Traspaletas',
  'apilador': 'Apiladores',
};

class _FlotaScreenState extends State<FlotaScreen> {
  List<dynamic> _maquinarias = [];
  bool _cargando = true;
  String? _error;
  String _busqueda = '';
  final _controladorBusqueda = TextEditingController();

  // La pestaña de categoría, el estado, la disponibilidad y el cliente son filtros del servidor.
  String? _filtroDisponibilidad;
  String? _filtroEstado;
  String? _filtroCategoria;
  String? _filtroCliente;
  String _orden = 'codigo';
  bool _ascendente = true;

  // paginación en servidor: antes se bajaban los ~500 equipos y se filtraba en el panel
  static const _porPagina = 50;
  int _total = 0;
  bool _hayMas = false;
  bool _cargandoMas = false;
  Timer? _debounce;

  // Totales de toda la flota (no cambian con los filtros): las tarjetas de arriba y los
  // números de las pestañas. Se piden aparte porque la lista solo trae una página.
  Map<String, dynamic>? _resumen;

  @override
  void initState() {
    super.initState();
    _filtroDisponibilidad = widget.filtroInicial?['disponibilidad'];
    _filtroEstado = widget.filtroInicial?['estado'];
    _filtroCategoria = widget.filtroInicial?['categoria'];
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _cargar();
      _cargarResumen();
      _cargarClientes();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controladorBusqueda.dispose();
    super.dispose();
  }

  String _consulta({required int offset}) {
    final p = <String>['limit=$_porPagina', 'offset=$offset', 'orden=$_orden', 'dir=${_ascendente ? 'asc' : 'desc'}'];
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
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
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

  Future<void> _cargarResumen() async {
    try {
      final data = await ApiClient.instance.get('/api/maquinarias/resumen');
      if (mounted) setState(() => _resumen = data);
    } on ApiException catch (_) {
      // sin resumen no se muestran las tarjetas ni los números de las pestañas, pero la tabla sí
    }
  }

  /// La búsqueda va al servidor, así que se espera a que el usuario deje de escribir
  /// en vez de disparar una consulta por tecla.
  void _buscar(String texto) {
    setState(() => _busqueda = texto);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _cargar);
  }

  /// Clientes para el filtro. Se piden aparte y NO se derivan de los equipos cargados:
  /// desde que la lista pagina, derivarlos solo mostraría los clientes de la primera página.
  List<dynamic> _clientes = [];

  Future<void> _cargarClientes() async {
    try {
      final data = await ApiClient.instance.get('/api/clientes');
      if (mounted) setState(() => _clientes = data);
    } on ApiException catch (_) {
      // el filtro por cliente queda sin opciones, pero la flota igual se ve
    }
  }

  // ---- filtros -------------------------------------------------------------------------------

  bool get _hayFiltros =>
      _filtroDisponibilidad != null || _filtroEstado != null || _filtroCliente != null || _busqueda.trim().isNotEmpty;

  /// Las tarjetas de arriba son atajos: cada una fija UN criterio y suelta el otro, porque
  /// "arrendados" y "en mantención" son dos formas de mirar los mismos equipos.
  void _aplicarAtajo({String? disponibilidad, String? estado}) {
    setState(() {
      _filtroDisponibilidad = disponibilidad;
      _filtroEstado = estado;
    });
    _cargar();
  }

  void _elegirCategoria(String id) {
    setState(() => _filtroCategoria = id == 'todos' ? null : id);
    // el orden por altura no existe en las otras pestañas, ni el de capacidad en la de alzahombres
    if ((_orden == 'altura' && _filtroCategoria != 'alzahombre') ||
        (_orden == 'capacidad' && _filtroCategoria == 'alzahombre') ||
        (_orden == 'capacidad' && _filtroCategoria == null)) {
      _orden = 'codigo';
      _ascendente = true;
    }
    _cargar();
  }

  void _ordenarPor(String columna) {
    setState(() {
      if (_orden == columna) {
        _ascendente = !_ascendente;
      } else {
        _orden = columna;
        _ascendente = true;
      }
    });
    _cargar();
  }

  void _limpiarFiltros() {
    setState(() {
      _filtroDisponibilidad = null;
      _filtroEstado = null;
      _filtroCliente = null;
      _busqueda = '';
      _controladorBusqueda.clear();
    });
    _cargar();
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

    // solo los campos que tienen texto: el servidor recibe un campo o no lo recibe
    String? texto(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();
    String? numero(TextEditingController c) {
      final n = parsearNumero(c.text);
      return n == null ? null : '$n';
    }

    if (!mounted) return;
    final creada = await mostrarFormulario(
      context,
      icono: Icons.local_shipping,
      titulo: 'Nueva maquinaria',
      subtitulo: 'Agrega un equipo a la flota',
      textoAccion: 'Crear maquinaria',
      ancho: 580,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                flex: 2,
                child: TextFormField(
                  controller: codigoCtrl,
                  autofocus: true,
                  textCapitalization: TextCapitalization.characters,
                  decoration: decoracionCampo('Código', obligatorio: true, ayuda: 'Por ejemplo GH-204.'),
                  validator: obligatorio('Escribe el código del equipo.'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                flex: 3,
                child: DropdownButtonFormField<String>(
                  initialValue: categoria,
                  isExpanded: true,
                  decoration: decoracionCampo('Categoría', obligatorio: true, ayuda: 'Define qué datos pide la ficha.'),
                  items: [for (final c in categoriasEquipo) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
                  validator: (v) => v == null ? 'Elige la categoría.' : null,
                  onChanged: (v) => redibujar(() {
                    // autocompleta "tipo" con la etiqueta de la categoría, salvo que se haya escrito
                    // algo distinto al autorrelleno anterior (no se pisa lo que el usuario editó)
                    final tipoActual = tipoCtrl.text.trim();
                    if (tipoActual.isEmpty || tipoActual == etiquetasCategoria[categoria]) {
                      tipoCtrl.text = v != null ? etiquetasCategoria[v]! : '';
                    }
                    categoria = v;
                  }),
                ),
              ),
            ],
          ),
          separadorCampos,
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextFormField(
                  controller: tipoCtrl,
                  decoration: decoracionCampo('Tipo', obligatorio: true, ayuda: 'Por ejemplo Grúa horquilla.'),
                  validator: obligatorio('Escribe el tipo de equipo.'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(child: TextFormField(controller: ubicacionCtrl, decoration: decoracionCampo('Ubicación'))),
            ],
          ),
          if (categoria != null) ...[
            const SizedBox(height: 8),
            const Divider(),
            const TituloSeccion('Ficha técnica'),
            ...camposFichaTecnica(
              categoria: categoria,
              combustible: combustible,
              onCombustibleChanged: (v) => redibujar(() => combustible = v),
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
            separadorCampos,
            OutlinedButton.icon(
              onPressed: () async {
                final resultado = await FilePicker.platform.pickFiles(
                  type: FileType.custom,
                  allowedExtensions: ['jpg', 'jpeg', 'png'],
                  withData: true,
                );
                if (resultado != null && resultado.files.single.bytes != null) {
                  redibujar(() => foto = resultado.files.single);
                }
              },
              icon: const Icon(Icons.image_outlined),
              label: Text(foto?.name ?? 'Agregar foto (opcional)'),
            ),
          ],
        ],
      ),
      alGuardar: () => ApiClient.instance.postMultipart(
        '/api/maquinarias',
        bytes: foto?.bytes,
        filename: foto?.name,
        fields: {
          'codigo': codigoCtrl.text.trim(),
          'tipo': tipoCtrl.text.trim(),
          'categoria_equipo': categoria!,
          'ubicacion': ?texto(ubicacionCtrl),
          'marca': ?texto(marcaCtrl),
          'modelo': ?texto(modeloCtrl),
          'anio': ?texto(anioCtrl),
          'descripcion': ?texto(descripcionCtrl),
          'capacidad_carga': ?numero(capacidadCargaCtrl),
          'altura_trabajo': ?numero(alturaTrabajoCtrl),
          'numero_serie': ?texto(numeroSerieCtrl),
          'numero_motor': ?texto(numeroMotorCtrl),
          'numero_chasis': ?texto(numeroChasisCtrl),
          'numero_mastil': ?texto(numeroMastilCtrl),
          'tipo_combustible': (categoria == 'transpaleta' || categoria == 'apilador') ? 'electrica' : (combustible ?? ''),
        },
      ),
    );
    for (final c in [codigoCtrl, tipoCtrl, ubicacionCtrl, marcaCtrl, modeloCtrl, anioCtrl, descripcionCtrl, capacidadCargaCtrl, alturaTrabajoCtrl, numeroSerieCtrl, numeroMotorCtrl, numeroChasisCtrl, numeroMastilCtrl]) {
      c.dispose();
    }
    if (creada && mounted) {
      _cargar();
      _cargarResumen();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Maquinaria creada')));
    }
  }

  // ---- pantalla ------------------------------------------------------------------------------

  /// Las columnas cambian con la pestaña: la medida que importa de una grúa (capacidad) no es
  /// la de un alzahombre (altura de trabajo).
  List<_Columna> get _columnas {
    final String tituloMedida;
    final String? ordenMedida;
    switch (_filtroCategoria) {
      case 'alzahombre':
        tituloMedida = 'Altura de trabajo';
        ordenMedida = 'altura';
      case null:
        tituloMedida = 'Capacidad / altura';
        ordenMedida = null;
      default:
        tituloMedida = 'Capacidad de carga';
        ordenMedida = 'capacidad';
    }
    return [
      (id: 'codigo', titulo: 'Código', flex: 2, orden: 'codigo', minAncho: 0),
      (id: 'equipo', titulo: 'Equipo', flex: 4, orden: 'tipo', minAncho: 0),
      (id: 'medida', titulo: tituloMedida, flex: 3, orden: ordenMedida, minAncho: 0),
      (id: 'combustible', titulo: 'Combustible', flex: 2, orden: 'combustible', minAncho: 860),
      (id: 'estado', titulo: 'Estado', flex: 3, orden: 'estado', minAncho: 0),
      (id: 'cliente', titulo: 'Cliente', flex: 3, orden: 'cliente', minAncho: 720),
    ];
  }

  /// Capacidad en kg o altura en m, la que tenga el equipo. En la pestaña de alzahombres se
  /// muestra la altura; en el resto, la capacidad.
  String _textoMedida(Map<String, dynamic> m) {
    final capacidad = Formato.medida(m['capacidad_carga'], 'kg');
    final altura = Formato.medida(m['altura_trabajo'], 'm');
    if (_filtroCategoria == 'alzahombre') return altura;
    if (_filtroCategoria != null) return capacidad;
    return capacidad.isNotEmpty ? capacidad : altura;
  }

  /// A quién está arrendado. Sin cliente, "Disponible" solo si el equipo está operativo: uno
  /// en mantención o fuera de servicio no se puede arrendar, así que no se dice que lo esté.
  String _textoCliente(Map<String, dynamic> m) {
    if (m['cliente'] != null) return m['cliente'];
    return m['estado'] == 'operativa' ? 'Disponible' : '';
  }

  String _textoMarcaModelo(Map<String, dynamic> m) =>
      [m['marca'], m['modelo']].where((x) => x != null && '$x'.trim().isNotEmpty).join(' ');

  @override
  Widget build(BuildContext context) {
    final puedeEscribir = context.watch<AuthService>().esAdministrativo;

    return LayoutBuilder(
      builder: (context, restricciones) {
        final ancho = restricciones.maxWidth;
        final columnas = _columnas.where((c) => ancho >= c.minAncho).toList();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_resumen != null) _tarjetasResumen(),
            _barraFiltros(puedeEscribir),
            _pestanasCategoria(),
            _encabezadoTabla(columnas),
            Expanded(child: _cuerpo(columnas)),
          ],
        );
      },
    );
  }

  Widget _tarjetasResumen() {
    final r = _resumen!;
    Widget tarjeta(String etiqueta, int? n, {required bool activa, required VoidCallback onTap, Color? colorNumero}) {
      return InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        focusColor: GomaqColors.accion.withValues(alpha: 0.12),
        child: Semantics(
          button: true,
          selected: activa,
          label: '$etiqueta: $n',
          excludeSemantics: true,
          child: Container(
            width: 150,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: activa ? GomaqColors.accion : Colors.grey.shade300, width: activa ? 2 : 1),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${n ?? '-'}', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: colorNumero)),
                Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black54)),
              ],
            ),
          ),
        ),
      );
    }

    final sinAtajo = _filtroDisponibilidad == null && _filtroEstado == null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 4, 24, 12),
      child: Wrap(
        spacing: 10,
        runSpacing: 10,
        children: [
          tarjeta('Equipos', r['total'], activa: sinAtajo, onTap: () => _aplicarAtajo()),
          tarjeta('Disponibles', r['disponibles'],
              activa: _filtroDisponibilidad == 'disponibles', onTap: () => _aplicarAtajo(disponibilidad: 'disponibles')),
          tarjeta('Arrendados', r['arrendados'],
              activa: _filtroDisponibilidad == 'arrendados', onTap: () => _aplicarAtajo(disponibilidad: 'arrendados')),
          tarjeta('En mantención', r['en_mantencion'],
              activa: _filtroEstado == 'en_mantencion',
              colorNumero: (r['en_mantencion'] ?? 0) > 0 ? GomaqColors.textoEstado('en_mantencion') : null,
              onTap: () => _aplicarAtajo(estado: 'en_mantencion')),
          tarjeta('Fuera de servicio', r['fuera_de_servicio'],
              activa: _filtroEstado == 'fuera_de_servicio',
              colorNumero: (r['fuera_de_servicio'] ?? 0) > 0 ? GomaqColors.textoEstado('fuera_de_servicio') : null,
              onTap: () => _aplicarAtajo(estado: 'fuera_de_servicio')),
        ],
      ),
    );
  }

  Widget _barraFiltros(bool puedeEscribir) {
    // el botón de crear va a la derecha, fuera del Wrap: dentro caía a una segunda línea
    final nueva = puedeEscribir
        ? FilledButton.icon(onPressed: _abrirDialogoCrear, icon: const Icon(Icons.add, size: 18), label: const Text('Nueva maquinaria'))
        : null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: _filtros()),
          if (nueva != null) Padding(padding: const EdgeInsets.only(left: 12), child: nueva),
        ],
      ),
    );
  }

  Widget _filtros() {
    return Wrap(
        spacing: 10,
        runSpacing: 10,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          SizedBox(
            width: 300,
            child: TextField(
              controller: _controladorBusqueda,
              onChanged: _buscar,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Buscar por código, marca o modelo',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
          SizedBox(
            width: 180,
            child: DropdownButtonFormField<String?>(
              // la key hace que el desplegable refleje un estado fijado desde una tarjeta
              key: ValueKey('estado-$_filtroEstado'),
              initialValue: _filtroEstado,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Estado', border: OutlineInputBorder(), isDense: true),
              items: const [
                DropdownMenuItem(value: null, child: Text('Todos')),
                DropdownMenuItem(value: 'operativa', child: Text('Operativa')),
                DropdownMenuItem(value: 'en_mantencion', child: Text('En mantención')),
                DropdownMenuItem(value: 'fuera_de_servicio', child: Text('Fuera de servicio')),
              ],
              onChanged: (v) {
                setState(() => _filtroEstado = v);
                _cargar();
              },
            ),
          ),
          SizedBox(
            width: 200,
            child: DropdownButtonFormField<String?>(
              key: ValueKey('cliente-$_filtroCliente-${_clientes.length}'),
              initialValue: _filtroCliente,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Cliente', border: OutlineInputBorder(), isDense: true),
              items: [
                const DropdownMenuItem(value: null, child: Text('Todos')),
                for (final c in _clientes)
                  DropdownMenuItem(value: '${c['id']}', child: Text('${c['nombre']}', overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (v) {
                setState(() => _filtroCliente = v);
                _cargar();
              },
            ),
          ),
          if (_hayFiltros)
            TextButton.icon(onPressed: _limpiarFiltros, icon: const Icon(Icons.close, size: 16), label: const Text('Quitar filtros')),
        ],
    );
  }

  Widget _pestanasCategoria() {
    final porCategoria = (_resumen?['por_categoria'] as Map?)?.cast<String, dynamic>() ?? const {};
    final items = <ItemPestana>[
      (id: 'todos', etiqueta: 'Todos', cantidad: _resumen?['total'] as int?),
      for (final e in _pluralCategoria.entries)
        // una categoría sin equipos no ocupa lugar, salvo que sea la que se está viendo
        if ((porCategoria[e.key] ?? 0) > 0 || _filtroCategoria == e.key)
          (id: e.key, etiqueta: e.value, cantidad: porCategoria[e.key] as int?),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24),
      child: Pestanas(items: items, seleccionada: _filtroCategoria ?? 'todos', onSeleccionar: _elegirCategoria),
    );
  }

  static const _estiloEncabezado = TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.black54);

  Widget _encabezadoTabla(List<_Columna> columnas) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 24),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: Colors.grey.shade300))),
      child: Row(
        children: [
          for (final c in columnas)
            Expanded(
              flex: c.flex,
              child: c.orden == null
                  ? Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(c.titulo, style: _estiloEncabezado))
                  : _encabezadoOrdenable(c),
            ),
        ],
      ),
    );
  }

  Widget _encabezadoOrdenable(_Columna c) {
    final activo = _orden == c.orden;
    return InkWell(
      onTap: () => _ordenarPor(c.orden!),
      focusColor: GomaqColors.accion.withValues(alpha: 0.12),
      child: Semantics(
        button: true,
        label: 'Ordenar por ${c.titulo}${activo ? (_ascendente ? ', de menor a mayor' : ', de mayor a menor') : ''}',
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Row(
            children: [
              Flexible(child: Text(c.titulo, style: _estiloEncabezado, overflow: TextOverflow.ellipsis)),
              if (activo) Icon(_ascendente ? Icons.arrow_upward : Icons.arrow_downward, size: 14, color: Colors.black87),
            ],
          ),
        ),
      ),
    );
  }

  Widget _cuerpo(List<_Columna> columnas) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return EstadoVacio(
        icono: Icons.cloud_off,
        titulo: 'No se pudo cargar la flota',
        mensaje: _error!,
        textoAccion: 'Reintentar',
        onAccion: _cargar,
      );
    }
    if (_maquinarias.isEmpty) {
      return EstadoVacio(
        icono: Icons.search_off,
        titulo: 'No hay equipos con estos filtros',
        mensaje: 'Prueba con otra búsqueda o quita los filtros para ver toda la flota.',
        textoAccion: _hayFiltros ? 'Quitar filtros' : null,
        onAccion: _hayFiltros ? _limpiarFiltros : null,
      );
    }
    return RefreshIndicator(
      onRefresh: () async {
        await _cargar();
        await _cargarResumen();
      },
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        // +1 por el pie: "cargar más" o el conteo de lo que se muestra
        itemCount: _maquinarias.length + 1,
        itemBuilder: (context, i) {
          if (i == _maquinarias.length) return _pieDeLista(_maquinarias.length);
          return _fila(_maquinarias[i], columnas);
        },
      ),
    );
  }

  Widget _fila(Map<String, dynamic> m, List<_Columna> columnas) {
    final medida = _textoMedida(m);
    final cliente = _textoCliente(m);
    final combustible = m['tipo_combustible'] != null ? etiquetasCombustible[m['tipo_combustible']] : null;
    final marcaModelo = _textoMarcaModelo(m);

    // una sola lectura por fila para el lector de pantalla, en vez de seis celdas sueltas
    final lectura = [
      '${m['codigo']}',
      '${m['tipo']}',
      if (marcaModelo.isNotEmpty) marcaModelo,
      if (medida.isNotEmpty) medida,
      ?combustible,
      GomaqColors.etiquetaEstado(m['estado']),
      if (cliente.isNotEmpty) cliente,
    ].join(', ');

    Widget vacio() => const Text('—', style: TextStyle(color: Colors.black54));

    Widget celda(_Columna c) {
      switch (c.id) {
        case 'codigo':
          return Text('${m['codigo']}', style: const TextStyle(fontWeight: FontWeight.w700));
        case 'equipo':
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${m['tipo']}', overflow: TextOverflow.ellipsis),
              if (marcaModelo.isNotEmpty)
                Text(marcaModelo, style: const TextStyle(fontSize: 12, color: Colors.black54), overflow: TextOverflow.ellipsis),
            ],
          );
        case 'medida':
          return medida.isEmpty ? vacio() : Text(medida);
        case 'combustible':
          return combustible == null ? vacio() : Text(combustible);
        case 'estado':
          return Align(alignment: Alignment.centerLeft, child: EstadoEquipo(estado: m['estado']));
        case 'cliente':
          if (cliente.isEmpty) return vacio();
          return Text(cliente,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: m['cliente'] == null ? Colors.black54 : Colors.black87));
      }
      return const SizedBox.shrink();
    }

    return InkWell(
      // push y no go: al volver desde el perfil, Flota conserva la pestaña, los filtros y el orden
      onTap: () => context.push('/flota/${m['id']}'),
      focusColor: GomaqColors.accion.withValues(alpha: 0.12),
      child: Semantics(
        button: true,
        label: lectura,
        excludeSemantics: true,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: Colors.grey.shade200))),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [for (final c in columnas) Expanded(flex: c.flex, child: celda(c))],
          ),
        ),
      ),
    );
  }

  /// Pie de la lista: cuántos equipos se ven de cuántos hay, y el botón para traer más.
  Widget _pieDeLista(int mostrados) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        children: [
          Text('Mostrando $mostrados de $_total equipos', style: const TextStyle(fontSize: 12, color: Colors.black54)),
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
}
