import 'package:flutter/material.dart';
import '../services/pendientes_service.dart';
import '../theme/gomaq_theme.dart';
import '../utils/pendientes.dart';

/// El bloque "Pendientes" del dashboard: solo lo que tiene algo por hacer, en orden de urgencia. Los
/// números salen de `GET /api/dashboard/pendientes` (vía [PendientesService]) y cada tarjeta abre la
/// lista con el mismo criterio con que se contó.
class BloquePendientes extends StatelessWidget {
  final bool compacto;
  final void Function(String ruta, {Map<String, String>? filtro}) onNavegar;
  final PendientesService? servicio;

  /// 'administrativo' o 'gerente': lo que solo hace el otro rol queda marcado y al final.
  final String? rol;

  const BloquePendientes({super.key, required this.compacto, required this.onNavegar, this.servicio, this.rol});

  @override
  Widget build(BuildContext context) {
    final fuente = servicio ?? PendientesService.instance;
    return ListenableBuilder(
      listenable: fuente,
      builder: (context, _) {
        final visibles = pendientesVisibles(fuente.datos, rol: rol);
        final Widget contenido;
        if (fuente.datos == null && fuente.error != null) {
          contenido = Row(
            children: [
              Expanded(child: Text('No se pudieron cargar los pendientes. ${fuente.error}', style: const TextStyle(fontSize: 13))),
              TextButton(onPressed: () => fuente.cargar(forzar: true), child: const Text('Reintentar')),
            ],
          );
        } else if (fuente.datos == null) {
          contenido = const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator());
        } else if (visibles.isEmpty) {
          contenido = const Row(
            children: [
              Icon(Icons.check_circle_outline, color: GomaqColors.estadoPositivo),
              SizedBox(width: 8),
              Expanded(child: Text('Todo al día: no hay nada pendiente', style: TextStyle(fontSize: 14))),
            ],
          );
        } else {
          contenido = LayoutBuilder(
            builder: (context, c) {
              // dos por fila en un teléfono; en escritorio, tantas como quepan (mínimo 190 px)
              final columnas = compacto ? 2 : (c.maxWidth / 190).floor().clamp(2, 6);
              final ancho = (c.maxWidth - 12 * (columnas - 1)) / columnas;
              return Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [for (final p in visibles) _tarjeta(p, ancho)],
              );
            },
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('PENDIENTES', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 1, color: Colors.black54)),
            const SizedBox(height: 8),
            contenido,
            if (fuente.datos != null && fuente.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Row(
                  children: [
                    Expanded(child: Text('No se pudo actualizar: ${fuente.error}', style: const TextStyle(fontSize: 12, color: Colors.black54))),
                    TextButton(onPressed: () => fuente.cargar(forzar: true), child: const Text('Reintentar')),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }

  /// Un pendiente: el número grande, lo que es, y toda la tarjeta lleva a su lista.
  Widget _tarjeta(PendienteVisible p, double ancho) {
    final etiqueta = etiquetaPendiente(p);
    return SizedBox(
      width: ancho,
      child: Semantics(
        button: true,
        label: '${p.cantidad} $etiqueta',
        child: InkWell(
          onTap: () => onNavegar(p.def.ruta, filtro: p.def.filtro),
          borderRadius: BorderRadius.circular(12),
          child: Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: GomaqColors.primario.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(12),
            ),
            child: ExcludeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text('${p.cantidad}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: GomaqColors.accion)),
                      const Spacer(),
                      Icon(p.def.icono, size: 20, color: GomaqColors.accion),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black87)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
