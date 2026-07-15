import 'dart:async';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';

class ConnectivityService extends ChangeNotifier {
  bool _online = true;
  bool get online => _online;

  final _controller = StreamController<bool>.broadcast();
  Stream<bool> get onCambioConexion => _controller.stream;

  StreamSubscription? _sub;

  void iniciar() {
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
