/// True si la observacion final o el folio del papel tienen algo escrito que aun no se guardo.
/// Un campo vaciado no cuenta: la tarea no puede borrar el valor y no hay nada que enviar.
bool hayDatosFinalesSinGuardar({
  required String observacionActual,
  required String observacionGuardada,
  required String folioActual,
  required String folioGuardado,
}) {
  final obs = observacionActual.trim();
  final folio = folioActual.trim();
  return (obs.isNotEmpty && obs != observacionGuardada.trim()) ||
      (folio.isNotEmpty && folio != folioGuardado.trim());
}
