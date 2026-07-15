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
      'actualizado_en': DateTime.now().toIso8601String(),
    };
  }
}
