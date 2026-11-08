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
  final String maquinariaCodigo;
  final Coordenada? ubicacion;
  final DateTime? posicionAt;
  final DateTime? etaLlegadaAt;
  final bool etaAproximada;

  const FurgonMapa({
    required this.ordenTrabajoId,
    this.mecanicoNombre,
    this.patente,
    this.vehiculo,
    this.clienteNombre,
    required this.maquinariaCodigo,
    this.ubicacion,
    this.posicionAt,
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
      maquinariaCodigo: (j['maquinaria_codigo'] ?? '').toString(),
      ubicacion: _coordenada(j['latitud'], j['longitud']),
      posicionAt: _aFecha(j['posicion_at']),
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
