/// Guarda contra el doble toque: mientras una accion esta en curso, otra llamada se ignora.
/// Sirve para botones que encolan una tarea (cada toque repetido seria una linea duplicada).
class AccionUnica {
  bool _enCurso = false;

  /// Avisa cuando cambia [enCurso], para que la pantalla deshabilite el boton con `setState`.
  final void Function()? alCambiar;

  AccionUnica({this.alCambiar});

  bool get enCurso => _enCurso;

  /// Ejecuta [accion] salvo que ya haya otra en curso. Devuelve true si la ejecuto.
  Future<bool> ejecutar(Future<void> Function() accion) async {
    if (_enCurso) return false;
    _enCurso = true;
    alCambiar?.call();
    try {
      await accion();
      return true;
    } finally {
      _enCurso = false;
      alCambiar?.call();
    }
  }
}
