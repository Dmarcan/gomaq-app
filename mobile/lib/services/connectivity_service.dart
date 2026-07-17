import 'dart:async';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

class ConnectivityService extends ChangeNotifier {
  bool _online = true;
  bool get online => _online;

  final _controller = StreamController<bool>.broadcast();
  Stream<bool> get onCambioConexion => _controller.stream;

  StreamSubscription? _sub;

  Future<void> iniciar() async {
    // sembrar el estado REAL al arrancar: onConnectivityChanged solo avisa cambios,
    // asi que una app abierta sin senal se creia online (el default) hasta el primer
    // cambio - la barra decia "Todo sincronizado" siendo falso
    try {
      final resultados = await Connectivity().checkConnectivity();
      final estadoInicial = !resultados.contains(ConnectivityResult.none);
      if (estadoInicial != _online) {
        _online = estadoInicial;
        notifyListeners();
      }
    } catch (_) {
      // si la consulta falla se mantiene el default y los cambios lo corregiran
    }

    _sub = Connectivity().onConnectivityChanged.listen((results) {
      final nuevoEstado = !results.contains(ConnectivityResult.none);
      if (nuevoEstado != _online) {
        _online = nuevoEstado;
        notifyListeners();
        _controller.add(_online);
      }
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _controller.close();
    super.dispose();
  }
}
