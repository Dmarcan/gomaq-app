import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
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
  final Duration refresco;

  const MapaScreen({
    super.key,
    this.cargar = _cargarDelServidor,
    this.guardarBodega = _guardarBodegaEnServidor,
    this.obtenerUbicacion = obtenerUbicacionActual,
    this.buscarDirecciones = buscarDireccionesEnServidor,
    this.conMapa = true,
    this.capaImagenes = capaTilesMapa,
    this.refresco = const Duration(seconds: 60),
  });

  @override
  State<MapaScreen> createState() => _MapaScreenState();
}

class _MapaScreenState extends State<MapaScreen> {
  DatosMapa? _datos;
  bool _cargando = true;
  String? _error;
  Timer? _timer;
  bool _mostrarArrendados = true;
  bool _mostrarBodega = true;
  bool _mostrarFurgones = true;
  final _busqueda = TextEditingController();
  final _mapaCtrl = MapController();
  String _consulta = '';
  // hora de la última carga lograda: si el refresco automático falla, la persona lo nota por la edad
  DateTime? _cargadoAt;

  @override
  void initState() {
    super.initState();
    _cargar();
    _timer = Timer.periodic(widget.refresco, (_) => _cargar(silencioso: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
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
      final puntos = _marcadores(filtrarDatos(datos, _consulta)).map((m) => m.point).toList();
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
    }
  }

  @override
  Widget build(BuildContext context) {
    final datos = _datos;
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
                child: _cargando ? const CircularProgressIndicator() : const Text('No hay datos para mostrar.'),
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
        if (c.maxWidth >= 600) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _mapa(d)),
              const SizedBox(width: 12),
              SizedBox(width: 320, child: _listas(d)),
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
            Expanded(child: _listas(d)),
          ],
        );
      },
    );
  }

  // ---------------------------------------------------------------------------------- mapa

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
    final puntos = marcadores.map((m) => m.point).toList();
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
          ),
          children: [
            widget.capaImagenes(),
            MarkerLayer(markers: marcadores),
            atribucionMapa(),
          ],
        ),
      ),
    );
  }

  List<Marker> _marcadores(DatosMapa d) {
    final ahora = DateTime.now();
    final marcas = <Marker>[];
    if (_mostrarArrendados) {
      for (final grupo in agruparPorPunto(d.equipos.where((e) => e.arrendado).toList())) {
        final u = grupo.first.ubicacion!;
        marcas.add(
          _marcador(
            LatLng(u.latitud, u.longitud),
            GomaqColors.primario,
            Icons.construction,
            grupo.length,
            'Arrendado: ${grupo.first.clienteNombre ?? grupo.first.codigo}',
            () => _fichaEquipos(grupo.first.clienteNombre ?? 'Equipos arrendados', grupo),
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
          () => _fichaEquipos(bodega.nombre, dentro),
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
            'Furgón de ${f.mecanicoNombre ?? 'técnico'}${vieja ? ', posición de hace más de 15 minutos' : ''}',
            () => _fichaFurgon(f),
          ),
        );
      }
    }
    return marcas;
  }

  Marker _marcador(LatLng punto, Color color, IconData icono, int cuenta, String etiqueta, VoidCallback alTocar) {
    return Marker(
      point: punto,
      width: 48,
      height: 48,
      child: _MarcadorMapa(color: color, icono: icono, cuenta: cuenta, etiqueta: etiqueta, alTocar: alTocar),
    );
  }

  // ---------------------------------------------------------------------------------- fichas

  void _fichaEquipos(String titulo, List<EquipoMapa> equipos) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            children: [
              Text(titulo, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text(
                equipos.length == 1 ? '1 equipo' : '${equipos.length} equipos',
                style: TextStyle(color: Colors.grey.shade700),
              ),
              const Divider(),
              if (equipos.isEmpty)
                const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('No hay equipos aquí.')),
              for (final e in equipos) _filaEquipo(e),
            ],
          ),
        ),
      ),
    );
  }

  Widget _filaEquipo(EquipoMapa e, {bool conCliente = true}) {
    final detalle = [
      if (e.descripcion.isNotEmpty) e.descripcion,
      if (conCliente && e.arrendado && e.clienteNombre != null) 'Cliente: ${e.clienteNombre}',
      if (e.arrendado && e.direccion != null && e.direccion!.isNotEmpty) e.direccion!,
    ].join('\n');
    return ListTile(
      contentPadding: EdgeInsets.zero,
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

  void _fichaFurgon(FurgonMapa f) {
    final ahora = DateTime.now();
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Furgón de ${f.mecanicoNombre ?? 'técnico'}', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              if (f.patente != null)
                Text('Vehículo: ${f.patente}${f.vehiculo != null && f.vehiculo!.isNotEmpty ? ' · ${f.vehiculo}' : ''}'),
              Text('Va a: ${f.clienteNombre ?? 'cliente sin nombre'} (equipo ${f.maquinariaCodigo})'),
              if (f.etaLlegadaAt != null)
                Text('Llegada estimada: ${_hora(f.etaLlegadaAt!)}${f.etaAproximada ? ' (aproximada)' : ''}'),
              if (f.posicionAt != null) Text('Última posición: ${haceCuanto(f.posicionAt!, ahora)}'),
            ],
          ),
        ),
      ),
    );
  }

  String _hora(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  // ---------------------------------------------------------------------------------- listas

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
                _fichaEquipos(e.clienteNombre ?? e.codigo, [e]);
              },
              child: _filaEquipo(e),
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
              leading: Icon(
                Icons.local_shipping,
                color: f.posicionAt != null && posicionAntigua(f.posicionAt!, ahora)
                    ? GomaqColors.grisApagado
                    : GomaqColors.estadoPositivo,
              ),
              title: Text(f.mecanicoNombre ?? 'Técnico'),
              subtitle: Text(
                '${f.clienteNombre ?? 'Cliente'} · ${f.posicionAt == null ? 'sin hora' : haceCuanto(f.posicionAt!, ahora)}',
              ),
              onTap: () {
                _irA(f.ubicacion);
                _fichaFurgon(f);
              },
            ),
          for (final f in sinPosicion)
            ListTile(
              dense: true,
              leading: const Icon(Icons.local_shipping_outlined),
              title: Text(f.mecanicoNombre ?? 'Técnico'),
              subtitle: Text('${f.clienteNombre ?? 'Cliente'} · todavía sin posición'),
              onTap: () => _fichaFurgon(f),
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
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.warehouse),
                const SizedBox(width: 8),
                Expanded(child: Text('Ubicación de la bodega', style: Theme.of(context).textTheme.titleSmall)),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              bodega == null
                  ? 'No hay una bodega registrada.'
                  : ubicacion == null
                  ? 'Sin ubicación cargada.'
                  : 'Ubicación cargada.',
            ),
            if (bodega != null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: () => _editarBodega(bodega),
                  icon: const Icon(Icons.edit_location_alt_outlined),
                  label: Text(ubicacion == null ? 'Cargar ubicación' : 'Cambiar ubicación'),
                ),
              ),
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

  const _MarcadorMapa({
    required this.color,
    required this.icono,
    required this.cuenta,
    required this.etiqueta,
    required this.alTocar,
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
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: widget.color,
                  shape: BoxShape.circle,
                  border: Border.all(color: _enfocado ? Colors.black : Colors.white, width: _enfocado ? 4 : 2),
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
