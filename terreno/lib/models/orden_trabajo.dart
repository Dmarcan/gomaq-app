/// Nombre de una OT para mostrar. Las creadas en terreno sin senal tienen un id local negativo
/// hasta sincronizar: mostrarlo ("OT--1793400428992") no le dice nada al mecanico.
String etiquetaOt(int id) => id < 0 ? 'OT nueva' : 'OT-$id';

class OrdenTrabajo {
  final int id;
  final int maquinariaId;
  final String? maquinariaCodigo;
  final String? clienteNombre;
  final String? motivo;
  final String? diagnostico;
  final String estado;
  final bool facturable;
  final String? fechaCreacion;
  final String? tipoServicio;
  final String? observacionFinal;
  final String? folioPapel;
  // ubicacion del cliente donde hay que llegar; null si no la marco (la app no muestra "Como llegar")
  final double? destinoLat;
  final double? destinoLng;

  /// El servidor manda NUMERIC como texto ("-38.735900"): se acepta numero, texto o nulo.
  static double? aDoubleONulo(dynamic valor) {
    if (valor == null) return null;
    if (valor is num) return valor.toDouble();
    return double.tryParse(valor.toString());
  }

  OrdenTrabajo({
    required this.id,
    required this.maquinariaId,
    this.maquinariaCodigo,
    this.clienteNombre,
    this.motivo,
    this.diagnostico,
    required this.estado,
    required this.facturable,
    this.fechaCreacion,
    this.tipoServicio,
    this.observacionFinal,
    this.folioPapel,
    this.destinoLat,
    this.destinoLng,
  });

  factory OrdenTrabajo.fromApiJson(Map<String, dynamic> json) {
    return OrdenTrabajo(
      id: json['id'],
      maquinariaId: json['maquinaria_id'],
      maquinariaCodigo: json['maquinaria_codigo'],
      clienteNombre: json['cliente_nombre'],
      motivo: json['motivo'],
      diagnostico: json['diagnostico'],
      estado: json['estado'],
      facturable: json['facturable'] == true,
      fechaCreacion: json['fecha_creacion'],
      tipoServicio: json['tipo_servicio'],
      observacionFinal: json['observacion_final'],
      folioPapel: json['folio_papel'],
      destinoLat: aDoubleONulo(json['destino_lat']),
      destinoLng: aDoubleONulo(json['destino_lng']),
    );
  }

  factory OrdenTrabajo.fromLocalMap(Map<String, dynamic> map) {
    return OrdenTrabajo(
      id: map['id'],
      maquinariaId: map['maquinaria_id'],
      maquinariaCodigo: map['maquinaria_codigo'],
      clienteNombre: map['cliente_nombre'],
      motivo: map['motivo'],
      diagnostico: map['diagnostico'],
      estado: map['estado'],
      facturable: map['facturable'] == 1,
      fechaCreacion: map['fecha_creacion'],
      tipoServicio: map['tipo_servicio'],
      observacionFinal: map['observacion_final'],
      folioPapel: map['folio_papel'],
      destinoLat: aDoubleONulo(map['destino_lat']),
      destinoLng: aDoubleONulo(map['destino_lng']),
    );
  }

  Map<String, dynamic> toLocalMap() {
    return {
      'id': id,
      'maquinaria_id': maquinariaId,
      'maquinaria_codigo': maquinariaCodigo,
      'cliente_nombre': clienteNombre,
      'motivo': motivo,
      'diagnostico': diagnostico,
      'estado': estado,
      'facturable': facturable ? 1 : 0,
      'fecha_creacion': fechaCreacion,
      'tipo_servicio': tipoServicio,
      'observacion_final': observacionFinal,
      'folio_papel': folioPapel,
      'destino_lat': destinoLat,
      'destino_lng': destinoLng,
      'actualizado_en': DateTime.now().toIso8601String(),
    };
  }
}
