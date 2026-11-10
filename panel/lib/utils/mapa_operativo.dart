import 'dart:math' as math;

import 'ubicacion.dart';

/// Datos del mapa operativo (GET /api/mapa), ya tipados. Lógica pura: sin Flutter ni red, para
/// poder probarla sin pantalla.

double? _aDouble(dynamic v) => v is num ? v.toDouble() : null;
DateTime? _aFecha(dynamic v) => v is String ? DateTime.tryParse(v)?.toLocal() : null;

Coordenada? _coordenada(dynamic lat, dynamic lng) {
  final a = _aDouble(lat);
  final b = _aDouble(lng);
  return (a == null || b == null) ? null : Coordenada(a, b);
}

/// La OT abierta de un equipo (cualquier estado menos finalizada). Solo para decirlo en su ficha.
class OrdenAbiertaMapa {
  final int id;
  final String estado;
  final String? mecanicoNombre;
  const OrdenAbiertaMapa({required this.id, required this.estado, this.mecanicoNombre});

  factory OrdenAbiertaMapa.fromJson(Map<String, dynamic> j) => OrdenAbiertaMapa(
    id: (j['id'] as num).toInt(),
    estado: (j['estado'] ?? '').toString(),
    mecanicoNombre: j['mecanico_nombre']?.toString(),
  );

  String get estadoLegible => switch (estado) {
    'pendiente' => 'Pendiente',
    'asignada' => 'Asignada',
    'aceptada' => 'Aceptada',
    'en_camino' => 'En camino',
    'en_terreno' => 'En terreno',
    'en_reparacion' => 'En reparación',
    _ => estado,
  };

  /// "OT-2049 · Asignada · Pedro" (sin técnico: "OT-2049 · Pendiente").
  String get resumen => [
    'OT-$id',
    estadoLegible,
    if (mecanicoNombre != null && mecanicoNombre!.isNotEmpty) mecanicoNombre!,
  ].join(' · ');
}

/// Equipo de la flota: arrendado a un cliente o en bodega.
class EquipoMapa {
  final int id;
  final String codigo;
  final String tipo;
  final String? marca;
  final String? modelo;
  final String estado;
  final bool arrendado;
  final String? clienteNombre;
  final String? direccion;
  final Coordenada? ubicacion;

  /// 'guia', 'cliente' o 'bodega': de dónde sale el punto.
  final String? origenUbicacion;
  final bool alertaMantencion;
  final OrdenAbiertaMapa? ordenAbierta;

  const EquipoMapa({
    required this.id,
    required this.codigo,
    required this.tipo,
    this.marca,
    this.modelo,
    required this.estado,
    required this.arrendado,
    this.clienteNombre,
    this.direccion,
    this.ubicacion,
    this.origenUbicacion,
    this.alertaMantencion = false,
    this.ordenAbierta,
  });

  factory EquipoMapa.fromJson(Map<String, dynamic> j) {
    final cliente = j['cliente'];
    return EquipoMapa(
      id: (j['id'] as num).toInt(),
      codigo: (j['codigo'] ?? '').toString(),
      tipo: (j['tipo'] ?? '').toString(),
      marca: j['marca']?.toString(),
      modelo: j['modelo']?.toString(),
      estado: (j['estado'] ?? '').toString(),
      arrendado: j['situacion'] == 'arrendado',
      clienteNombre: cliente is Map ? cliente['nombre']?.toString() : null,
      direccion: j['direccion']?.toString(),
      ubicacion: _coordenada(j['latitud'], j['longitud']),
      origenUbicacion: j['origen_ubicacion']?.toString(),
      alertaMantencion: j['alerta_mantencion'] == true,
      ordenAbierta: j['orden_abierta'] is Map
          ? OrdenAbiertaMapa.fromJson(Map<String, dynamic>.from(j['orden_abierta'] as Map))
          : null,
    );
  }

  String get descripcion => [tipo, marca, modelo].where((s) => s != null && s.isNotEmpty).join(' · ');
}

/// Un furgón con un técnico en camino. Sin posición todavía: [ubicacion] es null y va a la lista.
class FurgonMapa {
  final int ordenTrabajoId;
  final String? mecanicoNombre;
  final String? patente;
  final String? vehiculo;
  final String? clienteNombre;

  /// Id del equipo al que va (para abrir su perfil). Null con un servidor anterior al que lo envía.
  final int? maquinariaId;
  final String maquinariaCodigo;
  final Coordenada? ubicacion;
  final DateTime? posicionAt;

  /// Desde cuándo el furgón no se mueve de ese punto (solo una hora, no un historial).
  final DateTime? quietoDesde;
  final DateTime? etaLlegadaAt;
  final bool etaAproximada;

  const FurgonMapa({
    required this.ordenTrabajoId,
    this.mecanicoNombre,
    this.patente,
    this.vehiculo,
    this.clienteNombre,
    this.maquinariaId,
    required this.maquinariaCodigo,
    this.ubicacion,
    this.posicionAt,
    this.quietoDesde,
    this.etaLlegadaAt,
    this.etaAproximada = false,
  });

  factory FurgonMapa.fromJson(Map<String, dynamic> j) {
    final v = j['vehiculo'];
    return FurgonMapa(
      ordenTrabajoId: (j['orden_trabajo_id'] as num).toInt(),
      mecanicoNombre: j['mecanico_nombre']?.toString(),
      patente: v is Map ? v['patente']?.toString() : null,
      vehiculo: v is Map ? [v['marca'], v['modelo']].where((s) => s != null && s.toString().isNotEmpty).join(' ') : null,
      clienteNombre: j['cliente_nombre']?.toString(),
      maquinariaId: j['maquinaria_id'] is num ? (j['maquinaria_id'] as num).toInt() : null,
      maquinariaCodigo: (j['maquinaria_codigo'] ?? '').toString(),
      ubicacion: _coordenada(j['latitud'], j['longitud']),
      posicionAt: _aFecha(j['posicion_at']),
      quietoDesde: _aFecha(j['quieto_desde']),
      etaLlegadaAt: _aFecha(j['eta_llegada_at']),
      etaAproximada: j['eta_aproximada'] == true,
    );
  }
}

class BodegaMapa {
  final int id;
  final String nombre;
  final Coordenada? ubicacion;
  const BodegaMapa({required this.id, required this.nombre, this.ubicacion});

  factory BodegaMapa.fromJson(Map<String, dynamic> j) => BodegaMapa(
        id: (j['id'] as num).toInt(),
        nombre: (j['nombre'] ?? 'Bodega').toString(),
        ubicacion: _coordenada(j['latitud'], j['longitud']),
      );
}

class DatosMapa {
  final BodegaMapa? bodega;
  final List<EquipoMapa> equipos;
  final List<FurgonMapa> furgones;
  final DateTime? generadoAt;

  const DatosMapa({this.bodega, this.equipos = const [], this.furgones = const [], this.generadoAt});

  factory DatosMapa.fromJson(Map<String, dynamic> j) => DatosMapa(
        bodega: j['bodega'] is Map ? BodegaMapa.fromJson(Map<String, dynamic>.from(j['bodega'] as Map)) : null,
        equipos: [
          for (final e in (j['equipos'] as List? ?? const [])) EquipoMapa.fromJson(Map<String, dynamic>.from(e as Map)),
        ],
        furgones: [
          for (final f in (j['furgones'] as List? ?? const [])) FurgonMapa.fromJson(Map<String, dynamic>.from(f as Map)),
        ],
        generadoAt: _aFecha(j['generado_at']),
      );

  /// Equipos que sí se pueden dibujar.
  List<EquipoMapa> get equiposEnMapa => equipos.where((e) => e.ubicacion != null).toList();

  /// Equipos y furgones que no se pueden dibujar todavía (sin coordenadas).
  List<EquipoMapa> get equiposSinUbicacion => equipos.where((e) => e.ubicacion == null).toList();
  List<FurgonMapa> get furgonesSinPosicion => furgones.where((f) => f.ubicacion == null).toList();
}

/// Agrupa los equipos que caen en el mismo punto (la bodega, o varios equipos de una misma obra)
/// para dibujar un solo icono con un contador. Las coordenadas se comparan a 5 decimales (~1 m).
List<List<EquipoMapa>> agruparPorPunto(List<EquipoMapa> equipos) {
  final grupos = <String, List<EquipoMapa>>{};
  for (final e in equipos) {
    final u = e.ubicacion;
    if (u == null) continue;
    final clave = '${u.latitud.toStringAsFixed(5)},${u.longitud.toStringAsFixed(5)}';
    grupos.putIfAbsent(clave, () => []).add(e);
  }
  return grupos.values.toList();
}

/// Posición de un punto en píxeles del mapa del mundo (Web Mercator) a un zoom dado.
({double x, double y}) _pixelesMundo(Coordenada c, double zoom) {
  final escala = 256 * math.pow(2, zoom);
  final x = (c.longitud + 180) / 360 * escala;
  final sen = math.sin(c.latitud.clamp(-85.05, 85.05) * math.pi / 180);
  final y = (0.5 - math.log((1 + sen) / (1 - sen)) / (4 * math.pi)) * escala;
  return (x: x, y: y);
}

/// Junta los puntos que a este zoom quedarían a menos de [pixeles] unos de otros (se tocarían en
/// pantalla). Cada resultado es una lista de grupos: con uno solo se dibuja el icono de siempre, con
/// varios, un icono de "N equipos cercanos". Los grupos que [fijo] marca (el seleccionado) nunca se
/// funden: no deben desaparecer bajo otro icono. Es determinista: no depende del orden de entrada.
List<List<List<EquipoMapa>>> agruparCercanos(
  List<List<EquipoMapa>> grupos,
  double zoom, {
  double pixeles = 44,
  bool Function(List<EquipoMapa> grupo)? fijo,
}) {
  final ordenados = [...grupos]
    ..sort((a, b) {
      final ua = a.first.ubicacion!;
      final ub = b.first.ubicacion!;
      final c = ua.latitud.compareTo(ub.latitud);
      return c != 0 ? c : ua.longitud.compareTo(ub.longitud);
    });
  final cumulos = <_Cumulo>[];
  for (final g in ordenados) {
    final p = _pixelesMundo(g.first.ubicacion!, zoom);
    final esFijo = fijo != null && fijo(g);
    _Cumulo? destino;
    if (!esFijo) {
      for (final c in cumulos) {
        if (c.fijo) continue;
        final dx = c.x - p.x;
        final dy = c.y - p.y;
        if (math.sqrt(dx * dx + dy * dy) <= pixeles) {
          destino = c;
          break;
        }
      }
    }
    if (destino == null) {
      cumulos.add(_Cumulo(p.x, p.y, esFijo)..grupos.add(g));
    } else {
      destino.agregar(g, p.x, p.y);
    }
  }
  return [for (final c in cumulos) c.grupos];
}

class _Cumulo {
  double x;
  double y;
  final bool fijo;
  final List<List<EquipoMapa>> grupos = [];
  _Cumulo(this.x, this.y, this.fijo);

  void agregar(List<EquipoMapa> g, double gx, double gy) {
    final n = grupos.length;
    x = (x * n + gx) / (n + 1);
    y = (y * n + gy) / (n + 1);
    grupos.add(g);
  }
}

/// Centro de un conjunto de grupos (promedio de sus puntos).
Coordenada centroGrupos(List<List<EquipoMapa>> grupos) {
  var lat = 0.0;
  var lng = 0.0;
  for (final g in grupos) {
    lat += g.first.ubicacion!.latitud;
    lng += g.first.ubicacion!.longitud;
  }
  return Coordenada(lat / grupos.length, lng / grupos.length);
}

/// "hace 3 min" desde [desde] hasta [ahora]. Menos de un minuto: "hace un momento".
String haceCuanto(DateTime desde, DateTime ahora) {
  final d = ahora.difference(desde);
  if (d.inMinutes < 1) return 'hace un momento';
  if (d.inMinutes < 60) return 'hace ${d.inMinutes} min';
  if (d.inHours < 24) return 'hace ${d.inHours} h';
  return 'hace ${d.inDays} d';
}

/// Una posición con más de 15 minutos se muestra en gris: el técnico puede ir en Maps o Waze
/// sin que la app haya podido enviar una más nueva.
bool posicionAntigua(DateTime desde, DateTime ahora) => ahora.difference(desde) > const Duration(minutes: 15);

/// Distancia en línea recta entre dos puntos, en metros (haversine).
double distanciaMetros(Coordenada a, Coordenada b) {
  const radioTierra = 6371000.0;
  double rad(double g) => g * math.pi / 180;
  final dLat = rad(b.latitud - a.latitud);
  final dLng = rad(b.longitud - a.longitud);
  final h = math.pow(math.sin(dLat / 2), 2) +
      math.cos(rad(a.latitud)) * math.cos(rad(b.latitud)) * math.pow(math.sin(dLng / 2), 2);
  return 2 * radioTierra * math.asin(math.min(1.0, math.sqrt(h)));
}

/// "850 m" o "~3,2 km": con coma decimal y sin falsa precisión. Es en línea recta, no por calle.
String textoDistancia(double metros) {
  if (metros < 1000) return '${(metros / 10).round() * 10} m';
  final km = (metros / 100).round() / 10;
  return '~${km.toStringAsFixed(1).replaceAll('.', ',')} km';
}

/// Cuánto sin moverse para decir que el furgón está detenido (un semáforo o una parada corta no cuentan).
const detenidoDesdeMinutos = 5;

/// Cómo va un furgón en camino, según su última posición.
enum EstadoViaje {
  /// todavía no llegó ninguna posición
  sinPosicion,

  /// posición reciente y se está moviendo
  enMovimiento,

  /// posición reciente, pero lleva 5 min o más en el mismo punto
  detenido,

  /// la última posición tiene más de 15 minutos: el técnico puede ir en Maps o Waze
  sinSenal,
}

EstadoViaje estadoViaje(FurgonMapa f, DateTime ahora) {
  final pos = f.posicionAt;
  if (f.ubicacion == null || pos == null) return EstadoViaje.sinPosicion;
  if (posicionAntigua(pos, ahora)) return EstadoViaje.sinSenal;
  final quieto = f.quietoDesde;
  if (quieto != null && ahora.difference(quieto) >= const Duration(minutes: detenidoDesdeMinutos)) {
    return EstadoViaje.detenido;
  }
  return EstadoViaje.enMovimiento;
}

String _hhmm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// Texto del estado del viaje, o null si no hay nada que decir ("en movimiento" es lo normal).
/// "Detenido" y "sin posición" se dicen distinto a propósito: un furgón detenido en un taco no es
/// lo mismo que uno cuya app dejó de enviar. Nunca se afirma "sin señal": se dice desde qué hora
/// no llega una posición, que es lo único que se sabe.
String? textoEstadoViaje(FurgonMapa f, DateTime ahora) {
  switch (estadoViaje(f, ahora)) {
    case EstadoViaje.detenido:
      return 'Detenido ${haceCuanto(f.quietoDesde!, ahora)}';
    case EstadoViaje.sinSenal:
      return 'Sin posición desde las ${_hhmm(f.posicionAt!)}';
    case EstadoViaje.sinPosicion:
    case EstadoViaje.enMovimiento:
      return null;
  }
}

/// Minúsculas y sin tildes, para que "grua" encuentre "Grúa".
String normalizarBusqueda(String texto) {
  const de = 'áàäâãéèëêíìïîóòöôõúùüûñ';
  const a = 'aaaaaeeeeiiiiooooouuuun';
  final sb = StringBuffer();
  for (final r in texto.toLowerCase().trim().runes) {
    final c = String.fromCharCode(r);
    final i = de.indexOf(c);
    sb.write(i >= 0 ? a[i] : c);
  }
  return sb.toString();
}

/// Deja solo lo que coincide con lo que escribió la persona: código, tipo, marca o modelo del equipo,
/// cliente, técnico, patente. Cada palabra escrita debe aparecer en alguna parte (así "grua acsa"
/// encuentra una grúa de Acsa). La bodega se conserva siempre: sin ella no se ubican los equipos.
DatosMapa filtrarDatos(DatosMapa d, String texto) {
  final palabras = normalizarBusqueda(texto).split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (palabras.isEmpty) return d;
  bool coincide(Iterable<String?> campos) {
    final todo = normalizarBusqueda(campos.where((c) => c != null && c.isNotEmpty).join(' '));
    return palabras.every(todo.contains);
  }

  return DatosMapa(
    bodega: d.bodega,
    generadoAt: d.generadoAt,
    equipos: d.equipos.where((e) => coincide([e.codigo, e.tipo, e.marca, e.modelo, e.clienteNombre])).toList(),
    furgones: d.furgones
        .where((f) => coincide([f.mecanicoNombre, f.patente, f.vehiculo, f.clienteNombre, f.maquinariaCodigo]))
        .toList(),
  );
}
