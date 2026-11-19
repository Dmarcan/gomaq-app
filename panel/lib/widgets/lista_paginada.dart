import 'package:flutter/material.dart';
import '../services/api_client.dart';
import 'estado_vacio.dart';

/// Una lista del servidor que llega por páginas: la primera con `cargar` y las siguientes con
/// `cargarMas` (botón "Cargar más"). Quien la usa solo dice cómo se arma la consulta de una página
/// (`consultaPagina`) y, si la respuesta trae algo más que la lista, qué hacer con ello
/// (`alRecibirPrimeraPagina`).
///
/// Los campos son públicos dentro del `State`: la pantalla los lee para pintar y los cambia con
/// `setState` cuando mueve un filtro.
mixin ListaPaginada<T extends StatefulWidget> on State<T> {
  static const porPagina = 50;

  /// Los dos parametros de paginacion de una consulta, para la pagina que empieza en `offset`.
  static String parametrosPagina(int offset) => 'limit=$porPagina&offset=$offset';

  List<dynamic> items = [];
  int total = 0;
  bool hayMas = false;
  bool cargando = true;
  bool cargandoMas = false;
  String? errorCarga;

  /// Ruta con su query para la página que empieza en `offset`.
  String consultaPagina({required int offset});

  /// Qué se avisa si falla "Cargar más" (lo cargado hasta ahí no se pierde).
  String get textoFalloCargarMas => 'No se pudieron cargar más elementos';

  /// Para tomar de la primera respuesta lo que no es la lista (un resumen, por ejemplo).
  void alRecibirPrimeraPagina(Map<String, dynamic> data) {}

  Future<void> cargar() async {
    setState(() {
      cargando = true;
      errorCarga = null;
    });
    try {
      final data = await ApiClient.instance.get(consultaPagina(offset: 0));
      if (!mounted) return;
      setState(() {
        items = data['items'] ?? [];
        total = data['total'] ?? 0;
        hayMas = data['hay_mas'] == true;
        alRecibirPrimeraPagina(data);
      });
    } catch (e) {
      if (mounted) setState(() => errorCarga = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => cargando = false);
    }
  }

  Future<void> cargarMas() async {
    if (cargandoMas || !hayMas) return;
    setState(() => cargandoMas = true);
    try {
      final data = await ApiClient.instance.get(consultaPagina(offset: items.length));
      if (!mounted) return;
      setState(() {
        items = [...items, ...data['items']];
        total = data['total'] ?? total;
        hayMas = data['hay_mas'] == true;
      });
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$textoFalloCargarMas: ${e.message}')));
      }
    } finally {
      if (mounted) setState(() => cargandoMas = false);
    }
  }
}
