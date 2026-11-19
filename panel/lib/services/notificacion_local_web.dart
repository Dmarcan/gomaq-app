import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'notificacion_local_base.dart';
import 'push_service.dart' show PermisoAvisos;

// Encapsulado web: dart:js_interop compila solo a la web, por eso se elige con un import condicional
// (notificacion_local.dart) y el resto del panel no sabe nada de esto. No usa dart:html.

@JS('Notification')
extension type _Notificacion._(JSObject _) implements JSObject {
  external _Notificacion(String titulo, _Opciones opciones);
  external static String get permission;
  external static JSPromise<JSString> requestPermission();
  external set onclick(JSFunction funcion);
  external void close();
}

extension type _Opciones._(JSObject _) implements JSObject {
  external factory _Opciones({String body, String tag, String icon});
}

class _NotificacionWeb implements NotificacionLocal {
  const _NotificacionWeb();

  static PermisoAvisos _permiso(String p) => switch (p) {
        'granted' => PermisoAvisos.concedido,
        'denied' => PermisoAvisos.denegado,
        _ => PermisoAvisos.pendiente,
      };

  @override
  bool get soportada => globalContext.has('Notification');

  @override
  PermisoAvisos get permiso {
    try {
      return _permiso(_Notificacion.permission);
    } catch (_) {
      return PermisoAvisos.denegado;
    }
  }

  @override
  Future<PermisoAvisos> pedirPermiso() async {
    try {
      return _permiso((await _Notificacion.requestPermission().toDart).toDart);
    } catch (_) {
      return permiso;
    }
  }

  @override
  bool get pestanaEnFoco {
    try {
      final doc = globalContext['document'] as JSObject;
      final visible = (doc['visibilityState'] as JSString).toDart == 'visible';
      final foco = (doc.callMethod('hasFocus'.toJS) as JSBoolean).toDart;
      return visible && foco;
    } catch (_) {
      return false; // ante la duda se avisa
    }
  }

  @override
  String get userAgent {
    try {
      return ((globalContext['navigator'] as JSObject)['userAgent'] as JSString).toDart;
    } catch (_) {
      return '';
    }
  }

  @override
  bool get esBrave {
    try {
      return (globalContext['navigator'] as JSObject).has('brave');
    } catch (_) {
      return false;
    }
  }

  @override
  void mostrar({required String titulo, required String cuerpo, required String tag, required void Function() alTocar}) {
    try {
      final n = _Notificacion(titulo, _Opciones(body: cuerpo, tag: tag, icon: '/icons/Icon-192.png'));
      n.onclick = (() {
        try {
          globalContext.callMethod('focus'.toJS);
        } catch (_) {}
        n.close();
        alTocar();
      }).toJS;
    } catch (_) {
      // el navegador no deja crear avisos locales aquí: no pasa nada, queda el aviso dentro del panel
    }
  }
}

NotificacionLocal crearNotificacionLocal() => const _NotificacionWeb();
