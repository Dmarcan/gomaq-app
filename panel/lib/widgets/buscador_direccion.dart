import 'dart:async';

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
    setState(() => _valor = c);
    widget.onChanged(c);
  }

  void _quitar() {
    _texto.clear();
    _espera?.cancel();
    _secuencia++;
    setState(() {
      _valor = null;
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
                label: 'Mapa con el punto marcado. Tocarlo mueve el punto; no hace falta si ya está bien.',
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: FlutterMap(
                    mapController: _mapa,
                    options: MapOptions(
                      initialCenter: LatLng(valor.latitud, valor.longitud),
                      initialZoom: 17,
                      onTap: (_, punto) => _ajustar(punto),
                    ),
                    children: [
                      widget.capaImagenes(),
                      MarkerLayer(
                        markers: [
                          Marker(
                            point: LatLng(valor.latitud, valor.longitud),
                            width: 40,
                            height: 40,
                            alignment: Alignment.topCenter,
                            child: const Icon(Icons.location_on, color: GomaqColors.accion, size: 40),
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
          if (widget.conMapa)
            Text(
              'Si el punto no cae justo, toca el mapa para ajustarlo.',
              style: TextStyle(color: Colors.grey.shade700, fontSize: 12),
            ),
        ],
      ],
    );
  }
}
