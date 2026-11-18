import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';

/// Que cambio fallo, en palabras del mecanico (no el nombre interno de la tarea ni el id local).
String describirTarea(Map<String, dynamic> tarea) {
  const nombres = {
    'insumo': 'Repuesto',
    'anular_insumo': 'Anulación de repuesto',
    'evidencia': 'Foto',
    'finalizar': 'Cierre de la orden',
    'diagnostico': 'Observaciones',
    'datos_ot': 'Datos de la orden',
    'checklist': 'Sistemas intervenidos',
    'tramo': 'Tramo de trabajo',
    'horometro': 'Lectura de horómetro',
    'crear_ot': 'Orden nueva en terreno',
  };
  final id = tarea['orden_trabajo_id'] as int;
  final orden = id == 0 ? 'sin orden' : id < 0 ? 'orden creada sin señal' : 'OT-$id';
  return '${nombres[tarea['tipo']] ?? tarea['tipo']} · $orden';
}

/// Cuadro con lo que no se ha enviado, para reintentar o descartar. Lo usan la lista de ordenes y
/// el detalle de cada orden. [alCambiar] recarga lo local de la pantalla que lo abrio.
Future<void> mostrarErroresDeSync(BuildContext context, {Future<void> Function()? alCambiar}) async {
  final syncService = context.read<SyncService>();
  final tareas = await syncService.tareasConProblema();
  if (!context.mounted) return;
  await showDialog(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Cambios que no se han enviado'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final t in tareas)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  leading: const Icon(Icons.error_outline, color: GomaqColors.estadoNegativo),
                  title: Text(describirTarea(t)),
                  subtitle: Text('${t['ultimo_error'] ?? 'Sin detalle del error'}', maxLines: 3, overflow: TextOverflow.ellipsis),
                  trailing: t['estado'] == 'error'
                      ? TextButton(
                          onPressed: () async {
                            final ok = await showDialog<bool>(
                              context: dialogContext,
                              builder: (c) => AlertDialog(
                                title: const Text('Descartar este cambio'),
                                content: Text(
                                  '${describirTarea(t)}\n\nSe borra del teléfono y no se enviará al servidor. Esta acción no se puede deshacer.',
                                ),
                                actions: [
                                  TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancelar')),
                                  FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Descartar')),
                                ],
                              ),
                            );
                            if (ok != true) return;
                            await syncService.descartarTarea(t['id'] as int);
                            if (dialogContext.mounted) Navigator.pop(dialogContext);
                            await alCambiar?.call();
                            if (context.mounted) await mostrarErroresDeSync(context, alCambiar: alCambiar);
                          },
                          child: const Text('Descartar'),
                        )
                      : null,
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cerrar')),
        // una orden reasignada tiene varias tareas frenadas: descartarlas una a una tomaria una
        // sincronizacion por cada una
        if (tareas.any((t) => t['estado'] == 'error'))
          TextButton(
            onPressed: () async {
              final ok = await showDialog<bool>(
                context: dialogContext,
                builder: (c) => AlertDialog(
                  title: const Text('Descartar todo lo de las órdenes con error'),
                  content: const Text(
                    'Se borran del teléfono todos los cambios sin enviar de las órdenes que tienen un error. No se enviarán al servidor. Esta acción no se puede deshacer.',
                  ),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancelar')),
                    FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Descartar todo')),
                  ],
                ),
              );
              if (ok != true) return;
              final ordenes = {
                for (final t in tareas)
                  if (t['estado'] == 'error') t['orden_trabajo_id'] as int,
              };
              for (final id in ordenes) {
                await syncService.descartarOrden(id);
              }
              if (dialogContext.mounted) Navigator.pop(dialogContext);
              await alCambiar?.call();
            },
            child: const Text('Descartar todo'),
          ),
        FilledButton(
          onPressed: () async {
            Navigator.pop(dialogContext);
            await syncService.reintentarErrores();
            await alCambiar?.call();
          },
          child: const Text('Reintentar todo'),
        ),
      ],
    ),
  );
}
