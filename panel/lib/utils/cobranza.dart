import 'numeros.dart';

/// Lógica pura de la cobranza (sin widgets): textos del estado de una factura emitida, fechas
/// en dd-mm-aaaa y la suma de las partes del traslado. El estado y los días los entrega el backend
/// (utils/cobranza.js); acá solo se escriben.

/// Filtros de la lista de facturas emitidas: (id que entiende el backend, texto del chip).
const filtrosCobranza = <({String id, String etiqueta})>[
  (id: 'todas', etiqueta: 'Todas'),
  (id: 'por_cobrar', etiqueta: 'Por cobrar'),
  (id: 'vencidas', etiqueta: 'Vencidas'),
  (id: 'proximas', etiqueta: 'Próximas a vencer'),
  (id: 'pagadas', etiqueta: 'Pagadas'),
  (id: 'anuladas', etiqueta: 'Anuladas'),
];

/// El filtro que viaja en la URL (`?filtro=vencidas`): solo los que la pestaña Emitidas conoce.
/// Cualquier otro valor (por ejemplo `aviso`, de Arriendos en curso) deja la lista completa.
String filtroCobranzaDesdeUrl(String? filtro) =>
    filtro != null && filtrosCobranza.any((f) => f.id == filtro) ? filtro : 'todas';

/// '2026-08-28' -> '28-08-2026'. Vacío si no hay una fecha AAAA-MM-DD (admite una hora detrás).
String fechaGuiones(String? dia, {String siVacio = '-'}) {
  if (dia == null || dia.length < 10) return siVacio;
  final d = dia.substring(0, 10);
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(d)) return siVacio;
  return '${d.substring(8, 10)}-${d.substring(5, 7)}-${d.substring(0, 4)}';
}

/// DateTime -> 'AAAA-MM-DD' (lo que espera el backend).
String diaIso(DateTime f) =>
    '${f.year.toString().padLeft(4, '0')}-${f.month.toString().padLeft(2, '0')}-${f.day.toString().padLeft(2, '0')}';

DateTime? diaDesdeIso(String? dia) {
  if (dia == null || dia.length < 10) return null;
  final p = dia.substring(0, 10).split('-');
  if (p.length != 3) return null;
  final a = int.tryParse(p[0]), m = int.tryParse(p[1]), d = int.tryParse(p[2]);
  if (a == null || m == null || d == null) return null;
  return DateTime(a, m, d);
}

String _dias(int n) => n == 1 ? '1 día' : '$n días';

/// Texto del estado de una factura emitida (fila de GET /api/facturacion/emitidas). El estado nunca
/// va solo en color: este texto acompaña al icono.
String textoEstadoCobranza(Map<String, dynamic> f) {
  switch (f['estado_cobranza']) {
    case 'anulada':
      return 'Anulada NC/${f['anulada_nc'] ?? ''}'.trim();
    case 'pagada':
      final mora = aEntero(f['dias_mora']);
      final pago = fechaGuiones(f['fecha_pago'] as String?);
      return mora > 0 ? 'Pagada el $pago, con ${_dias(mora)} de atraso' : 'Pagada el $pago';
    case 'vencida':
      return 'Vencida hace ${_dias(aEntero(f['dias_mora']))}';
    case 'proxima':
      final n = aEntero(f['dias_para_vencer']);
      return n == 0 ? 'Vence hoy' : (n == 1 ? 'Vence mañana' : 'Vence en $n días');
    case 'al_dia':
      return 'Al día';
    default:
      return 'Sin vencimiento';
  }
}

/// Suma de las dos partes del traslado escritas en sus campos. Null si las dos están vacías (no hay
/// división) o alguna no es un monto entero válido.
int? sumaTraslado(String entrega, String retiro) {
  if (entrega.trim().isEmpty && retiro.trim().isEmpty) return null;
  final e = entrega.trim().isEmpty ? 0.0 : parsearMonto(entrega);
  final r = retiro.trim().isEmpty ? 0.0 : parsearMonto(retiro);
  if (e == null || r == null) return null;
  if (e != e.truncateToDouble() || r != r.truncateToDouble() || e < 0 || r < 0) return null;
  return (e + r).toInt();
}

/// Las dos opciones de vencimiento cuando la fecha de la factura no coincide con el plazo habitual del
/// cliente. `vencimiento` es el objeto `vencimiento` de POST /api/facturacion/detectar. Null si no hay
/// conflicto (coincide, no hay plazo o no hay fecha en el PDF).
List<({String dia, String texto})>? opcionesVencimiento(Map<String, dynamic>? vencimiento) {
  if (vencimiento == null || vencimiento['coincide'] != false) return null;
  final pdf = vencimiento['propuesta'] as String?;
  final plazo = vencimiento['alternativa'] as String?;
  if (pdf == null || plazo == null) return null;
  final diasPdf = vencimiento['dias_pdf'];
  final diasPlazo = aEntero(vencimiento['plazo_cliente_dias']);
  return [
    (dia: pdf, texto: 'Fecha de la factura: ${fechaGuiones(pdf)}${diasPdf != null ? ' (${_dias(aEntero(diasPdf))})' : ''}'),
    (dia: plazo, texto: 'Plazo habitual del cliente: ${_dias(diasPlazo)}, ${fechaGuiones(plazo)}'),
  ];
}
