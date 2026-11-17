// Reglas puras de la pantalla de guías y de Asignar/Retirar: qué equipos se pueden elegir, qué fecha
// se acepta y la frase que resume el efecto de guardar. No repiten la regla de la hora de corte:
// de cuándo se empieza a cobrar se encarga el servidor.

/// Cuántos días hacia atrás se acepta la fecha de una guía hecha a mano desde Asignar o Retirar.
/// Una fecha pasada cambia los días que se cobran, por eso tiene tope.
const maxDiasAtrasGuiaRapida = 30;

/// Equipos que se pueden elegir para una guía.
///
/// Despacho: equipos sin cliente y que no estén fuera de servicio. Recepción: equipos con cliente
/// (los que están arrendados). Con [verTodos] se dejan todos los equipos, sin importar el cliente;
/// la recepción siempre admite un equipo fuera de servicio (un averiado se recibe de vuelta y se
/// despacha otro en su lugar), el despacho nunca.
List<Map<String, dynamic>> equiposParaGuia(List<dynamic> equipos, {required String tipo, bool verTodos = false}) {
  final lista = <Map<String, dynamic>>[];
  for (final e in equipos) {
    final m = Map<String, dynamic>.from(e as Map);
    if (tipo == 'despacho' && m['estado'] == 'fuera_de_servicio') continue;
    if (!verTodos) {
      final tieneCliente = m['cliente_id'] != null;
      if (tipo == 'despacho' && tieneCliente) continue;
      if (tipo == 'recepcion' && !tieneCliente) continue;
    }
    lista.add(m);
  }
  return lista;
}

/// Mensaje de error si la fecha de una guía rápida no vale, o null si está bien. No puede ser futura
/// (se deja un margen de 5 minutos por el reloj) ni anterior a [maxDiasAtrasGuiaRapida] días.
String? validarFechaGuiaRapida(DateTime fecha, DateTime ahora) {
  if (fecha.isAfter(ahora.add(const Duration(minutes: 5)))) {
    return 'La fecha no puede ser futura.';
  }
  if (fecha.isBefore(ahora.subtract(const Duration(days: maxDiasAtrasGuiaRapida)))) {
    return 'La fecha no puede ser de hace más de $maxDiasAtrasGuiaRapida días.';
  }
  return null;
}

String _dos(int n) => n.toString().padLeft(2, '0');

/// "04/11 14:30", o con el año si no es el actual.
String fechaHoraCorta(DateTime f, {DateTime? ahora}) {
  final base = '${_dos(f.day)}/${_dos(f.month)}';
  final conAnio = ahora != null && f.year != ahora.year ? '/${f.year}' : '';
  return '$base$conAnio ${_dos(f.hour)}:${_dos(f.minute)}';
}

/// Lee un horómetro escrito a mano. Devuelve null si el texto está vacío o no es un número válido
/// (negativo, con letras o con varios separadores decimales).
///
/// Acepta la coma decimal ("1156,5"), el punto decimal ("1156.5") y el punto de miles chileno:
/// "1.156" son 1156 horas y "1.156,5" son 1156,5. Un punto sin tres dígitos después ("12.5") es decimal.
double? parsearHorometro(String texto) {
  var t = texto.trim();
  if (t.isEmpty) return null;
  final tieneComa = t.contains(',');
  final tienePunto = t.contains('.');
  if (tieneComa && tienePunto) {
    // el último separador es el decimal; el otro agrupa miles
    final decimal = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
    final miles = decimal == ',' ? '.' : ',';
    if (t.indexOf(decimal) != t.lastIndexOf(decimal)) return null;
    t = t.replaceAll(miles, '').replaceAll(decimal, '.');
  } else if (tieneComa) {
    if (t.indexOf(',') != t.lastIndexOf(',')) return null;
    t = t.replaceAll(',', '.');
  } else if (tienePunto) {
    // "1.156" o "12.345.678" son miles; "12.5" es decimal
    if (RegExp(r'^\d{1,3}(\.\d{3})+$').hasMatch(t)) {
      t = t.replaceAll('.', '');
    } else if (t.indexOf('.') != t.lastIndexOf('.')) {
      return null;
    }
  }
  if (!RegExp(r'^\d+(\.\d+)?$').hasMatch(t)) return null;
  final n = double.tryParse(t);
  return (n == null || !n.isFinite) ? null : n;
}

/// El horómetro tal como se envía al servidor ("1156" o "1156.5"), o null si no es válido.
String? horometroParaEnvio(String texto) {
  final n = parsearHorometro(texto);
  if (n == null) return null;
  return n == n.roundToDouble() ? n.toInt().toString() : n.toString();
}

/// Instante de la guía como el servidor lo necesita: en UTC y con la "Z" final. Un texto sin
/// desfase se interpretaría en la zona de la base, y la hora decide desde cuándo se cobra.
String fechaIsoUtc(DateTime fecha) => fecha.toUtc().toIso8601String();

/// Frase que dice qué va a pasar al guardar la guía, para leerla antes de confirmar.
///
/// [clienteNombre] es el cliente del despacho; [clienteActual] el que tiene hoy el equipo.
/// [horometro] es el texto escrito por la persona: solo se promete la lectura si es válida.
/// La fecha de la guía no es el día desde el que se cobra: eso lo calcula el sistema con la hora de corte.
String describirEfectoGuia({
  required String tipo,
  required String codigo,
  required DateTime fecha,
  String? clienteNombre,
  String? clienteActual,
  bool fallido = false,
  String horometro = '',
  DateTime? ahora,
}) {
  if (fallido) {
    return tipo == 'despacho'
        ? 'Despacho fallido: $codigo no cambia de cliente y no se cobra.'
        : 'Retiro fallido: $codigo sigue con su cliente, el arriendo sigue corriendo y las guías fallidas se ignoran.';
  }
  final cuando = fechaHoraCorta(fecha, ahora: ahora);
  final String efecto;
  if (tipo == 'despacho') {
    if (clienteNombre == null || clienteNombre.isEmpty) {
      efecto = 'Elige el cliente para ver el efecto del despacho.';
    } else if (clienteActual != null && clienteActual.isNotEmpty) {
      efecto = '$codigo deja de estar con $clienteActual y pasa a $clienteNombre, con fecha $cuando.';
    } else {
      efecto = '$codigo quedará arrendado a $clienteNombre, con fecha $cuando.';
    }
  } else {
    efecto = (clienteActual == null || clienteActual.isEmpty)
        ? 'Este equipo no está con ningún cliente: la recepción del $cuando no cierra ningún arriendo.'
        : '$codigo se libera de $clienteActual con fecha $cuando y queda sin cliente.';
  }
  final h = parsearHorometro(horometro);
  return h == null ? efecto : '$efecto Se registra una lectura de horómetro de ${horometroParaEnvio(horometro)} h.';
}

/// Resultado informativo de [efectoCobroGuia]: el día que marca el corte y la frase que lo explica.
class EfectoCobroGuia {
  const EfectoCobroGuia({required this.dia, required this.texto});

  /// Despacho: primer día que se cobra (`guias.inicio_cobro`). Recepción: último día cobrado (`guias.fin_cobro`).
  final DateTime dia;
  final String texto;
}

/// Qué día se cobra según la fecha y hora de la guía y la hora de corte (`hora_corte_despacho`).
///
/// Reproduce `gomaq_inicio_cobro` (migración 022) y `gomaq_fin_cobro` (migración 028): un despacho
/// desde la hora de corte (hora >= corte) empieza a cobrar al día siguiente; una recepción desde la
/// hora de corte cobra ese mismo día y una anterior a la hora de corte deja como último día el anterior.
/// Es solo informativa: el servidor es quien calcula y guarda el día. Devuelve null si [tipo] no es
/// despacho ni recepción.
EfectoCobroGuia? efectoCobroGuia({
  required String tipo,
  required DateTime fecha,
  required int horaCorte,
}) {
  final base = DateTime(fecha.year, fecha.month, fecha.day);
  final desdeElCorte = fecha.hour >= horaCorte;
  final corte = '${_dos(horaCorte)}:00';
  String dm(DateTime d) => '${_dos(d.day)}/${_dos(d.month)}';
  if (tipo == 'despacho') {
    if (desdeElCorte) {
      final dia = DateTime(base.year, base.month, base.day + 1);
      return EfectoCobroGuia(
        dia: dia,
        texto: 'Salió desde las $corte: se cobra desde el día siguiente (${dm(dia)}).',
      );
    }
    return EfectoCobroGuia(dia: base, texto: 'Salió antes de las $corte: se cobra desde el mismo día (${dm(base)}).');
  }
  if (tipo == 'recepcion') {
    if (desdeElCorte) {
      return EfectoCobroGuia(dia: base, texto: 'Volvió desde las $corte: el último día cobrado es ${dm(base)}.');
    }
    final dia = DateTime(base.year, base.month, base.day - 1);
    return EfectoCobroGuia(
      dia: dia,
      texto: 'Volvió antes de las $corte: el último día cobrado es el anterior (${dm(dia)}).',
    );
  }
  return null;
}
