/// Reglas de negocio del flujo del mecanico.
///
/// El minimo de fotos se valida SOLO en el cliente: la cola offline puede
/// encolar "finalizar" antes de que las fotos hayan sincronizado, asi que una
/// validacion en el servidor rechazaria cierres legitimos (las fotos existen
/// en el telefono pero todavia no en el servidor).
class ReglasNegocio {
  ReglasNegocio._();

  /// Fotos del estado final del trabajo requeridas para poder cerrar la OT.
  static const minFotosDespues = 1;
}
