import 'package:flutter/material.dart';
import '../services/api_client.dart';

/// Asigna un equipo a un cliente sin tener la guia de despacho en PDF. Registra un despacho "sin
/// documento": la guia sigue siendo el evento que arrienda el equipo (de ella dependen los dias
/// de arriendo y la facturacion), solo que el PDF se adjunta despues desde Guias. Devuelve true
/// si se registro.
Future<bool> asignarEquipoACliente(BuildContext context, {required int maquinariaId, required String codigo}) async {
  List<dynamic> clientes;
  try {
    clientes = await ApiClient.instance.get('/api/clientes');
  } on ApiException catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    return false;
  }
  if (!context.mounted) return false;

  int? clienteId;
  final horometroCtrl = TextEditingController();
  final confirmado = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (context, setDialogState) => AlertDialog(
        title: Text('Asignar $codigo a un cliente'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Queda registrado como despacho sin documento: el equipo pasa a ser del cliente desde hoy y '
                'la guía de despacho en PDF se adjunta después desde Guías.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
              const SizedBox(height: 16),
              DropdownButtonFormField<int>(
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Cliente', border: OutlineInputBorder()),
                items: [
                  for (final c in clientes)
                    DropdownMenuItem(value: c['id'] as int, child: Text('${c['nombre']}', overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) => setDialogState(() => clienteId = v),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: horometroCtrl,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(
                  labelText: 'Horómetro al despachar (opcional)',
                  suffixText: 'h',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(
            onPressed: clienteId == null ? null : () => Navigator.pop(dialogContext, true),
            child: const Text('Asignar'),
          ),
        ],
      ),
    ),
  );
  final horometro = horometroCtrl.text.trim().replaceAll(',', '.');
  // no se libera aqui: el dialogo todavia se esta animando hacia afuera y su campo sigue usando el
  // controlador; liberarlo en este punto rompe en depuracion (sin oyentes, dejarlo para el GC es inocuo)
  if (confirmado != true || clienteId == null) return false;

  try {
    await ApiClient.instance.postMultipart(
      '/api/maquinarias/$maquinariaId/guias',
      fields: {
        'tipo': 'despacho',
        'sin_documento': 'true',
        'cliente_id': clienteId.toString(),
        'fecha_hora': DateTime.now().toIso8601String(),
        if (horometro.isNotEmpty) 'horometro': horometro,
      },
    );
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Equipo asignado. Falta adjuntar la guía en PDF desde Guías.')),
      );
    }
    return true;
  } on ApiException catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    return false;
  }
}

/// Retira un equipo del cliente sin tener la guia de recepcion en PDF (misma idea que
/// [asignarEquipoACliente]). Devuelve true si se registro.
Future<bool> retirarEquipoDeCliente(BuildContext context, {required int maquinariaId, required String codigo}) async {
  final confirmado = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text('Retirar $codigo del cliente'),
      content: const Text(
        'Queda registrado como recepción sin documento: el equipo vuelve a estar disponible y la guía de '
        'recepción en PDF se adjunta después desde Guías.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Retirar')),
      ],
    ),
  );
  if (confirmado != true) return false;
  try {
    await ApiClient.instance.postMultipart(
      '/api/maquinarias/$maquinariaId/guias',
      fields: {
        'tipo': 'recepcion',
        'sin_documento': 'true',
        'fecha_hora': DateTime.now().toIso8601String(),
      },
    );
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Equipo retirado. Falta adjuntar la guía en PDF desde Guías.')),
      );
    }
    return true;
  } on ApiException catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    return false;
  }
}
