import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:signature/signature.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';

/// Cierre de la OT: quien recibe el equipo + firma digital + resumen.
/// Todo queda encolado offline; la firma se sube cuando haya señal.
class CerrarOrdenScreen extends StatefulWidget {
  final OrdenTrabajo orden;
  final int fotosAntes;
  final int fotosDespues;
  final int insumos;

  const CerrarOrdenScreen({
    super.key,
    required this.orden,
    required this.fotosAntes,
    required this.fotosDespues,
    required this.insumos,
  });

  @override
  State<CerrarOrdenScreen> createState() => _CerrarOrdenScreenState();
}

class _CerrarOrdenScreenState extends State<CerrarOrdenScreen> {
  final _personaCtrl = TextEditingController();
  final _horometroCtrl = TextEditingController();
  bool _sinPersona = false;
  bool _cerrando = false;
  bool _reiniciarContador = false;

  late final SignatureController _firmaCtrl = SignatureController(
    penStrokeWidth: 3,
    penColor: Colors.black87,
    exportBackgroundColor: Colors.white,
  );

  @override
  void dispose() {
    _personaCtrl.dispose();
    _horometroCtrl.dispose();
    _firmaCtrl.dispose();
    super.dispose();
  }

  bool get _puedeCerrar => _sinPersona || _personaCtrl.text.trim().isNotEmpty;

  Future<void> _cerrarOrden() async {
    if (_cerrando) return;
    setState(() => _cerrando = true);
    try {
      final syncService = context.read<SyncService>();

      String? rutaFirma;
      if (!_sinPersona && _firmaCtrl.isNotEmpty) {
        final png = await _firmaCtrl.toPngBytes();
        if (png != null) {
          final dir = await getApplicationDocumentsDirectory();
          rutaFirma = '${dir.path}/ot${widget.orden.id}_firma_${DateTime.now().millisecondsSinceEpoch}.png';
          await File(rutaFirma).writeAsBytes(png);
        }
      }

      // el tiempo de trabajo parte solo al iniciar: si sigue abierto, se cierra al finalizar
      final db = await LocalDatabase.instance.database;
      final abiertos = await db.query('tramos_locales',
          where: 'orden_trabajo_id = ? AND termino IS NULL', whereArgs: [widget.orden.id], orderBy: 'inicio ASC');
      for (final tramo in abiertos) {
        final inicio = DateTime.parse(tramo['inicio'] as String);
        await db.delete('tramos_locales', where: 'id = ?', whereArgs: [tramo['id']]);
        await syncService.encolarTramo(widget.orden.id, inicio: inicio, termino: DateTime.now());
      }

      await syncService.encolarFinalizar(
        widget.orden.id,
        personaRecibe: _sinPersona ? null : _personaCtrl.text.trim(),
        sinPersona: _sinPersona,
        rutaFirmaLocal: rutaFirma,
      );

      // la lectura va como tarea aparte y despues del cierre: si el horometro falla en el
      // servidor (equipo sin permiso, valor rechazado) no debe arrastrar al cierre de la OT
      final horometro = double.tryParse(_horometroCtrl.text.trim().replaceAll(',', '.'));
      if (horometro != null && horometro >= 0) {
        await syncService.encolarHorometro(
          widget.orden.id,
          maquinariaId: widget.orden.maquinariaId,
          valor: horometro,
          reiniciarContador: _reiniciarContador,
        );
      }

      // disparar la sincronizacion sin esperar: el cierre no queda bloqueado por la red
      syncService.sincronizar().catchError((_) {});

      if (!mounted) return;
      // volver hasta la lista (cierra tambien el detalle)
      Navigator.of(context).popUntil((route) => route.isFirst);
    } finally {
      if (mounted) setState(() => _cerrando = false);
    }
  }

  Widget _filaResumen(IconData icono, String etiqueta, String valor) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(icono, size: 16, color: GomaqColors.textoSecundario),
          const SizedBox(width: 8),
          Expanded(child: Text(etiqueta, style: const TextStyle(fontSize: 13))),
          Text(valor, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Cerrar orden')),
      bottomNavigationBar: SafeArea(
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          decoration: const BoxDecoration(
            color: GomaqColors.fondoOscuro,
            border: Border(top: BorderSide(color: GomaqColors.bordeSutil)),
          ),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _puedeCerrar && !_cerrando ? _cerrarOrden : null,
              icon: const Icon(Icons.lock_outline),
              label: Text(_cerrando ? 'CERRANDO...' : 'CERRAR ORDEN DE TRABAJO'),
            ),
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: const Icon(Icons.assignment_turned_in_outlined, color: GomaqColors.primario),
              title: Text('OT-${widget.orden.id} · ${widget.orden.maquinariaCodigo ?? ""}'),
              subtitle: Text(
                widget.orden.motivo ?? '',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 12),
              ),
            ),
          ),
          const SizedBox(height: 8),
          const Text('HORÓMETRO DEL EQUIPO',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
          const SizedBox(height: 4),
          const Text('Opcional. Sirve para calcular cuándo toca la mantención preventiva.',
              style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
          const SizedBox(height: 8),
          TextField(
            controller: _horometroCtrl,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(hintText: 'Horas, por ejemplo 1156'),
            onChanged: (_) => setState(() {}),
          ),
          // el reinicio se pregunta, no se deduce: solo el mecanico sabe si ademas de
          // atender la falla dejo hecha la mantencion preventiva
          if (_horometroCtrl.text.trim().isNotEmpty)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text('Se hizo la mantención preventiva', style: TextStyle(fontSize: 14)),
              subtitle: const Text('Reinicia el contador desde esta lectura',
                  style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
              value: _reiniciarContador,
              activeColor: GomaqColors.primario,
              onChanged: (v) => setState(() => _reiniciarContador = v ?? false),
            ),
          const SizedBox(height: 8),
          const Text('PERSONA QUE RECIBE EL EQUIPO',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
          const SizedBox(height: 8),
          TextField(
            controller: _personaCtrl,
            enabled: !_sinPersona,
            decoration: const InputDecoration(hintText: 'Nombre completo'),
            onChanged: (_) => setState(() {}),
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            title: const Text('No hay persona disponible para recibir', style: TextStyle(fontSize: 14)),
            value: _sinPersona,
            activeColor: GomaqColors.primario,
            onChanged: (v) => setState(() => _sinPersona = v ?? false),
          ),
          if (!_sinPersona) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Expanded(
                  child: Text('FIRMA DE QUIEN RECIBE',
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
                ),
                TextButton(
                  onPressed: () => _firmaCtrl.clear(),
                  child: const Text('Limpiar', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: Container(
                decoration: BoxDecoration(
                  border: Border.all(color: GomaqColors.bordeSutil),
                  borderRadius: BorderRadius.circular(12),
                ),
                // fondo claro: la firma se exporta como PNG con fondo blanco
                child: Signature(
                  controller: _firmaCtrl,
                  height: 190,
                  backgroundColor: const Color(0xFFF2F2F2),
                ),
              ),
            ),
            const SizedBox(height: 4),
            const Text(
              'La firma es opcional, pero respalda la entrega ante el cliente',
              style: TextStyle(fontSize: 11, color: GomaqColors.textoSecundario),
            ),
          ],
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('RESUMEN DEL TRABAJO',
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
                  const SizedBox(height: 8),
                  _filaResumen(Icons.photo_camera_outlined, 'Fotos antes', '${widget.fotosAntes}'),
                  _filaResumen(Icons.photo_camera, 'Fotos después', '${widget.fotosDespues}'),
                  _filaResumen(Icons.inventory_2_outlined, 'Repuestos registrados', '${widget.insumos}'),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
