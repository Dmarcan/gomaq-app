import 'dart:async';
import 'dart:io';

import 'package:gomaq_comun/gomaq_comun.dart' show ApiException;
import 'package:http/http.dart' as http;

/// Que hacer con una tarea de la cola cuando su envio falla. Es logica pura: la cola
/// (`SyncService._push`) solo aplica lo que esto decide.
enum AccionFallo {
  /// Sin red o sin respuesta: no gasta intentos y se corta el envio completo hasta la proxima
  /// actualizacion (no tiene sentido seguir probando con las demas tareas).
  esperarRed,

  /// 401: el token ya no sirve. Se pausa la cola entera sin gastar intentos.
  pausarSesion,

  /// Nunca se va a resolver reintentando (403, archivo borrado): pasa a error de inmediato.
  aError,

  /// El servidor o el almacenamiento de fotos fallo por su lado (5xx, 429, 408). No gasta
  /// intentos: frena solo esa OT en esta pasada y la cola sigue con las demas. Se cuenta en el
  /// payload y, pasados [topeFallosTransitorios] fallos y [plazoFallosTransitorios] desde el primero,
  /// la tarea pasa a error.
  transitorio,

  /// Rechazo de negocio (otro 4xx) o fallo desconocido: gasta un intento.
  gastarIntento,
}

class DecisionFallo {
  final AccionFallo accion;

  /// Motivo que se guarda en `ultimo_error` y ve el mecanico.
  final String mensaje;

  /// Solo para [AccionFallo.transitorio]: motivo cuando se agota el tope y la tarea pasa a error.
  final String? mensajeAlAgotar;

  const DecisionFallo(this.accion, this.mensaje, {this.mensajeAlAgotar});
}

/// Intentos de rechazo de negocio antes de pasar a error.
const maxIntentosSync = 5;

/// Fallos transitorios que se toleran antes de pasar la tarea a error. Ninguno gasta intentos; el
/// tope existe para que un servicio caido por mucho rato termine visible como error y se pueda
/// reintentar o descartar a mano. Por si solo no basta: tambien debe cumplirse
/// [plazoFallosTransitorios] (cada pasada cuenta, incluidas las de "Reintentar todo", y un mecanico
/// insistiendo llegaba a 30 en pocos minutos).
const topeFallosTransitorios = 30;

/// Tiempo minimo desde el primer fallo transitorio para pasar la tarea a error.
const plazoFallosTransitorios = Duration(hours: 6);

/// Llave del contador dentro del payload de la tarea (no hay columna nueva: la base local sigue
/// en la version 10).
const llaveFallosTransitorios = 'fallos_transitorios';

/// Llave con la hora del primer fallo transitorio (ISO 8601 en UTC) dentro del payload.
const llavePrimerFalloTransitorio = 'primer_fallo_transitorio';

/// Fallo que jamas va a resolverse reintentando (ej. el archivo local ya no existe):
/// la tarea pasa a error de inmediato con un mensaje entendible, sin quemar reintentos.
class ErrorPermanenteSync implements Exception {
  final String mensaje;
  ErrorPermanenteSync(this.mensaje);
  @override
  String toString() => mensaje;
}

/// Fallo al subir una foto o firma al almacenamiento: el PUT a la URL firmada o la solicitud de
/// esa URL cuando el servidor responde que el almacenamiento no esta disponible.
class ErrorSubidaArchivo implements Exception {
  final int statusCode;
  ErrorSubidaArchivo(this.statusCode);
  @override
  String toString() => 'Fallo la subida del archivo: $statusCode';
}

/// 5xx, 429 (demasiadas peticiones) y 408 (tiempo agotado): fallos del lado del servidor que se
/// arreglan solos esperando.
bool esCodigoTransitorio(int statusCode) => statusCode >= 500 || statusCode == 429 || statusCode == 408;

const _mensajeFotosCaido = 'El servidor de fotos no respondió. Se reintentará solo.';
const _mensajeServidorCaido = 'El servidor no respondió bien. Se reintentará solo.';
const _mensajeServidorOcupado = 'El servidor está ocupado. Se reintentará solo.';
const _mensajeFotosAgotado = 'El servidor de fotos lleva mucho rato sin responder. '
    'Toca Reintentar más tarde o avisa al administrativo.';
const _mensajeServidorAgotado = 'El servidor lleva mucho rato sin responder. '
    'Toca Reintentar más tarde o avisa al administrativo.';

/// Respuesta del servidor que llego cortada o corrupta (JSON truncado, cuerpo vacio de un proxy): un
/// [FormatException] al leer lo que devolvio una llamada HTTP. Es un fallo de la conexion, no de la tarea.
///
/// Criterio para no confundirlo con un error de programacion: un `FormatException` suelto NO se
/// clasifica como de red, porque tambien lo lanzan `int.parse` o `DateTime.parse` sobre datos propios del
/// telefono (esos reintentando no se arreglan). Solo es de red el que se origina DENTRO de una llamada al
/// servidor: `SyncService` envuelve su cliente HTTP y convierte ahi el `FormatException` en este tipo. Un
/// payload local ilegible tampoco llega aqui: `_ejecutarTarea` lo convierte en [ErrorPermanenteSync].
class RespuestaIncompleta implements Exception {
  final FormatException causa;
  RespuestaIncompleta(this.causa);
  @override
  String toString() => 'Respuesta incompleta del servidor: ${causa.message}';
}

/// Clasifica el error con que fallo una tarea de la cola.
DecisionFallo clasificarFalloSync(Object error) {
  // sin red: los tres tipos que ClienteApi deja pasar sin envolver
  if (error is SocketException) {
    return const DecisionFallo(
        AccionFallo.esperarRed, 'Sin conexión con el servidor. Se reintentará al volver la señal.');
  }
  if (error is TimeoutException) {
    return const DecisionFallo(
        AccionFallo.esperarRed, 'El servidor no respondió a tiempo. Se reintentará en la próxima actualización.');
  }
  if (error is http.ClientException) {
    return const DecisionFallo(
        AccionFallo.esperarRed, 'No se pudo conectar con el servidor. Se reintentará en la próxima actualización.');
  }
  // Fallo TLS (apreton de manos cortado, certificado no verificable tras un portal cautivo o proxy): es
  // de la conexion, no de la tarea. HandshakeException y CertificateException son TlsException.
  if (error is TlsException) {
    return const DecisionFallo(
        AccionFallo.esperarRed, 'No se pudo establecer una conexión segura. Se reintentará al volver la señal.');
  }
  if (error is RespuestaIncompleta) {
    return const DecisionFallo(AccionFallo.esperarRed,
        'La respuesta del servidor llegó incompleta. Se reintentará en la próxima actualización.');
  }
  if (error is ErrorPermanenteSync) {
    return DecisionFallo(AccionFallo.aError, error.mensaje);
  }
  if (error is ErrorSubidaArchivo) {
    if (esCodigoTransitorio(error.statusCode)) {
      return const DecisionFallo(AccionFallo.transitorio, _mensajeFotosCaido, mensajeAlAgotar: _mensajeFotosAgotado);
    }
    // por ejemplo la URL firmada vencio: se pide otra en el proximo intento
    return const DecisionFallo(AccionFallo.gastarIntento,
        'El servidor de fotos rechazó el archivo. Se reintentará; si sigue fallando, avisa al administrativo.');
  }
  if (error is ApiException) {
    final codigo = error.statusCode;
    if (codigo == 401) {
      return const DecisionFallo(AccionFallo.pausarSesion, 'Tu sesión expiró.');
    }
    if (codigo == 403) {
      // Sesion valida pero sin permiso sobre ESTA tarea, tipicamente porque la OT se reasigno
      // a otro tecnico: volver a iniciar sesion no lo arregla.
      return DecisionFallo(AccionFallo.aError,
          'Sin permiso: ${error.message}. Si la orden se reasignó a otro técnico, avisa al administrativo.');
    }
    if (esCodigoTransitorio(codigo)) {
      // el cuerpo de un 5xx puede ser una pagina HTML del proxy: no se muestra tal cual
      return DecisionFallo(AccionFallo.transitorio, codigo == 429 ? _mensajeServidorOcupado : _mensajeServidorCaido,
          mensajeAlAgotar: _mensajeServidorAgotado);
    }
    return DecisionFallo(AccionFallo.gastarIntento, error.message);
  }
  return DecisionFallo(AccionFallo.gastarIntento, error.toString());
}

/// Fallos transitorios ya contados en el payload de una tarea.
int fallosTransitorios(Map<String, dynamic> payload) {
  final n = payload[llaveFallosTransitorios];
  return n is int ? n : 0;
}

/// Suma un fallo transitorio al payload (copia; el uuid y lo demas quedan intactos), anota la hora
/// del primero si falta, y dice si la tarea debe pasar a error: solo con al menos [tope] fallos Y
/// al menos [plazo] desde el primero.
///
/// [ahora] es para las pruebas; por defecto, la hora actual. La hora del primer fallo se toma como
/// [ahora] si no esta (payload de una version anterior, que ya traia el contador), si no se puede
/// leer o si esta en el futuro (el reloj del telefono se atraso): asi el plazo vuelve a correr desde
/// ahora, y la tarea nunca pasa a error de inmediato ni queda sin poder pasar nunca.
({Map<String, dynamic> payload, bool aError}) contarFalloTransitorio(
  Map<String, dynamic> payload, {
  int tope = topeFallosTransitorios,
  Duration plazo = plazoFallosTransitorios,
  DateTime? ahora,
}) {
  final momento = (ahora ?? DateTime.now()).toUtc();
  final n = fallosTransitorios(payload) + 1;
  final anotado = payload[llavePrimerFalloTransitorio];
  var primero = anotado is String ? DateTime.tryParse(anotado)?.toUtc() : null;
  if (primero == null || primero.isAfter(momento)) primero = momento;
  return (
    payload: {
      ...payload,
      llaveFallosTransitorios: n,
      llavePrimerFalloTransitorio: primero.toIso8601String(),
    },
    aError: n >= tope && momento.difference(primero) >= plazo,
  );
}

/// Si el payload trae alguna marca de fallos transitorios (contador u hora del primero).
bool tieneMarcasFallosTransitorios(Map<String, dynamic> payload) =>
    payload.containsKey(llaveFallosTransitorios) || payload.containsKey(llavePrimerFalloTransitorio);

/// Payload sin el contador ni la hora del primer fallo transitorio, para cuando el mecanico toca
/// Reintentar: el tope y el plazo vuelven a contar desde cero.
Map<String, dynamic> sinFallosTransitorios(Map<String, dynamic> payload) => Map<String, dynamic>.from(payload)
  ..remove(llaveFallosTransitorios)
  ..remove(llavePrimerFalloTransitorio);
