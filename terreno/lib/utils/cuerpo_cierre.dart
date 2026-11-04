/// Estados en que el mecanico deja el equipo al cerrar la OT (los acepta el backend).
const estadoEquipoOperativo = 'operativa';
const estadoEquipoFueraDeServicio = 'fuera_de_servicio';

/// Cuerpo de `PATCH /ordenes-trabajo/:id/finalizar` a partir de la tarea de la cola.
///
/// - `uuid_cliente`: el uuid de la tarea, para que un reintento no duplique el evento de cierre.
/// - `estado_equipo`: solo si la tarea lo trae. Las tareas encoladas por la version anterior de la
///   app no lo tienen, y el servidor decide solo (nunca deja un equipo fuera de servicio sin que
///   nadie lo pida).
/// - `ocurrio_en`: la hora real del cierre. Las tareas antiguas no la guardaron: se usa el momento
///   en que se encolaron (`creado_en`, hora local del telefono), que es cuando el mecanico cerro.
Map<String, dynamic> cuerpoFinalizar(
  Map<String, dynamic> payload, {
  required String? creadoEn,
  String? firmaPath,
}) {
  final ocurrioEn = payload['ocurrio_en'] as String? ?? _aUtcIso(creadoEn);
  return {
    if (payload['uuid'] != null) 'uuid_cliente': payload['uuid'],
    if (payload['persona_recibe'] != null) 'persona_recibe': payload['persona_recibe'],
    if (payload['sin_persona'] != null) 'sin_persona': payload['sin_persona'],
    if (firmaPath != null) 'firma_path': firmaPath,
    if (payload['estado_equipo'] != null) 'estado_equipo': payload['estado_equipo'],
    if (ocurrioEn != null) 'ocurrio_en': ocurrioEn,
  };
}

/// Cuerpo de `PATCH /ordenes-trabajo/:id/diagnostico`: el uuid de la tarea viaja tambien como
/// `uuid_cliente`, que es el nombre que el servidor documenta (acepta los dos).
Map<String, dynamic> cuerpoDiagnostico(Map<String, dynamic> payload) => {
      ...payload,
      if (payload['uuid'] != null) 'uuid_cliente': payload['uuid'],
    };

String? _aUtcIso(String? local) {
  if (local == null) return null;
  final fecha = DateTime.tryParse(local);
  return fecha?.toUtc().toIso8601String();
}
