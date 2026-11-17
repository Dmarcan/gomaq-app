import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../services/api_client.dart';
import '../theme/gomaq_theme.dart';
import '../utils/direcciones.dart';
import '../utils/mapa_config.dart';
import '../utils/ubicacion.dart';

/// Ubicar un lugar escribiendo su dirección, como en Mercado Libre: a medida que se escribe
/// aparecen sugerencias; al elegir una se ve el punto en un mapa, y si no cae exacto se toca el
/// mapa para ajustarlo. Nadie tiene que conocer ni escribir coordenadas.
///
/// Opcionalmente ofrece también "Usar mi ubicación actual" ([obtenerUbicacion]), útil cuando quien
/// lo usa está físicamente en el lugar (por ejemplo la bodega).
///
/// Cuida el cupo del servicio de direcciones: no busca con menos de 3 letras, espera a que se deje
/// de escribir y descarta respuestas viejas que llegan fuera de orden.
class BuscadorDireccion extends StatefulWidget {
  final Coordenada? valor;
  final ValueChanged<Coordenada?> onChanged;
  final BuscarDirecciones buscar;
  final ObtenerUbicacion? obtenerUbicacion;

  /// false en las pruebas: no se arma el mapa (ni se piden imágenes por red).
  final bool conMapa;
  final Duration espera;
  final String etiqueta;

  /// Dirección ya escrita (la del cliente, por ejemplo). Se precarga y, si todavía no hay punto
  /// marcado, se buscan sus sugerencias al abrir.
  final String? textoInicial;

  /// Capa de imágenes del mapa. Se reemplaza en las pruebas para no pedir imágenes por red.
  final Widget Function() capaImagenes;

  const BuscadorDireccion({
    super.key,
    required this.valor,
    required this.onChanged,
    this.buscar = buscarDireccionesEnServidor,
    this.obtenerUbicacion,
    this.conMapa = true,
    this.espera = const Duration(milliseconds: 450),
    this.etiqueta = 'Escribe la dirección',
    this.textoInicial,
    this.capaImagenes = capaTilesMapa,
  });

  @override
  State<BuscadorDireccion> createState() => _BuscadorDireccionState();
}

class _BuscadorDireccionState extends State<BuscadorDireccion> {
  static const _minLetras = 3;

  final _texto = TextEditingController();
  final _mapa = MapController();
  Timer? _espera;
  int _secuencia = 0;
  List<SugerenciaDireccion> _sugerencias = [];
  bool _buscando = false;
  bool _buscandoGps = false;
  String? _error;
  Coordenada? _valor;
  // la sugerencia elegida solo ubicó la calle (no el número): se avisa hasta que se ajuste el punto
  bool _soloCalle = false;
  bool _arrastrando = false;
  // texto con el que se buscó por última vez: no se repite la misma consulta
  String _ultimaBusqueda = '';

  @override
  void initState() {
    super.initState();
    _valor = widget.valor;
    final inicial = widget.textoInicial?.trim() ?? '';
    if (inicial.isNotEmpty) {
      _texto.text = inicial;
      if (_valor == null && inicial.length >= _minLetras) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _buscar(inicial);
        });
      }
    }
  }

  @override
  void didUpdateWidget(covariant BuscadorDireccion anterior) {
    super.didUpdateWidget(anterior);
    if (widget.valor != anterior.valor && widget.valor != _valor) _valor = widget.valor;
  }

  @override
  void dispose() {
    _espera?.cancel();
    _texto.dispose();
    _mapa.dispose();
    super.dispose();
  }

  void _alEscribir(String texto) {
    _espera?.cancel();
    final t = texto.trim();
    if (t.length < _minLetras) {
      _secuencia++; // una respuesta que venga en camino ya no corresponde
      setState(() {
        _sugerencias = [];
        _buscando = false;
        _error = null;
        _ultimaBusqueda = '';
      });
      return;
    }
    _espera = Timer(widget.espera, () => _buscar(t));
  }

  Future<void> _buscar(String texto) async {
    if (texto == _ultimaBusqueda) return;
    _ultimaBusqueda = texto;
    final mia = ++_secuencia;
    setState(() {
      _buscando = true;
      _error = null;
    });
    try {
      final r = await widget.buscar(texto);
      if (!mounted || mia != _secuencia) return;
      setState(() {
        _sugerencias = r;
        _error = r.isEmpty ? 'No encontré esa dirección. Prueba con la calle y la comuna.' : null;
      });
    } on ApiException catch (e) {
      if (mounted && mia == _secuencia) setState(() => _error = e.message);
    } catch (_) {
      if (mounted && mia == _secuencia) setState(() => _error = 'No se pudo buscar la dirección. Revisa tu conexión.');
    } finally {
      if (mounted && mia == _secuencia) setState(() => _buscando = false);
    }
  }

  void _elegir(SugerenciaDireccion s) {
    _espera?.cancel();
    _secuencia++;
    _texto.text = s.etiqueta;
    _texto.selection = TextSelection.collapsed(offset: _texto.text.length);
    setState(() {
      _valor = s.ubicacion;
      _soloCalle = s.aproximada;
      _sugerencias = [];
      _error = null;
      _buscando = false;
      _ultimaBusqueda = s.etiqueta;
    });
    widget.onChanged(s.ubicacion);
    if (widget.conMapa) {
      // el mapa recién aparece en este cuadro: se mueve cuando ya existe
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _mapa.move(LatLng(s.ubicacion.latitud, s.ubicacion.longitud), 17);
      });
    }
  }

  void _ajustar(LatLng punto) {
    final c = Coordenada(punto.latitude, punto.longitude);
    setState(() {
      _valor = c;
      _soloCalle = false; // la persona ya dejó el punto donde quiso
    });
    widget.onChanged(c);
  }

  /// Zoom actual del mapa; 17 si todavía no está montado (o no hay mapa, como en las pruebas).
  double _zoomActual() {
    if (!widget.conMapa) return 17;
    try {
      return _mapa.camera.zoom;
    } catch (_) {
      return 17;
    }
  }

  /// Mueve el punto con las flechas (teclado y lector de pantalla). Cada pulsación son unos 12 px del
  /// mapa, así el paso se adapta al zoom. [norte] y [este] valen -1, 0 o 1.
  void _mover({int norte = 0, int este = 0}) {
    final v = _valor;
    if (v == null) return;
    final gradosPorPixel = 360 / (256 * math.pow(2, _zoomActual()));
    const pixeles = 12;
    final lat = (v.latitud + norte * gradosPorPixel * pixeles * math.cos(v.latitud * math.pi / 180)).clamp(-85.0, 85.0);
    final lng = (v.longitud + este * gradosPorPixel * pixeles).clamp(-180.0, 180.0);
    _ajustar(LatLng(lat, lng));
  }

  /// Arrastre del pin: la posición del punto en pantalla se corre lo que se movió el dedo y se
  /// convierte de nuevo a coordenada con la cámara del mapa. Solo se avisa al terminar el gesto.
  void _arrastrar(Offset delta) {
    final v = _valor;
    if (v == null) return;
    try {
      final camara = _mapa.camera;
      final nueva = camara.screenOffsetToLatLng(camara.latLngToScreenOffset(LatLng(v.latitud, v.longitud)) + delta);
      setState(() {
        _valor = Coordenada(nueva.latitude, nueva.longitude);
        _soloCalle = false;
      });
    } catch (_) {
      // el mapa todavía no está montado: el arrastre no hace nada
    }
  }

  void _terminarArrastre() {
    final v = _valor;
    if (_arrastrando) setState(() => _arrastrando = false);
    if (v != null) widget.onChanged(v);
  }

  void _quitar() {
    _texto.clear();
    _espera?.cancel();
    _secuencia++;
    setState(() {
      _valor = null;
      _soloCalle = false;
      _sugerencias = [];
      _error = null;
      _ultimaBusqueda = '';
    });
    widget.onChanged(null);
  }

  Future<void> _usarMiUbicacion() async {
    final obtener = widget.obtenerUbicacion;
    if (obtener == null) return;
    setState(() {
      _buscandoGps = true;
      _error = null;
    });
    try {
      final c = await obtener();
      if (!mounted) return;
      _espera?.cancel();
      _secuencia++;
      setState(() {
        _valor = c;
        _soloCalle = false;
        _sugerencias = [];
      });
      widget.onChanged(c);
      if (widget.conMapa) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _mapa.move(LatLng(c.latitud, c.longitud), 17);
        });
      }
    } on UbicacionException catch (e) {
      if (mounted) setState(() => _error = mensajeUbicacion(e.motivo));
    } catch (_) {
      if (mounted) setState(() => _error = mensajeUbicacion(MotivoUbicacion.otro));
    } finally {
      if (mounted) setState(() => _buscandoGps = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final valor = _valor;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        TextField(
          controller: _texto,
          onChanged: _alEscribir,
          // Enter elige la primera sugerencia: se escribe, se da Enter y listo, sin tocar con el mouse
          onSubmitted: (_) {
            if (_sugerencias.isNotEmpty) _elegir(_sugerencias.first);
          },
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            labelText: widget.etiqueta,
            hintText: 'Calle, número y comuna',
            prefixIcon: const Icon(Icons.search),
            suffixIcon: _buscando
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                  )
                : null,
            border: const OutlineInputBorder(),
          ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            // liveRegion: el lector de pantalla anuncia el mensaje cuando aparece (sin resultados, sin red…)
            child: Semantics(
              liveRegion: true,
              child: Text(_error!, style: const TextStyle(color: GomaqColors.estadoNegativo)),
            ),
          ),
        if (_sugerencias.isNotEmpty)
          // las sugerencias aparecen sin que la persona haga nada más: sin este aviso, quien usa lector de
          // pantalla no se entera de que llegaron ni de cómo elegirlas
          Semantics(
            container: true,
            liveRegion: true,
            label: _sugerencias.length == 1
                ? '1 sugerencia de dirección. Enter la elige.'
                : '${_sugerencias.length} sugerencias de dirección. Enter elige la primera; con Tab recorres las demás.',
            child: Container(
              margin: const EdgeInsets.only(top: 4),
              decoration: BoxDecoration(
                border: Border.all(color: GomaqColors.grisApagado),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final s in _sugerencias)
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.place_outlined),
                      title: Text(s.etiqueta),
                      subtitle: s.aproximada
                          ? const Text('Ubica la calle, no el número: ajusta el punto en el mapa')
                          : null,
                      onTap: () => _elegir(s),
                    ),
                ],
              ),
            ),
          ),
        if (widget.obtenerUbicacion != null)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: _buscandoGps ? null : _usarMiUbicacion,
              icon: _buscandoGps
                  ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.my_location),
              label: Text(_buscandoGps ? 'Buscando tu ubicación…' : 'Usar mi ubicación actual'),
            ),
          ),
        if (valor != null) ...[
          const SizedBox(height: 8),
          if (widget.conMapa)
            SizedBox(
              height: 200,
              // el mapa solo se ajusta tocando: se dice, y se avisa que sin tocar el punto ya es válido
              child: Semantics(
                container: true,
                label: 'Mapa con el punto marcado. Tocar el mapa o arrastrar el punto lo mueve; no hace falta si ya está bien.',
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: FlutterMap(
                    mapController: _mapa,
                    options: MapOptions(
                      initialCenter: LatLng(valor.latitud, valor.longitud),
                      initialZoom: 17,
                      onTap: (_, punto) => _ajustar(punto),
                      // mientras se arrastra el pin el mapa no se desplaza: los dos gestos compiten
                      interactionOptions: InteractionOptions(
                        flags: _arrastrando ? InteractiveFlag.none : InteractiveFlag.all,
                      ),
                    ),
                    children: [
                      widget.capaImagenes(),
                      MarkerLayer(
                        markers: [
                          Marker(
                            point: LatLng(valor.latitud, valor.longitud),
                            width: 48,
                            height: 48,
                            alignment: Alignment.topCenter,
                            // el pin se arrastra con el dedo o el mouse; con teclado y lector de pantalla
                            // están las flechas de abajo
                            child: Semantics(
                              label: 'Punto de la ubicación. Se arrastra para ajustarlo; también puedes usar las flechas bajo el mapa.',
                              child: Listener(
                                key: const ValueKey('pin-ubicacion'),
                                behavior: HitTestBehavior.opaque,
                                onPointerDown: (_) => setState(() => _arrastrando = true),
                                onPointerMove: (e) => _arrastrar(e.delta),
                                onPointerUp: (_) => _terminarArrastre(),
                                onPointerCancel: (_) => _terminarArrastre(),
                                child: const Icon(Icons.location_on, color: GomaqColors.accion, size: 48),
                              ),
                            ),
                          ),
                        ],
                      ),
                      atribucionMapa(),
                    ],
                  ),
                ),
              ),
            ),
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            children: [
              const Icon(Icons.check_circle, color: GomaqColors.estadoPositivo, size: 20),
              // se anuncia al elegir una sugerencia: es la confirmación de que la dirección quedó marcada
              Semantics(liveRegion: true, child: const Text('Ubicación marcada')),
              TextButton(onPressed: _quitar, child: const Text('Quitar')),
            ],
          ),
          if (_soloCalle)
            // el aviso va bajo el mapa, visible y anunciado: dice qué pasó y qué hacer. Lleva borde e
            // icono además del color, para que no dependa de verlo
            Semantics(
              container: true,
              liveRegion: true,
              child: Container(
                key: const ValueKey('aviso-solo-calle'),
                margin: const EdgeInsets.only(top: 4),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: GomaqColors.advertenciaFuerte.withValues(alpha: 0.08),
                  border: Border.all(color: GomaqColors.advertenciaFuerte, width: 1.5),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.warning_amber_rounded, color: GomaqColors.advertenciaFuerte),
                    SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Encontramos la calle, pero no el número. '
                        'Arrastra el punto o toca el mapa para dejarlo en el lugar exacto.',
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (widget.conMapa && !_soloCalle)
            Text(
              'Si el punto no cae justo, arrástralo o toca el mapa para ajustarlo.',
              style: TextStyle(color: Colors.grey.shade700, fontSize: 12),
            ),
          // flechas: mover el punto sin mouse ni dedo (teclado: Tab y Enter o Espacio)
          Semantics(
            container: true,
            label: 'Mover el punto',
            child: Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 4,
              children: [
                const Text('Mover el punto:'),
                IconButton(
                  tooltip: 'Mover el punto al norte',
                  onPressed: () => _mover(norte: 1),
                  icon: const Icon(Icons.arrow_upward),
                ),
                IconButton(
                  tooltip: 'Mover el punto al sur',
                  onPressed: () => _mover(norte: -1),
                  icon: const Icon(Icons.arrow_downward),
                ),
                IconButton(
                  tooltip: 'Mover el punto al oeste',
                  onPressed: () => _mover(este: -1),
                  icon: const Icon(Icons.arrow_back),
                ),
                IconButton(
                  tooltip: 'Mover el punto al este',
                  onPressed: () => _mover(este: 1),
                  icon: const Icon(Icons.arrow_forward),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
