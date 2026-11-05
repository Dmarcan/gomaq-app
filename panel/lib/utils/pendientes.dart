import 'package:flutter/material.dart';

/// Los "pendientes" del dashboard: lo que alguien tiene que hacer hoy.
///
/// Cada uno corresponde a una clave de `GET /api/dashboard/pendientes` y lleva a la lista de la que
/// sale su número (con el filtro ya aplicado). El orden es el de urgencia: lo que ya venció o lo que
/// bloquea a un cliente primero.
class PendienteDef {
  final String clave;
  final String etiqueta;
  final IconData icono;
  final String ruta;
  final Map<String, String> filtro;

  /// Plural y singular de la etiqueta cuando el número lo pide ("1 orden sin asignar").
  final String? etiquetaSingular;

  /// Quién puede hacer lo que falta ('administrativo' o 'gerente'); null si lo pueden los dos. El otro rol
  /// lo ve igual (es lo que está pendiente en la empresa) pero marcado y más abajo.
  final String? hace;

  const PendienteDef({
    required this.clave,
    required this.etiqueta,
    required this.icono,
    required this.ruta,
    this.filtro = const {},
    this.etiquetaSingular,
    this.hace,
  });

  /// El destino como URL: `/ordenes?pestana=sin_asignar`.
  String get destino => destinoConFiltro(ruta, filtro);
}

/// `/ruta?clave=valor&otra=valor` con los valores codificados; sin filtro, solo la ruta.
String destinoConFiltro(String ruta, Map<String, String> filtro) {
  if (filtro.isEmpty) return ruta;
  final query = filtro.entries.map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}').join('&');
  return '$ruta?$query';
}

/// En orden de urgencia.
const List<PendienteDef> pendientesDefs = [
  PendienteDef(
    clave: 'mantencion_vencida',
    etiqueta: 'Mantenciones vencidas',
    etiquetaSingular: 'Mantención vencida',
    icono: Icons.error_outline,
    ruta: '/mantencion',
    filtro: {'filtro': 'vencida'},
  ),
  PendienteDef(
    clave: 'ot_sin_asignar',
    etiqueta: 'Órdenes sin asignar',
    etiquetaSingular: 'Orden sin asignar',
    icono: Icons.assignment_late_outlined,
    ruta: '/ordenes',
    filtro: {'pestana': 'sin_asignar'},
    hace: 'administrativo',
  ),
  PendienteDef(
    clave: 'asistencias_por_atender',
    etiqueta: 'Asistencias por atender',
    etiquetaSingular: 'Asistencia por atender',
    icono: Icons.support_agent,
    ruta: '/asistencias',
    filtro: {'filtro': 'pendiente'},
  ),
  PendienteDef(
    clave: 'avisos_con_problemas',
    etiqueta: 'Avisos con problemas',
    etiquetaSingular: 'Aviso con problemas',
    icono: Icons.notifications_active_outlined,
    ruta: '/notificaciones',
    filtro: {'filtro': 'problemas'},
  ),
  PendienteDef(
    clave: 'por_facturar',
    etiqueta: 'Por facturar',
    icono: Icons.receipt_long,
    ruta: '/facturacion',
    hace: 'administrativo',
  ),
  PendienteDef(
    clave: 'arriendos_con_aviso',
    etiqueta: 'Arriendos con períodos sin facturar',
    etiquetaSingular: 'Arriendo con períodos sin facturar',
    icono: Icons.event_repeat,
    ruta: '/facturacion',
    filtro: {'pestana': 'en_curso', 'filtro': 'aviso'},
    hace: 'administrativo',
  ),
  PendienteDef(
    clave: 'ot_por_valorizar',
    etiqueta: 'Reparaciones por valorizar',
    etiquetaSingular: 'Reparación por valorizar',
    icono: Icons.price_check,
    ruta: '/facturacion',
    filtro: {'pestana': 'valorizar'},
    hace: 'gerente',
  ),
  PendienteDef(
    clave: 'guias_sin_documento',
    etiqueta: 'Guías sin documento',
    etiquetaSingular: 'Guía sin documento',
    icono: Icons.description_outlined,
    ruta: '/guias',
    hace: 'administrativo',
  ),
  PendienteDef(
    clave: 'descuadres',
    etiqueta: 'Descuadres de inventario',
    etiquetaSingular: 'Descuadre de inventario',
    icono: Icons.inventory_2_outlined,
    ruta: '/insumos',
    filtro: {'pestana': 'descuadres'},
    hace: 'administrativo',
  ),
  PendienteDef(
    clave: 'cuentas_por_aprobar',
    etiqueta: 'Cuentas por aprobar',
    etiquetaSingular: 'Cuenta por aprobar',
    icono: Icons.how_to_reg_outlined,
    ruta: '/cuentas',
  ),
  PendienteDef(
    clave: 'mantencion_proxima',
    etiqueta: 'Mantenciones próximas',
    etiquetaSingular: 'Mantención próxima',
    icono: Icons.build_circle_outlined,
    ruta: '/mantencion',
    filtro: {'filtro': 'proxima'},
  ),
];

/// Un pendiente con su número, listo para mostrarse. [delOtroRol]: lo hace el otro rol (no quien mira).
typedef PendienteVisible = ({PendienteDef def, int cantidad, bool delOtroRol});

int _entero(dynamic valor) => valor is num ? valor.toInt() : (int.tryParse('$valor') ?? 0);

/// Los pendientes que tienen algo por hacer (más de 0), en orden de urgencia. Con todo en cero o sin
/// datos, la lista queda vacía y el dashboard dice "Todo al día".
///
/// Con [rol], lo que solo puede hacer el otro rol no se esconde (sigue siendo algo pendiente): queda
/// marcado y después de lo propio, conservando el orden de urgencia dentro de cada grupo.
List<PendienteVisible> pendientesVisibles(Map<String, dynamic>? datos, {String? rol}) {
  if (datos == null) return const [];
  final todos = [
    for (final def in pendientesDefs)
      if (_entero(datos[def.clave]) > 0)
        (def: def, cantidad: _entero(datos[def.clave]), delOtroRol: rol != null && def.hace != null && def.hace != rol),
  ];
  return [...todos.where((p) => !p.delOtroRol), ...todos.where((p) => p.delOtroRol)];
}

/// La etiqueta con la concordancia del número ("1 guía sin documento" / "3 guías sin documento"). Si lo
/// hace el otro rol, lo dice: "(lo hace Administrativo)".
String etiquetaPendiente(PendienteVisible p) {
  final base = p.cantidad == 1 && p.def.etiquetaSingular != null ? p.def.etiquetaSingular! : p.def.etiqueta;
  if (!p.delOtroRol) return base;
  return '$base (lo hace ${p.def.hace == 'gerente' ? 'Gerente' : 'Administrativo'})';
}

/// Qué clave de `/api/dashboard/pendientes` pone el contador de cada ítem del menú. Solo los ítems que
/// tienen una lista de cosas por hacer llevan contador.
const Map<String, String> clavePendientePorRuta = {
  '/mantencion': 'mantencion_vencida',
  '/ordenes': 'ot_sin_asignar',
  '/asistencias': 'asistencias_por_atender',
  '/notificaciones': 'avisos_con_problemas',
  '/facturacion': 'por_facturar',
  '/guias': 'guias_sin_documento',
  '/insumos': 'descuadres',
  '/cuentas': 'cuentas_por_aprobar',
};

/// El número del contador de un ítem del menú; 0 si no lleva contador o no hay datos.
int contadorMenu(String ruta, Map<String, dynamic>? datos) {
  final clave = clavePendientePorRuta[ruta];
  if (clave == null || datos == null) return 0;
  return _entero(datos[clave]);
}

/// A dónde lleva un ítem del menú. Con pendientes, a la lista de la que sale su número (con su filtro), para
/// que el número del contador y lo que se ve al entrar coincidan: Mantención abre las vencidas, Insumos los
/// descuadres. Sin pendientes (o sin contador), a la sección de siempre.
String destinoMenu(String ruta, Map<String, dynamic>? datos) {
  if (contadorMenu(ruta, datos) <= 0) return ruta;
  final clave = clavePendientePorRuta[ruta];
  for (final def in pendientesDefs) {
    if (def.clave == clave) return def.destino;
  }
  return ruta;
}
