import 'dart:async';

import 'package:flutter/foundation.dart';

/// Corre las pasadas de sincronizacion de a una. Pedir una sincronizacion mientras otra esta en
/// curso deja marcada UNA pasada mas, que corre al terminar la actual: asi el cambio que el
/// mecanico acaba de guardar, o el "Actualizar" que toco, no espera hasta la siguiente vez que algo
/// dispare una sincronizacion. Varias peticiones durante la misma pasada se juntan en esa sola
/// pasada extra, y la pasada extra no se agenda a si misma: no hay bucles.
class PasadasEnSerie {
  PasadasEnSerie({required this.pasada, required this.alCambiar});

  /// La pasada propiamente tal. [completa] pide tambien los catalogos.
  final Future<void> Function(bool completa) pasada;

  /// Se llama al empezar y al terminar cada pasada (para avisar a la interfaz).
  final VoidCallback alCambiar;

  bool _enCurso = false;
  bool get enCurso => _enCurso;

  Completer<void>? _otraPasada;
  bool _otraCompleta = false;

  /// Si no hay una pasada en curso, la corre (y propaga su error). Si ya hay una, marca otra para
  /// cuando termine y devuelve un futuro que se completa al terminar esa otra pasada. Ese futuro
  /// nunca falla: quien pidio la pasada extra no espera un error, y el motivo queda anotado en la
  /// cola.
  Future<void> pedir({bool completa = false}) async {
    if (_enCurso) {
      _otraCompleta = _otraCompleta || completa;
      return (_otraPasada ??= Completer<void>()).future;
    }
    _enCurso = true;
    alCambiar();
    try {
      await pasada(completa);
    } finally {
      _enCurso = false;
      alCambiar();
      final otra = _otraPasada;
      if (otra != null) {
        _otraPasada = null;
        final completaOtra = _otraCompleta;
        _otraCompleta = false;
        unawaited(_correrOtra(otra, completaOtra));
      }
    }
  }

  Future<void> _correrOtra(Completer<void> otra, bool completa) async {
    try {
      await pedir(completa: completa);
    } catch (err) {
      debugPrint('Sincronizacion pedida durante otra: $err');
    } finally {
      otra.complete();
    }
  }
}
