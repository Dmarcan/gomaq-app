import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Fija el tamano de la ventana de la prueba (con pixel ratio 1) y lo restaura al terminar.
void fijarTamano(WidgetTester t, Size s) {
  t.view.physicalSize = s;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
}
