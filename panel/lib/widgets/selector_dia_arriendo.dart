import 'package:flutter/material.dart';
import '../theme/gomaq_theme.dart';
import '../utils/efecto_guia.dart';
import '../utils/formato.dart';

/// Recuadro destacado donde se elige el día de inicio (despacho) o de término (recepción) del
/// arriendo, con la hora, y la frase que dice qué día se cobra. La frase solo se muestra si se
/// conoce la hora de corte ([horaCorte], leída del servidor) y la guía no es fallida: el servidor
/// sigue siendo quien decide.
class SelectorDiaArriendo extends StatelessWidget {
  const SelectorDiaArriendo({
    super.key,
    required this.tipo,
    required this.fecha,
    required this.hora,
    required this.horaTexto,
    required this.onElegirFecha,
    required this.onElegirHora,
    this.horaCorte,
    this.fallido = false,
    this.avisoHora,
  });

  final String tipo;
  final DateTime fecha;
  final TimeOfDay hora;
  final String horaTexto;
  final VoidCallback onElegirFecha;
  final VoidCallback onElegirHora;
  final int? horaCorte;
  final bool fallido;
  final String? avisoHora;

  bool get _esDespacho => tipo == 'despacho';

  @override
  Widget build(BuildContext context) {
    final titulo = _esDespacho ? 'DÍA DE INICIO DEL ARRIENDO (DESPACHO)' : 'DÍA DE TÉRMINO DEL ARRIENDO (RECEPCIÓN)';
    final ayuda = _esDespacho
        ? 'El sistema cuenta los días por facturar desde este día. Si el equipo sale desde la hora de corte, se cobra desde el día siguiente.'
        : 'El sistema cuenta los días por facturar hasta este día. Si el equipo vuelve antes de la hora de corte, ese día no se cobra.';
    final efecto = (horaCorte == null || fallido)
        ? null
        : efectoCobroGuia(
            tipo: tipo,
            fecha: DateTime(fecha.year, fecha.month, fecha.day, hora.hour, hora.minute),
            horaCorte: horaCorte!,
          );
    final nombreDia = _esDespacho ? 'Día de inicio' : 'Día de término';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.primary, width: 2),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(titulo, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
          ),
          const SizedBox(height: 4),
          Text(ayuda, style: const TextStyle(fontSize: 12, color: Colors.black87)),
          if (avisoHora != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(avisoHora!, style: const TextStyle(fontSize: 12, color: GomaqColors.advertenciaFuerte)),
            ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(minWidth: 150, minHeight: 48),
                child: Semantics(
                  button: true,
                  label: '$nombreDia del arriendo: ${Formato.fecha(fecha)}. Cambiar',
                  excludeSemantics: true,
                  child: OutlinedButton.icon(
                    onPressed: onElegirFecha,
                    icon: const Icon(Icons.calendar_today, size: 18),
                    label: Text(Formato.fecha(fecha), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  ),
                ),
              ),
              ConstrainedBox(
                constraints: const BoxConstraints(minWidth: 120, minHeight: 48),
                child: Semantics(
                  button: true,
                  label: 'Hora de la guía: $horaTexto. Cambiar',
                  excludeSemantics: true,
                  child: OutlinedButton.icon(
                    onPressed: onElegirHora,
                    icon: const Icon(Icons.access_time, size: 18),
                    label: Text(horaTexto, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  ),
                ),
              ),
            ],
          ),
          if (efecto != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Semantics(
                liveRegion: true,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.event_available, size: 18),
                    const SizedBox(width: 8),
                    Expanded(child: Text(efecto.texto, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold))),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
