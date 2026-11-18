import 'dart:async';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/formato.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/pestanas.dart';

/// Costo real por equipo. Arriba, las cifras de toda la flota; abajo, los equipos con lo que hay
/// que decidir primero: los que salen a perdida. Ademas del gasto y el margen, cada equipo muestra
/// la parte del ingreso que se va en repuestos, el costo por hora de uso (horometro) y los dias
/// arrendado (guias).
class RentabilidadScreen extends StatefulWidget {
  const RentabilidadScreen({super.key});

  @override
  State<RentabilidadScreen> createState() => _RentabilidadScreenState();
}

/// Una columna de la tabla. `orden` es el nombre que entiende el servidor (null = no ordenable);
/// `minAncho` la oculta cuando el panel está angosto, en vez de apretar todas.
typedef _Columna = ({String id, String titulo, int flex, String? orden, double minAncho});

const _columnas = <_Columna>[
  (id: 'equipo', titulo: 'Equipo', flex: 5, orden: 'codigo', minAncho: 0),
  (id: 'gasto', titulo: 'Gasto', flex: 2, orden: 'gasto', minAncho: 0),
  (id: 'ingreso', titulo: 'Facturado', flex: 2, orden: 'ingreso', minAncho: 0),
  (id: 'margen', titulo: 'Margen', flex: 3, orden: 'margen', minAncho: 0),
  (id: 'ratio', titulo: 'Gasto sobre ingreso', flex: 2, orden: 'ratio', minAncho: 900),
  (id: 'hora', titulo: 'Gasto por hora', flex: 2, orden: 'hora', minAncho: 1000),
  (id: 'dias', titulo: 'Días arrendado', flex: 2, orden: 'dias', minAncho: 800),
];

class _RentabilidadScreenState extends State<RentabilidadScreen> {
  List<dynamic> _equipos = [];
  bool _cargando = true;
  String? _error;
  int _meses = 12;

  static const _porPagina = 50;
  int _total = 0;
  bool _hayMas = false;
  bool _cargandoMas = false;

  String _busqueda = '';
  final _controladorBusqueda = TextEditingController();
  // 'todos' o el resultado que entiende el servidor: a_perdida, con_ganancia, sin_movimiento
  String _resultado = 'todos';
  // null = el orden por defecto del servidor (las pérdidas primero)
  String? _orden;
  bool _ascendente = true;

  // del servidor y sobre toda la flota: contar solo la página cargada engañaría
  Map<String, dynamic> _resumen = const {};
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controladorBusqueda.dispose();
    super.dispose();
  }

  String _consulta({required int offset}) {
    final hasta = DateTime.now();
    final desde = DateTime(hasta.year, hasta.month - _meses, hasta.day);
    final p = <String>[
      'desde=${desde.toIso8601String()}',
      'hasta=${hasta.toIso8601String()}',
      'limit=$_porPagina',
      'offset=$offset',
    ];
    if (_busqueda.trim().isNotEmpty) p.add('q=${Uri.encodeQueryComponent(_busqueda.trim())}');
    if (_resultado != 'todos') p.add('resultado=$_resultado');
    if (_orden != null) p.addAll(['orden=$_orden', 'dir=${_ascendente ? 'asc' : 'desc'}']);
    return '/api/rentabilidad?${p.join('&')}';
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
        _equipos = data['items'] ?? [];
        _total = data['total'] ?? 0;
        _hayMas = data['hay_mas'] == true;
        _resumen = Map<String, dynamic>.from(data['resumen'] ?? {});
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
      final data = await ApiClient.instance.get(_consulta(offset: _equipos.length));
      if (!mounted) return;
      setState(() {
        _equipos = [..._equipos, ...data['items']];
        _hayMas = data['hay_mas'] == true;
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudieron cargar más equipos: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoMas = false);
    }
  }

  void _buscar(String texto) {
    setState(() => _busqueda = texto);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _cargar);
  }

  void _elegirResultado(String id) {
    setState(() => _resultado = id);
    _cargar();
  }

  /// Tocar un encabezado ordena de menor a mayor, otra vez de mayor a menor y una tercera vuelve
  /// al orden por defecto: sin ese regreso no habría forma de volver a ver primero las pérdidas.
  void _ordenarPor(String columna) {
    setState(() {
      if (_orden != columna) {
        _orden = columna;
        _ascendente = true;
      } else if (_ascendente) {
        _ascendente = false;
      } else {
        _orden = null;
        _ascendente = true;
      }
    });
    _cargar();
  }

  void _limpiar() {
    setState(() {
      _resultado = 'todos';
      _busqueda = '';
      _controladorBusqueda.clear();
    });
    _cargar();
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando && _resumen.isEmpty) return const Center(child: CircularProgressIndicator());
    if (_error != null && _resumen.isEmpty) {
      return EstadoVacio(
        icono: Icons.cloud_off,
        titulo: 'No se pudieron cargar los costos',
        mensaje: _error!,
        textoAccion: 'Reintentar',
        onAccion: _cargar,
      );
    }

    return LayoutBuilder(
      builder: (context, restricciones) {
        final ancho = restricciones.maxWidth;
        final columnas = _columnas.where((c) => ancho >= c.minAncho).toList();
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // el título lo pone el marco del panel (admin_dashboard_screen)
              _encabezado(),
              const SizedBox(height: 14),
              _tarjetas(),
              const SizedBox(height: 12),
              _aviso(),
              const SizedBox(height: 14),
              _filtros(),
              _encabezadoTabla(columnas),
              Expanded(child: _cuerpo(columnas)),
            ],
          ),
        );
      },
    );
  }

  Widget _encabezado() {
    return Wrap(
      spacing: 16,
      runSpacing: 10,
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        const Text('Gasto en repuestos contra lo facturado, por equipo.', style: TextStyle(fontSize: 13, color: Colors.black54)),
        SegmentedButton<int>(
          showSelectedIcon: false,
          segments: const [
            ButtonSegment(value: 3, label: Text('3 meses')),
            ButtonSegment(value: 6, label: Text('6 meses')),
            ButtonSegment(value: 12, label: Text('12 meses')),
            ButtonSegment(value: 24, label: Text('24 meses')),
          ],
          selected: {_meses},
          onSelectionChanged: (s) {
            setState(() => _meses = s.first);
            _cargar();
          },
        ),
      ],
    );
  }

  Widget _tarjetas() {
    final gasto = (_resumen['gasto_total'] ?? 0) as num;
    final ingreso = (_resumen['ingreso_total'] ?? 0) as num;
    final margen = (_resumen['margen_total'] ?? 0) as num;
    final aPerdida = (_resumen['a_perdida'] ?? 0) as int;
    final utilizacion = _resumen['utilizacion_flota'] as num?;

    Widget tarjeta(String etiqueta, String valor, {Color? colorValor, String? nota, Color? fondo, VoidCallback? onTap, bool activa = false}) {
      final contenido = Container(
        width: 190,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: fondo ?? Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: activa ? GomaqColors.accion : Colors.grey.shade300, width: activa ? 2 : 1),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(valor, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: colorValor)),
            Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black54)),
            if (nota != null) Text(nota, style: const TextStyle(fontSize: 11, color: Colors.black54)),
          ],
        ),
      );
      final etiquetaLectura = '$etiqueta: $valor${nota != null ? ', $nota' : ''}';
      if (onTap == null) {
        return Semantics(container: true, label: etiquetaLectura, child: ExcludeSemantics(child: contenido));
      }
      return InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        focusColor: GomaqColors.accion.withValues(alpha: 0.12),
        child: Semantics(button: true, selected: activa, label: etiquetaLectura, excludeSemantics: true, child: contenido),
      );
    }

    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        tarjeta('Gasto en repuestos', Formato.clp(gasto)),
        tarjeta('Facturado', Formato.clp(ingreso)),
        tarjeta(
          'Margen',
          Formato.clp(margen),
          colorValor: margen < 0 ? GomaqColors.textoEstado('fuera_de_servicio') : (margen > 0 ? GomaqColors.textoEstado('operativa') : null),
          nota: ingreso > 0 ? '${(margen / ingreso * 100).round()}% de lo facturado' : null,
        ),
        tarjeta(
          'Utilización de la flota',
          utilizacion == null ? '-' : '${utilizacion.round()}%',
          nota: 'días arrendado sobre días posibles',
        ),
        tarjeta(
          'Equipos a pérdida',
          '$aPerdida',
          colorValor: aPerdida > 0 ? GomaqColors.textoEstado('fuera_de_servicio') : null,
          fondo: aPerdida > 0 ? GomaqColors.estadoNegativo.withValues(alpha: 0.08) : null,
          activa: _resultado == 'a_perdida',
          onTap: () => _elegirResultado(_resultado == 'a_perdida' ? 'todos' : 'a_perdida'),
        ),
      ],
    );
  }

  Widget _aviso() {
    final sinPrecio = (_resumen['lineas_sin_precio'] ?? 0) as int;
    final advertencia = sinPrecio > 0;
    final color = advertencia ? GomaqColors.textoEstado('en_mantencion') : Colors.black54;
    // sin el aviso de precios, un equipo con repuestos sin precio parece barato cuando en realidad
    // es que nadie cargó los montos. Y el gasto son solo repuestos: las horas del técnico no
    // entran (no hay un valor hora definido), así que un equipo "con ganancia" puede no serlo.
    final texto = [
      if (advertencia) '$sinPrecio línea${sinPrecio == 1 ? '' : 's'} de repuesto sin precio: el gasto real es mayor.',
      'El gasto cuenta solo repuestos, no las horas del técnico.',
    ].join(' ');
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: advertencia ? GomaqColors.estadoAdvertencia.withValues(alpha: 0.12) : Colors.grey.shade100,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          ExcludeSemantics(child: Icon(Icons.info_outline, size: 18, color: color)),
          const SizedBox(width: 8),
          Expanded(child: Text(texto, style: TextStyle(fontSize: 13, color: color, fontWeight: advertencia ? FontWeight.w600 : FontWeight.w400))),
        ],
      ),
    );
  }

  Widget _filtros() {
    int n(String k) => (_resumen[k] ?? 0) as int;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Pestanas(
            items: [
              (id: 'todos', etiqueta: 'Todos', cantidad: n('total')),
              (id: 'a_perdida', etiqueta: 'A pérdida', cantidad: n('a_perdida')),
              (id: 'con_ganancia', etiqueta: 'Con ganancia', cantidad: n('con_ganancia')),
              (id: 'sin_movimiento', etiqueta: 'Sin movimiento', cantidad: n('sin_movimiento')),
            ],
            seleccionada: _resultado,
            onSeleccionar: _elegirResultado,
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 240,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: TextField(
              controller: _controladorBusqueda,
              onChanged: _buscar,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Buscar equipo',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
        ),
      ],
    );
  }

  static const _estiloEncabezado = TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.black54);

  Widget _encabezadoTabla(List<_Columna> columnas) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: Colors.grey.shade300))),
      child: Row(
        children: [
          for (final c in columnas)
            Expanded(
              flex: c.flex,
              child: c.orden == null ? Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(c.titulo, style: _estiloEncabezado)) : _encabezadoOrdenable(c),
            ),
        ],
      ),
    );
  }

  Widget _encabezadoOrdenable(_Columna c) {
    final activo = _orden == c.orden;
    // las cifras se alinean a la derecha, y su encabezado con ellas
    final alinearDerecha = c.id != 'equipo' && c.id != 'margen';
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
            mainAxisAlignment: alinearDerecha ? MainAxisAlignment.end : MainAxisAlignment.start,
            children: [
              Flexible(child: Text(c.titulo, style: _estiloEncabezado, overflow: TextOverflow.ellipsis, textAlign: alinearDerecha ? TextAlign.right : TextAlign.left)),
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
      return EstadoVacio(icono: Icons.cloud_off, titulo: 'No se pudieron cargar los costos', mensaje: _error!, textoAccion: 'Reintentar', onAccion: _cargar);
    }
    if (_equipos.isEmpty) {
      final filtrado = _resultado != 'todos' || _busqueda.trim().isNotEmpty;
      return EstadoVacio(
        icono: filtrado ? Icons.search_off : Icons.precision_manufacturing_outlined,
        titulo: filtrado ? 'No hay equipos con estos filtros' : 'Todavía no hay equipos',
        mensaje: filtrado
            ? 'Prueba con otra búsqueda o quita los filtros para ver toda la flota.'
            : 'Cuando se agreguen equipos a la flota, sus costos aparecen acá.',
        textoAccion: filtrado ? 'Quitar filtros' : null,
        onAccion: filtrado ? _limpiar : null,
      );
    }

    // la barra de margen se escala contra el mayor de los que se ven, para que sea comparable
    var maxMargen = 1.0;
    for (final e in _equipos) {
      final m = ((e['margen'] ?? 0) as num).abs().toDouble();
      if (m > maxMargen) maxMargen = m;
    }
    final diasPeriodo = (_resumen['dias_periodo'] ?? 0) as int;

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView.builder(
        padding: const EdgeInsets.only(bottom: 24),
        // +1 por el pie: "cargar más" o el conteo de lo que se muestra
        itemCount: _equipos.length + 1,
        itemBuilder: (context, i) {
          if (i == _equipos.length) return _pieDeLista();
          return _fila(_equipos[i], columnas, maxMargen, diasPeriodo);
        },
      ),
    );
  }

  Widget _fila(Map<String, dynamic> e, List<_Columna> columnas, double maxMargen, int diasPeriodo) {
    final aPerdida = e['resultado'] == 'a_perdida';
    final margen = ((e['margen'] ?? 0) as num).toDouble();
    final ratio = e['gasto_sobre_ingreso'] as num?;
    final porHora = e['gasto_por_hora'] as num?;
    final dias = (e['dias_arrendado'] ?? 0) as num;
    final marcaModelo = [e['marca'], e['modelo']].where((x) => x != null && '$x'.trim().isNotEmpty).join(' ');
    final subtitulo = [e['tipo'], if (marcaModelo.isNotEmpty) marcaModelo].join(' · ');

    final colorMargen = aPerdida
        ? GomaqColors.textoEstado('fuera_de_servicio')
        : (margen > 0 ? GomaqColors.textoEstado('operativa') : Colors.black54);

    final lectura = [
      '${e['codigo']}',
      subtitulo,
      if (aPerdida) 'a pérdida',
      'gasto ${Formato.clp(e['gasto'])}',
      'facturado ${Formato.clp(e['ingreso'])}',
      'margen ${Formato.clp(e['margen'])}',
      if (ratio != null) 'gasto sobre ingreso ${ratio.round()} por ciento',
      if (porHora != null) 'gasto por hora ${Formato.clp(porHora)}',
      '${dias.round()} días arrendado',
    ].join(', ');

    Widget derecha(Widget hijo) => Align(alignment: Alignment.centerRight, child: hijo);
    Widget vacio() => const Text('—', style: TextStyle(color: Colors.black54));

    Widget celda(_Columna c) {
      switch (c.id) {
        case 'equipo':
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text('${e['codigo']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                  // ícono y texto además del color: quien no distingue el rojo también lo ve
                  if (aPerdida) _etiquetaPerdida(),
                ],
              ),
              Text(subtitulo, style: const TextStyle(fontSize: 12, color: Colors.black54), overflow: TextOverflow.ellipsis),
            ],
          );
        case 'gasto':
          return derecha(Text(Formato.clp(e['gasto'])));
        case 'ingreso':
          return derecha(Text(Formato.clp(e['ingreso'])));
        case 'margen':
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _barraMargen(margen, maxMargen, aPerdida),
              const SizedBox(height: 3),
              Text(Formato.clp(e['margen']), style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: colorMargen)),
            ],
          );
        case 'ratio':
          return derecha(ratio == null
              ? vacio()
              : Text('${ratio.round()}%', style: TextStyle(color: ratio > 100 ? GomaqColors.textoEstado('fuera_de_servicio') : null, fontWeight: ratio > 100 ? FontWeight.w700 : null)));
        case 'hora':
          return derecha(porHora == null ? vacio() : Text(Formato.clp(porHora)));
        case 'dias':
          return derecha(Text.rich(TextSpan(children: [
            TextSpan(text: '${dias.round()}', style: TextStyle(color: dias == 0 ? Colors.black54 : null)),
            TextSpan(text: ' de $diasPeriodo', style: const TextStyle(fontSize: 12, color: Colors.black54)),
          ])));
      }
      return const SizedBox.shrink();
    }

    return InkWell(
      // abre el perfil del equipo directo en su pestaña de costos
      onTap: () => context.push('/flota/${e['id']}?pestana=costos'),
      focusColor: GomaqColors.accion.withValues(alpha: 0.12),
      child: Semantics(
        button: true,
        label: lectura,
        excludeSemantics: true,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: aPerdida ? GomaqColors.estadoNegativo.withValues(alpha: 0.06) : null,
            border: Border(bottom: BorderSide(color: Colors.grey.shade200)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [for (final c in columnas) Expanded(flex: c.flex, child: Padding(padding: const EdgeInsets.only(right: 8), child: celda(c)))],
          ),
        ),
      ),
    );
  }

  Widget _etiquetaPerdida() {
    final color = GomaqColors.textoEstado('fuera_de_servicio');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(color: GomaqColors.estadoNegativo.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(99)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.trending_down, size: 13, color: color),
          const SizedBox(width: 3),
          Text('A pérdida', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color)),
        ],
      ),
    );
  }

  /// Barra que sale del centro: hacia la izquierda y en rojo si se perdió, hacia la derecha y en
  /// verde si se ganó. El largo es proporcional al mayor margen que se ve.
  Widget _barraMargen(double margen, double maxMargen, bool aPerdida) {
    return LayoutBuilder(
      builder: (context, c) {
        final ancho = c.maxWidth.clamp(0.0, 110.0);
        final mitad = ancho / 2;
        final largo = (margen.abs() / maxMargen) * mitad;
        return SizedBox(
          width: ancho,
          height: 8,
          child: Stack(
            children: [
              Container(decoration: BoxDecoration(color: Colors.grey.shade200, borderRadius: BorderRadius.circular(4))),
              if (margen != 0)
                Positioned(
                  left: margen < 0 ? mitad - largo : mitad,
                  width: largo < 2 ? 2 : largo,
                  top: 0,
                  bottom: 0,
                  child: Container(
                    decoration: BoxDecoration(
                      color: aPerdida ? GomaqColors.estadoNegativo : GomaqColors.estadoPositivo,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                ),
              // la línea del cero, para leer de qué lado está cada barra
              Positioned(left: mitad - 0.5, width: 1, top: 0, bottom: 0, child: Container(color: Colors.grey.shade500)),
            ],
          ),
        );
      },
    );
  }

  Widget _pieDeLista() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        children: [
          Text('Mostrando ${_equipos.length} de $_total equipos', style: const TextStyle(fontSize: 12, color: Colors.black54)),
          if (_hayMas) ...[
            const SizedBox(height: 8),
            OutlinedButton(onPressed: _cargandoMas ? null : _cargarMas, child: Text(_cargandoMas ? 'Cargando equipos…' : 'Cargar más')),
          ],
        ],
      ),
    );
  }
}
