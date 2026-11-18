import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/mapa_config.dart';
import '../../utils/mapa_operativo.dart';
import '../../utils/ubicacion.dart';
import '../../utils/direcciones.dart';
import '../../widgets/buscador_direccion.dart';

typedef CargarMapa = Future<DatosMapa> Function();
typedef GuardarBodega = Future<void> Function(Coordenada? ubicacion);

Future<DatosMapa> _cargarDelServidor() async {
  final r = await ApiClient.instance.get('/api/mapa');
  return DatosMapa.fromJson(Map<String, dynamic>.from(r as Map));
}

Future<void> _guardarBodegaEnServidor(Coordenada? c) async {
  await ApiClient.instance.put('/api/mapa/bodega', {'latitud': c?.latitud, 'longitud': c?.longitud});
}

/// Mapa operativo para administrativo y gerente: equipos arrendados (donde están hoy), la bodega y
/// los furgones que van en camino. Al tocar un icono se abre su ficha.
///
/// Los equipos o furgones que todavía no tienen coordenadas no se pierden: van a la lista
/// "Sin ubicación". La posición de un furgón puede tener varios minutos si el técnico va en Maps o
/// Waze, por eso se muestra "hace X min" y no se oculta.
class MapaScreen extends StatefulWidget {
  final CargarMapa cargar;
  final GuardarBodega guardarBodega;
  final ObtenerUbicacion obtenerUbicacion;
  final BuscarDirecciones buscarDirecciones;

  /// false en las pruebas: no se arma el mapa (ni se piden tiles por red), solo el resto.
  final bool conMapa;

  /// Capa de imágenes del mapa. Se reemplaza en las pruebas que sí arman el mapa, para no usar la red.
  final Widget Function() capaImagenes;

  /// Cada cuánto se refresca cuando no hay furgones en camino.
  final Duration refresco;

  /// Cada cuánto se refresca cuando hay furgones en camino (su posición cambia más seguido).
  final Duration refrescoActivo;

  const MapaScreen({
    super.key,
    this.cargar = _cargarDelServidor,
    this.guardarBodega = _guardarBodegaEnServidor,
    this.obtenerUbicacion = obtenerUbicacionActual,
    this.buscarDirecciones = buscarDireccionesEnServidor,
    this.conMapa = true,
    this.capaImagenes = capaTilesMapa,
    this.refresco = const Duration(seconds: 60),
    this.refrescoActivo = const Duration(seconds: 20),
  });

  @override
  State<MapaScreen> createState() => _MapaScreenState();
}

/// Lo que la persona tocó en el mapa o en las listas. Se guarda con claves estables (id de la OT,
/// ids de los equipos) y no con una copia de los datos: la ficha se vuelve a armar desde la carga
/// más reciente, así "Última posición" y la llegada estimada no quedan viejas mientras está abierta.
class _Seleccion {
  final String tipo; // 'furgon', 'equipos' o 'bodega'
  final int? ordenId;
  final Set<int> equipoIds;
  final String titulo;

  const _Seleccion.furgon(this.ordenId, this.titulo) : tipo = 'furgon', equipoIds = const {};
  const _Seleccion.equipos(this.titulo, this.equipoIds) : tipo = 'equipos', ordenId = null;
  const _Seleccion.bodega(this.titulo) : tipo = 'bodega', ordenId = null, equipoIds = const {};
}

class _MapaScreenState extends State<MapaScreen> {
  DatosMapa? _datos;
  bool _cargando = true;
  String? _error;
  Timer? _timer;
  _Seleccion? _seleccion;
  final _focoTitulo = FocusNode(debugLabel: 'titulo de la ficha');
  late final AppLifecycleListener _ciclo;
  // pestaña oculta o app en segundo plano: no se refresca (no tiene sentido gastar red ni batería)
  bool _enSegundoPlano = false;
  bool _mostrarArrendados = true;
  bool _mostrarBodega = true;
  bool _mostrarFurgones = true;
  final _busqueda = TextEditingController();
  final _mapaCtrl = MapController();
  // zoom actual del mapa: decide qué iconos cercanos se juntan en uno
  double _zoom = 10;
  String _consulta = '';
  // hora de la última carga lograda: si el refresco automático falla, la persona lo nota por la edad
  DateTime? _cargadoAt;

  @override
  void initState() {
    super.initState();
    _ciclo = AppLifecycleListener(onStateChange: _alCambiarCiclo);
    _cargar();
  }

  void _alCambiarCiclo(AppLifecycleState estado) {
    final oculto = estado == AppLifecycleState.hidden || estado == AppLifecycleState.paused;
    if (oculto == _enSegundoPlano) return;
    _enSegundoPlano = oculto;
    if (oculto) {
      _timer?.cancel();
    } else {
      // al volver se pone al día de inmediato y se retoma el ritmo normal
      _cargar(silencioso: true);
    }
  }

  /// Un solo temporizador a la vez: 20 s si hay furgones en camino, 60 s si no.
  void _programarRefresco() {
    _timer?.cancel();
    if (!mounted || _enSegundoPlano) return;
    final hayFurgones = _datos?.furgones.isNotEmpty ?? false;
    final espera = hayFurgones ? widget.refrescoActivo : widget.refresco;
    _timer = Timer(espera, () => _cargar(silencioso: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _ciclo.dispose();
    _focoTitulo.dispose();
    _busqueda.dispose();
    _mapaCtrl.dispose();
    super.dispose();
  }

  /// Lo que se escribe en el buscador deja solo lo que coincide y acerca el mapa a esos puntos.
  void _alBuscar(String texto) {
    setState(() => _consulta = texto);
    final datos = _datos;
    if (!widget.conMapa || datos == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final puntos = _marcadores(filtrarDatos(datos, _consulta), agrupar: false).map((m) => m.point).toList();
      if (puntos.isEmpty) return;
      try {
        _mapaCtrl.fitCamera(CameraFit.coordinates(coordinates: puntos, padding: const EdgeInsets.all(56), maxZoom: 15));
      } catch (_) {
        // el mapa todavía no está montado: no pasa nada, queda donde estaba
      }
    });
  }

  /// Lleva el mapa a un punto (al tocar un furgón o un resultado de la lista).
  void _irA(Coordenada? u) {
    if (u == null || !widget.conMapa) return;
    try {
      _mapaCtrl.move(LatLng(u.latitud, u.longitud), 15);
      // el mapa todavia no esta montado: no pasa nada, queda donde estaba
    } catch (_) {}
  }

  Future<void> _cargar({bool silencioso = false}) async {
    if (!silencioso) setState(() => _cargando = true);
    try {
      final d = await widget.cargar();
      if (!mounted) return;
      setState(() {
        _datos = d;
        _error = null;
        _cargadoAt = DateTime.now();
      });
    } on ApiException catch (e) {
      if (mounted && !silencioso) setState(() => _error = e.message);
    } catch (_) {
      if (mounted && !silencioso) setState(() => _error = 'No se pudo cargar el mapa. Revisa tu conexión.');
    } finally {
      if (mounted) setState(() => _cargando = false);
      _programarRefresco();
    }
  }

  void _abrir(_Seleccion s) {
    setState(() => _seleccion = s);
    // el foco va al título de la ficha: quien usa teclado o lector de pantalla llega directo a ella
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _seleccion == s) _focoTitulo.requestFocus();
    });
  }

  void _cerrar() => setState(() => _seleccion = null);

  void _seleccionarEquipos(String titulo, List<EquipoMapa> equipos) =>
      _abrir(_Seleccion.equipos(titulo, {for (final e in equipos) e.id}));

  void _seleccionarFurgon(FurgonMapa f) =>
      _abrir(_Seleccion.furgon(f.ordenTrabajoId, 'Furgón de ${f.mecanicoNombre ?? 'técnico'}'));

  bool _furgonSeleccionado(FurgonMapa f) => _seleccion?.tipo == 'furgon' && _seleccion?.ordenId == f.ordenTrabajoId;

  bool _equipoSeleccionado(Iterable<EquipoMapa> equipos) {
    final s = _seleccion;
    return s != null && s.tipo == 'equipos' && equipos.any((e) => s.equipoIds.contains(e.id));
  }

  @override
  Widget build(BuildContext context) {
    final datos = _datos;
    // Esc cierra la ficha (solo mientras hay una abierta)
    return CallbackShortcuts(
      bindings: {if (_seleccion != null) const SingleActivator(LogicalKeyboardKey.escape): _cerrar},
      child: _contenido(datos),
    );
  }

  Widget _contenido(DatosMapa? datos) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // sin botón de actualizar propio: el del encabezado del panel recarga toda la sección, y el
          // mapa se refresca solo cada 60 s
          // header: el lector de pantalla puede saltar entre encabezados
          Semantics(header: true, child: Text('Mapa operativo', style: Theme.of(context).textTheme.headlineSmall)),
          // debajo del título y no al lado: en un teléfono angosto compartir la fila parte el título
          if (_cargadoAt != null) _indicadorActualizado(_cargadoAt!),
          const SizedBox(height: 8),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              // liveRegion: el lector de pantalla anuncia el error cuando aparece
              child: Semantics(
                liveRegion: true,
                child: Text(_error!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
              ),
            ),
          if (datos == null)
            Expanded(
              child: Center(
                child: _cargando ? const CircularProgressIndicator() : const Text('Aún no hay equipos con ubicación para mostrar en el mapa.'),
              ),
            )
          else ...[
            _campoBusqueda(),
            const SizedBox(height: 8),
            _filtros(filtrarDatos(datos, _consulta)),
            const SizedBox(height: 8),
            Expanded(child: _cuerpo(filtrarDatos(datos, _consulta))),
          ],
        ],
      ),
    );
  }

  /// "Actualizado hace 2 min". Pasados 3 minutos sin lograr una carga nueva se pone en ámbar: el
  /// refresco automático está fallando y lo que se ve ya no es reciente.
  Widget _indicadorActualizado(DateTime desde) {
    final ahora = DateTime.now();
    final atrasado = ahora.difference(desde) > const Duration(minutes: 3);
    final texto = atrasado ? 'Sin actualizar ${haceCuanto(desde, ahora)}' : 'Actualizado ${haceCuanto(desde, ahora)}';
    return Text(
      texto,
      style: TextStyle(fontSize: 12, color: atrasado ? GomaqColors.advertenciaFuerte : Colors.grey.shade700),
    );
  }

  Widget _campoBusqueda() {
    return TextField(
      controller: _busqueda,
      onChanged: _alBuscar,
      textInputAction: TextInputAction.search,
      decoration: InputDecoration(
        isDense: true,
        // etiqueta visible y fija (WCAG 3.3.2): el texto de ayuda desaparece al escribir, la etiqueta no
        labelText: 'Buscar equipo, cliente o técnico',
        hintText: 'Código, tipo, cliente o nombre',
        floatingLabelBehavior: FloatingLabelBehavior.always,
        prefixIcon: const Icon(Icons.search),
        suffixIcon: _consulta.isEmpty
            ? null
            : IconButton(
                tooltip: 'Borrar búsqueda',
                icon: const Icon(Icons.close),
                onPressed: () {
                  _busqueda.clear();
                  _alBuscar('');
                },
              ),
        border: const OutlineInputBorder(),
      ),
    );
  }

  /// Los filtros hacen de leyenda: cada uno lleva el mismo icono y color que su marcador en el mapa.
  Widget _filtros(DatosMapa d) {
    final arrendados = d.equipos.where((e) => e.arrendado).length;
    final enBodega = d.equipos.length - arrendados;
    Widget chip(String texto, Color color, IconData icono, bool activo, ValueChanged<bool> alCambiar) => Padding(
      padding: const EdgeInsets.only(right: 8),
      // el estado no depende solo del color (WCAG 1.4.1): activo = borde grueso, texto en negrita y
      // icono entero; apagado = borde fino, texto normal e icono desvanecido
      child: FilterChip(
        avatar: Opacity(
          opacity: activo ? 1 : 0.45,
          child: CircleAvatar(
            backgroundColor: color,
            child: Icon(icono, size: 14, color: Colors.white),
          ),
        ),
        label: Text(texto, style: TextStyle(fontWeight: activo ? FontWeight.w700 : FontWeight.w400)),
        selected: activo,
        showCheckmark: false,
        side: BorderSide(color: activo ? GomaqColors.accion : const Color(0xFF85736D), width: activo ? 2 : 1),
        onSelected: alCambiar,
      ),
    );
    // en una fila con scroll horizontal: en 375 px los tres no caben en una línea
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          chip(
            'Arrendados ($arrendados)',
            GomaqColors.primario,
            Icons.construction,
            _mostrarArrendados,
            (v) => setState(() => _mostrarArrendados = v),
          ),
          chip(
            'En bodega ($enBodega)',
            GomaqColors.estadoNeutro,
            Icons.warehouse,
            _mostrarBodega,
            (v) => setState(() => _mostrarBodega = v),
          ),
          chip(
            'Furgones en camino (${d.furgones.length})',
            GomaqColors.estadoPositivo,
            Icons.local_shipping,
            _mostrarFurgones,
            (v) => setState(() => _mostrarFurgones = v),
          ),
        ],
      ),
    );
  }

  Widget _cuerpo(DatosMapa d) {
    return LayoutBuilder(
      builder: (context, c) {
        // el mapa nunca va dentro de un scroll: se come los gestos. Arriba con altura fija y las
        // listas en su propio scroll debajo; desde 600 px, el mapa a la izquierda y las listas al lado
        // la ficha no oscurece ni tapa el mapa: va arriba de la columna lateral (ancho) o entre el
        // mapa y las listas (angosto)
        final ficha = _ficha();
        if (c.maxWidth >= 600) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _mapa(d)),
              const SizedBox(width: 12),
              SizedBox(
                width: 320,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (ficha != null) ConstrainedBox(constraints: BoxConstraints(maxHeight: c.maxHeight * 0.6), child: ficha),
                    Expanded(child: _listas(d)),
                  ],
                ),
              ),
            ],
          );
        }
        // el buscador y los filtros ya ocupan la parte alta: el mapa no pasa del 42 % para que la
        // lista de abajo tenga espacio real, y nunca baja de 200 px para poder usarlo
        final alto = c.maxHeight.isFinite ? (c.maxHeight * 0.42).clamp(200.0, 360.0) : 300.0;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(height: alto, child: _mapa(d)),
            const SizedBox(height: 8),
            if (ficha != null) ConstrainedBox(constraints: BoxConstraints(maxHeight: c.maxHeight * 0.38), child: ficha),
            Expanded(child: _listas(d)),
          ],
        );
      },
    );
  }

  Widget _mapa(DatosMapa d) {
    final marcadores = _marcadores(d);
    if (!widget.conMapa) {
      return Container(
        key: const ValueKey('mapa-sin-tiles'),
        color: Colors.grey.shade200,
        alignment: Alignment.center,
        child: Text('${marcadores.length} iconos en el mapa'),
      );
    }
    // el encuadre inicial usa todos los puntos, no los iconos ya juntados
    final puntos = _marcadores(d, agrupar: false).map((m) => m.point).toList();
    return Semantics(
      container: true,
      label: 'Mapa con ${marcadores.length} iconos. Cada icono es un botón que abre su ficha.',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: FlutterMap(
          mapController: _mapaCtrl,
          options: MapOptions(
            initialCenter: const LatLng(-33.45, -70.66),
            initialZoom: 10,
            initialCameraFit: puntos.isEmpty
                ? null
                : CameraFit.coordinates(coordinates: puntos, padding: const EdgeInsets.all(56), maxZoom: 15),
            onMapReady: _alCambiarZoom,
            onPositionChanged: (_, _) => _alCambiarZoom(),
          ),
          children: [
            widget.capaImagenes(),
            // línea punteada del furgón seleccionado al equipo al que va: recta, solo orientativa
            if (_lineaFurgon(d) case final linea?) PolylineLayer(polylines: [linea]),
            MarkerLayer(markers: marcadores),
            atribucionMapa(),
          ],
        ),
      ),
    );
  }

  /// El equipo al que va un furgón, si está en el mapa (con ubicación).
  EquipoMapa? _equipoDestino(FurgonMapa f, DatosMapa d) {
    final id = f.maquinariaId;
    if (id == null) return null;
    return d.equipos.where((e) => e.id == id && e.ubicacion != null).firstOrNull;
  }

  /// Distancia en línea recta de un furgón con posición reciente a su equipo, o null si no se puede
  /// decir (sin posición, posición vieja o el equipo no está en el mapa).
  String? _distanciaAlDestino(FurgonMapa f, DatosMapa d, DateTime ahora) {
    final destino = _equipoDestino(f, d);
    final origen = f.ubicacion;
    final pos = f.posicionAt;
    if (destino == null || origen == null || pos == null || posicionAntigua(pos, ahora)) return null;
    return textoDistancia(distanciaMetros(origen, destino.ubicacion!));
  }

  Polyline? _lineaFurgon(DatosMapa d) {
    final s = _seleccion;
    if (s == null || s.tipo != 'furgon') return null;
    final f = d.furgones.where((f) => f.ordenTrabajoId == s.ordenId).firstOrNull;
    if (f == null || f.ubicacion == null || f.posicionAt == null || posicionAntigua(f.posicionAt!, DateTime.now())) {
      return null;
    }
    final destino = _equipoDestino(f, d);
    if (destino == null) return null;
    final a = f.ubicacion!;
    final b = destino.ubicacion!;
    return Polyline(
      points: [LatLng(a.latitud, a.longitud), LatLng(b.latitud, b.longitud)],
      strokeWidth: 3,
      color: GomaqColors.estadoPositivo,
      pattern: StrokePattern.dashed(segments: const [8, 6]),
    );
  }

  /// Lee el zoom del mapa y, si cambió lo bastante, rehace los iconos (se juntan o se separan).
  void _alCambiarZoom() {
    if (!mounted) return;
    final zoom = _mapaCtrl.camera.zoom;
    if ((zoom - _zoom).abs() < 0.25) return;
    // fuera del ciclo de dibujo: el mapa avisa también mientras se arma
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _zoom = zoom);
    });
  }

  /// Acerca el mapa a un conjunto de puntos (al tocar un icono de "N equipos cercanos").
  void _acercarA(List<List<EquipoMapa>> grupos) {
    final puntos = [for (final g in grupos) LatLng(g.first.ubicacion!.latitud, g.first.ubicacion!.longitud)];
    try {
      _mapaCtrl.fitCamera(CameraFit.coordinates(coordinates: puntos, padding: const EdgeInsets.all(72), maxZoom: 18));
      // el mapa todavia no esta montado: no pasa nada, queda donde estaba
    } catch (_) {}
  }

  List<Marker> _marcadores(DatosMapa d, {bool agrupar = true}) {
    final ahora = DateTime.now();
    final marcas = <Marker>[];
    if (_mostrarArrendados) {
      final grupos = agruparPorPunto(d.equipos.where((e) => e.arrendado).toList());
      final cumulos = agrupar
          ? agruparCercanos(grupos, _zoom, fijo: _equipoSeleccionado)
          : [for (final g in grupos) [g]];
      for (final cumulo in cumulos) {
        if (cumulo.length > 1) {
          // varios puntos que a este zoom se tocarían: un solo icono que al tocarlo acerca el mapa
          final centro = centroGrupos(cumulo);
          final total = cumulo.fold<int>(0, (n, g) => n + g.length);
          marcas.add(
            _marcador(
              LatLng(centro.latitud, centro.longitud),
              GomaqColors.primario,
              Icons.construction,
              total,
              '$total equipos arrendados cercanos, toca para acercar el mapa',
              () => _acercarA(cumulo),
              clave: 'cumulo:${cumulo.map((g) => g.first.id).join(',')}',
            ),
          );
          continue;
        }
        final grupo = cumulo.first;
        final u = grupo.first.ubicacion!;
        marcas.add(
          _marcador(
            LatLng(u.latitud, u.longitud),
            GomaqColors.primario,
            Icons.construction,
            grupo.length,
            'Arrendado: ${grupo.first.clienteNombre ?? grupo.first.codigo}',
            () => _seleccionarEquipos(grupo.first.clienteNombre ?? 'Equipos arrendados', grupo),
            clave: 'equipos:${grupo.map((e) => e.id).join(',')}',
            seleccionado: _equipoSeleccionado(grupo),
          ),
        );
      }
    }
    final bodega = d.bodega;
    final dentro = d.equipos.where((e) => !e.arrendado).toList();
    // buscando, la bodega solo aparece si tiene algún equipo que coincide
    if (_mostrarBodega &&
        bodega != null &&
        bodega.ubicacion != null &&
        (_consulta.trim().isEmpty || dentro.isNotEmpty)) {
      final u = bodega.ubicacion!;
      marcas.add(
        _marcador(
          LatLng(u.latitud, u.longitud),
          GomaqColors.estadoNeutro,
          Icons.warehouse,
          dentro.length,
          bodega.nombre,
          () => _abrir(_Seleccion.bodega(bodega.nombre)),
          clave: 'bodega',
          seleccionado: _seleccion?.tipo == 'bodega',
        ),
      );
    }
    if (_mostrarFurgones) {
      for (final f in d.furgones.where((f) => f.ubicacion != null)) {
        final u = f.ubicacion!;
        final vieja = f.posicionAt != null && posicionAntigua(f.posicionAt!, ahora);
        marcas.add(
          _marcador(
            LatLng(u.latitud, u.longitud),
            vieja ? GomaqColors.grisApagado : GomaqColors.estadoPositivo,
            Icons.local_shipping,
            0,
            'Furgón de ${f.mecanicoNombre ?? 'técnico'}${vieja ? ', posición de hace más de 15 minutos' : (estadoViaje(f, ahora) == EstadoViaje.detenido ? ', detenido' : '')}',
            () => _seleccionarFurgon(f),
            clave: 'furgon:${f.ordenTrabajoId}',
            seleccionado: _furgonSeleccionado(f),
          ),
        );
      }
    }
    return marcas;
  }

  Marker _marcador(
    LatLng punto,
    Color color,
    IconData icono,
    int cuenta,
    String etiqueta,
    VoidCallback alTocar, {
    required String clave,
    bool seleccionado = false,
  }) {
    return Marker(
      point: punto,
      width: seleccionado ? 58 : 48,
      height: seleccionado ? 58 : 48,
      // la clave estable evita que el marcador pierda el foco del teclado cuando el mapa se refresca
      key: ValueKey(clave),
      child: _MarcadorMapa(
        color: color,
        icono: icono,
        cuenta: cuenta,
        etiqueta: etiqueta,
        alTocar: alTocar,
        seleccionado: seleccionado,
      ),
    );
  }

  /// Ficha de lo seleccionado, armada con la carga más reciente (no una copia). Si lo seleccionado
  /// ya no está (el furgón llegó, el equipo cambió de lugar) lo dice y no se cierra sola.
  Widget? _ficha() {
    final s = _seleccion;
    final d = _datos;
    if (s == null || d == null) return null;
    final ahora = DateTime.now();
    final tema = Theme.of(context).textTheme;
    var titulo = s.titulo;
    final cuerpo = <Widget>[];
    switch (s.tipo) {
      case 'furgon':
        final f = d.furgones.where((f) => f.ordenTrabajoId == s.ordenId).firstOrNull;
        if (f == null) {
          cuerpo.add(Semantics(liveRegion: true, child: const Text('Ya no está en camino.')));
        } else {
          titulo = 'Furgón de ${f.mecanicoNombre ?? 'técnico'}';
          if (f.patente != null) {
            cuerpo.add(Text('Vehículo: ${f.patente}${f.vehiculo != null && f.vehiculo!.isNotEmpty ? ' · ${f.vehiculo}' : ''}'));
          }
          cuerpo.add(Text('Va a: ${f.clienteNombre ?? 'cliente sin nombre'} (equipo ${f.maquinariaCodigo})'));
          if (f.etaLlegadaAt != null) {
            cuerpo.add(Text('Llegada estimada: ${_hora(f.etaLlegadaAt!)}${f.etaAproximada ? ' (aproximada)' : ''}'));
          }
          if (f.posicionAt != null) cuerpo.add(Text('Última posición: ${haceCuanto(f.posicionAt!, ahora)}'));
          final distancia = _distanciaAlDestino(f, d, ahora);
          if (distancia != null) {
            cuerpo.add(
              Text('Le quedan $distancia en línea recta (no es la ruta).', style: TextStyle(color: Colors.grey.shade700)),
            );
          }
          final estadoTexto = textoEstadoViaje(f, ahora);
          if (estadoTexto != null) {
            // texto y color de advertencia, nunca solo color; liveRegion para que se anuncie si cambia
            cuerpo.add(
              Semantics(
                liveRegion: true,
                child: Row(
                  children: [
                    const Icon(Icons.info_outline, size: 16, color: GomaqColors.advertenciaFuerte),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        estadoTexto,
                        style: const TextStyle(color: GomaqColors.advertenciaFuerte, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
              ),
            );
            if (estadoViaje(f, ahora) == EstadoViaje.sinSenal) {
              cuerpo.add(
                Text(
                  'El técnico puede ir en Maps o Waze y la app no alcanzó a enviar su posición.',
                  style: TextStyle(color: Colors.grey.shade700, fontSize: 12),
                ),
              );
            }
          }
          cuerpo.add(
            Wrap(
              children: [
                TextButton.icon(
                  onPressed: () => context.push('/ordenes/${f.ordenTrabajoId}'),
                  icon: const Icon(Icons.assignment_outlined),
                  label: const Text('Ver OT'),
                ),
                if (f.maquinariaId != null)
                  Semantics(
                    label: 'Ver equipo ${f.maquinariaCodigo}',
                    excludeSemantics: true,
                    child: TextButton.icon(
                      onPressed: () => context.push('/flota/${f.maquinariaId}'),
                      icon: const Icon(Icons.open_in_new, size: 18),
                      label: const Text('Ver equipo'),
                    ),
                  ),
              ],
            ),
          );
        }
      case 'bodega' || 'equipos':
        final equipos = s.tipo == 'bodega'
            ? d.equipos.where((e) => !e.arrendado).toList()
            : d.equipos.where((e) => s.equipoIds.contains(e.id)).toList();
        if (s.tipo == 'bodega') titulo = d.bodega?.nombre ?? s.titulo;
        cuerpo.add(
          Text(
            equipos.length == 1 ? '1 equipo' : '${equipos.length} equipos',
            style: TextStyle(color: Colors.grey.shade700),
          ),
        );
        if (equipos.isEmpty) {
          cuerpo.add(
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Semantics(
                liveRegion: true,
                child: Text(s.tipo == 'bodega' ? 'No hay equipos aquí.' : 'Ya no hay equipos aquí.'),
              ),
            ),
          );
        }
        for (final e in equipos) {
          cuerpo.add(const Divider(height: 8));
          cuerpo.add(_filaEquipo(e));
          final ot = e.ordenAbierta;
          if (ot != null) {
            // el equipo tiene una OT abierta: se dice con texto (estado y técnico), no en el mapa
            cuerpo.add(
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  children: [
                    const Icon(Icons.assignment_outlined, size: 16),
                    const SizedBox(width: 4),
                    Expanded(child: Text(ot.resumen, style: const TextStyle(fontWeight: FontWeight.w600))),
                  ],
                ),
              ),
            );
          }
          cuerpo.add(
            Wrap(
              children: [
                if (ot != null)
                  Semantics(
                    label: 'Ver OT ${ot.id}',
                    excludeSemantics: true,
                    child: TextButton.icon(
                      onPressed: () => context.push('/ordenes/${ot.id}'),
                      icon: const Icon(Icons.assignment_outlined, size: 18),
                      label: const Text('Ver OT'),
                    ),
                  ),
                Semantics(
                  label: 'Ver equipo ${e.codigo}',
                  excludeSemantics: true,
                  child: TextButton.icon(
                    onPressed: () => context.push('/flota/${e.id}'),
                    icon: const Icon(Icons.open_in_new, size: 18),
                    label: const Text('Ver equipo'),
                  ),
                ),
              ],
            ),
          );
        }
    }
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 4, 8),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Focus(
                      focusNode: _focoTitulo,
                      child: Semantics(
                        header: true,
                        liveRegion: true,
                        child: Text(titulo, style: tema.titleMedium),
                      ),
                    ),
                  ),
                  IconButton(tooltip: 'Cerrar ficha (Esc)', icon: const Icon(Icons.close), onPressed: _cerrar),
                ],
              ),
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: cuerpo),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _filaEquipo(EquipoMapa e, {bool conCliente = true, bool seleccionado = false}) {
    final detalle = [
      if (e.descripcion.isNotEmpty) e.descripcion,
      if (conCliente && e.arrendado && e.clienteNombre != null) 'Cliente: ${e.clienteNombre}',
      if (e.arrendado && e.direccion != null && e.direccion!.isNotEmpty) e.direccion!,
    ].join('\n');
    return ListTile(
      contentPadding: EdgeInsets.zero,
      selected: seleccionado,
      leading: const Icon(Icons.construction),
      title: Text(e.codigo),
      subtitle: detalle.isEmpty ? null : Text(detalle),
      isThreeLine: detalle.contains('\n'),
      trailing: Wrap(
        spacing: 4,
        children: [
          if (e.alertaMantencion)
            const Tooltip(
              message: 'Mantención por vencer',
              child: Icon(Icons.build_circle_outlined, color: GomaqColors.advertenciaFuerte),
            ),
          // un Chip se anunciaba como casilla por lector de pantalla; esto es solo una etiqueta de estado
          // (texto + color, nunca solo color)
          Semantics(
            label: 'Estado: ${_estadoLegible(e.estado)}',
            excludeSemantics: true,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: GomaqColors.fondoChip(e.estado),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: GomaqColors.textoEstado(e.estado).withValues(alpha: 0.6)),
              ),
              child: Text(
                _estadoLegible(e.estado),
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: GomaqColors.textoEstado(e.estado)),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _estadoLegible(String estado) => switch (estado) {
    'operativa' => 'Operativa',
    'en_mantencion' => 'En mantención',
    'fuera_de_servicio' => 'Fuera de servicio',
    _ => estado,
  };

  String _hora(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  Widget _listas(DatosMapa d) {
    final ahora = DateTime.now();
    final sinUbicacion = d.equiposSinUbicacion;
    final sinPosicion = d.furgonesSinPosicion;
    final conPosicion = d.furgones.where((f) => f.ubicacion != null).toList();
    final buscando = _consulta.trim().isNotEmpty;
    return ListView(
      children: [
        if (buscando) ...[
          _titulo('Resultados (${d.equipos.length + d.furgones.length})'),
          if (d.equipos.isEmpty && d.furgones.isEmpty)
            const Padding(
              padding: EdgeInsets.only(bottom: 8),
              child: Text('Nada coincide. Prueba con el código del equipo, el cliente o el nombre del técnico.'),
            ),
          // tocar un resultado lo muestra en el mapa y abre su ficha
          for (final e in d.equipos)
            InkWell(
              onTap: () {
                _irA(e.ubicacion);
                _seleccionarEquipos(e.clienteNombre ?? e.codigo, [e]);
              },
              child: _filaEquipo(e, seleccionado: _equipoSeleccionado([e])),
            ),
          const SizedBox(height: 12),
        ],
        _tarjetaBodega(d.bodega),
        if (d.furgones.isNotEmpty) ...[
          const SizedBox(height: 12),
          _titulo('Furgones en camino (${d.furgones.length})'),
          if (conPosicion.any((f) => f.posicionAt != null && posicionAntigua(f.posicionAt!, ahora)))
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                'En gris: la última posición tiene más de 15 minutos (el técnico puede ir en Maps o Waze).',
                style: TextStyle(color: Colors.grey.shade700, fontSize: 12),
              ),
            ),
          for (final f in conPosicion)
            ListTile(
              dense: true,
              selected: _furgonSeleccionado(f),
              selectedTileColor: GomaqColors.primario.withValues(alpha: 0.12),
              leading: Icon(
                Icons.local_shipping,
                color: f.posicionAt != null && posicionAntigua(f.posicionAt!, ahora)
                    ? GomaqColors.grisApagado
                    : GomaqColors.estadoPositivo,
              ),
              title: Text(f.mecanicoNombre ?? 'Técnico'),
              subtitle: Text(
                '${f.clienteNombre ?? 'Cliente'} · ${f.posicionAt == null ? 'sin hora' : haceCuanto(f.posicionAt!, ahora)}'
                '${textoEstadoViaje(f, ahora) == null ? '' : '\n${textoEstadoViaje(f, ahora)}'}',
              ),
              isThreeLine: textoEstadoViaje(f, ahora) != null,
              onTap: () {
                _irA(f.ubicacion);
                _seleccionarFurgon(f);
              },
            ),
          for (final f in sinPosicion)
            ListTile(
              dense: true,
              selected: _furgonSeleccionado(f),
              selectedTileColor: GomaqColors.primario.withValues(alpha: 0.12),
              leading: const Icon(Icons.local_shipping_outlined),
              title: Text(f.mecanicoNombre ?? 'Técnico'),
              subtitle: Text('${f.clienteNombre ?? 'Cliente'} · todavía sin posición'),
              onTap: () => _seleccionarFurgon(f),
            ),
        ],
        if (sinUbicacion.isNotEmpty) ...[
          const SizedBox(height: 12),
          _titulo('Sin ubicación en el mapa (${sinUbicacion.length})'),
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              d.bodega?.ubicacion == null
                  ? 'Los equipos en bodega aparecen aquí hasta que cargues la ubicación de la bodega. Los arrendados, hasta que su cliente o su guía tengan ubicación.'
                  : 'Arrendados cuyo cliente y guía aún no tienen ubicación.',
              style: TextStyle(color: Colors.grey.shade700, fontSize: 12),
            ),
          ),
          for (final e in sinUbicacion) _filaEquipo(e),
        ],
      ],
    );
  }

  // encabezado para el lector de pantalla; con liveRegion anuncia el nuevo total cuando cambia
  // (por ejemplo "Resultados (2)" al escribir en el buscador)
  Widget _titulo(String texto) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Semantics(header: true, liveRegion: true, child: Text(texto, style: Theme.of(context).textTheme.titleSmall)),
  );

  Widget _tarjetaBodega(BodegaMapa? bodega) {
    final ubicacion = bodega?.ubicacion;
    if (bodega == null) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              const Icon(Icons.warehouse),
              const SizedBox(width: 8),
              Expanded(child: Text('No hay una bodega registrada.', style: Theme.of(context).textTheme.bodyMedium)),
            ],
          ),
        ),
      );
    }
    if (ubicacion == null) {
      // falta la ubicación: tarjeta destacada con borde, icono y texto (el estado no va solo en color)
      return Card(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: GomaqColors.advertenciaFuerte, width: 2),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.warning_amber_rounded, color: GomaqColors.advertenciaFuerte),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        'La bodega no tiene ubicación',
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              FilledButton.icon(
                onPressed: () => _editarBodega(bodega),
                icon: const Icon(Icons.edit_location_alt_outlined),
                label: const Text('Cargar ubicación'),
              ),
            ],
          ),
        ),
      );
    }
    // ubicada: una sola línea chica
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 4,
          children: [
            const Icon(Icons.check_circle, color: GomaqColors.estadoPositivo, size: 20),
            const SizedBox(width: 4),
            const Text('Bodega ubicada'),
            IconButton(
              tooltip: 'Centrar el mapa en la bodega',
              onPressed: () => _irA(ubicacion),
              icon: const Icon(Icons.my_location),
            ),
            TextButton(onPressed: () => _editarBodega(bodega), child: const Text('Cambiar ubicación')),
          ],
        ),
      ),
    );
  }

  Future<void> _editarBodega(BodegaMapa bodega) async {
    Coordenada? valor = bodega.ubicacion;
    String? error;
    bool guardando = false;
    final guardada = await showDialog<bool>(
      context: context,
      builder: (dialogo) => StatefulBuilder(
        builder: (context, redibujar) => AlertDialog(
          title: const Text('Ubicación de la bodega'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Escribe la dirección y elige una sugerencia. Si estás en la bodega, también puedes usar tu ubicación.',
                ),
                const SizedBox(height: 12),
                BuscadorDireccion(
                  valor: valor,
                  buscar: widget.buscarDirecciones,
                  obtenerUbicacion: widget.obtenerUbicacion,
                  conMapa: widget.conMapa,
                  onChanged: (c) => redibujar(() => valor = c),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(error!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: guardando ? null : () => Navigator.pop(dialogo, false),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: guardando
                  ? null
                  : () async {
                      redibujar(() {
                        guardando = true;
                        error = null;
                      });
                      try {
                        await widget.guardarBodega(valor);
                        if (dialogo.mounted) Navigator.pop(dialogo, true);
                      } on ApiException catch (e) {
                        redibujar(() {
                          guardando = false;
                          error = e.message;
                        });
                      } catch (_) {
                        redibujar(() {
                          guardando = false;
                          error = 'No se pudo guardar. Revisa tu conexión.';
                        });
                      }
                    },
              child: const Text('Guardar'),
            ),
          ],
        ),
      ),
    );
    if (guardada == true) {
      await _cargar(silencioso: true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ubicación de la bodega guardada.')));
      }
    }
  }
}

/// Icono del mapa que se puede usar con teclado y lector de pantalla, no solo con el mouse:
/// - se alcanza con Tab y se abre con Enter o Espacio (un GestureDetector solo responde al toque);
/// - con el foco se dibuja un aro oscuro grueso, bien visible sobre cualquier mapa;
/// - el lector de pantalla lee un solo texto ("Bodega central, 3 equipos") en vez de un icono y un
///   número suelto.
class _MarcadorMapa extends StatefulWidget {
  final Color color;
  final IconData icono;
  final int cuenta;
  final String etiqueta;
  final VoidCallback alTocar;

  /// El icono cuya ficha está abierta: más grande y con aro oscuro (no depende solo del color).
  final bool seleccionado;

  const _MarcadorMapa({
    required this.color,
    required this.icono,
    required this.cuenta,
    required this.etiqueta,
    required this.alTocar,
    this.seleccionado = false,
  });

  @override
  State<_MarcadorMapa> createState() => _MarcadorMapaState();
}

class _MarcadorMapaState extends State<_MarcadorMapa> {
  bool _enfocado = false;

  @override
  Widget build(BuildContext context) {
    final etiqueta = widget.cuenta > 1 ? '${widget.etiqueta}, ${widget.cuenta} equipos' : widget.etiqueta;
    return Semantics(
      button: true,
      focusable: true,
      focused: _enfocado,
      label: etiqueta,
      excludeSemantics: true,
      onTap: widget.alTocar,
      child: FocusableActionDetector(
        mouseCursor: SystemMouseCursors.click,
        onShowFocusHighlight: (v) => setState(() => _enfocado = v),
        // Enter y Espacio abren la ficha. En la web el Enter no activaba el icono con el atajo por defecto
        // (sí el Espacio), así que se declara aquí, junto al icono
        shortcuts: const {
          SingleActivator(LogicalKeyboardKey.enter): ActivateIntent(),
          SingleActivator(LogicalKeyboardKey.numpadEnter): ActivateIntent(),
          SingleActivator(LogicalKeyboardKey.space): ActivateIntent(),
        },
        actions: {
          ActivateIntent: CallbackAction<ActivateIntent>(
            onInvoke: (_) {
              widget.alTocar();
              return null;
            },
          ),
        },
        child: GestureDetector(
          onTap: widget.alTocar,
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.center,
            children: [
              Container(
                width: widget.seleccionado ? 52 : 44,
                height: widget.seleccionado ? 52 : 44,
                decoration: BoxDecoration(
                  color: widget.color,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: (_enfocado || widget.seleccionado) ? Colors.black : Colors.white,
                    width: (_enfocado || widget.seleccionado) ? 4 : 2,
                  ),
                  boxShadow: const [BoxShadow(blurRadius: 4, color: Colors.black26)],
                ),
                child: Icon(widget.icono, color: Colors.white, size: 22),
              ),
              if (widget.cuenta > 1)
                Positioned(
                  right: -2,
                  top: -2,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(10)),
                    child: Text(
                      '${widget.cuenta}',
                      style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
