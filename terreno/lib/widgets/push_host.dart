import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../screens/orden_detail_screen.dart';
import '../services/push_service.dart';
import '../services/sync_service.dart';
import 'dialogo_permiso_avisos.dart';

final navegadorKey = GlobalKey<NavigatorState>();
final mensajesKey = GlobalKey<ScaffoldMessengerState>();

/// Envuelve la pantalla principal (con la sesion abierta) y arranca los avisos push. Sin config de
/// Firebase no hace nada.
class PushHost extends StatefulWidget {
  final Widget child;
  const PushHost({super.key, required this.child});

  @override
  State<PushHost> createState() => _PushHostState();
}

class _PushHostState extends State<PushHost> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _iniciar());
  }

  void _iniciar() {
    if (!mounted || !PushService.instancia.config.completa) return;
    final sync = context.read<SyncService>();
    PushService.instancia.iniciar(
      explicarPermiso: () async {
        final c = navegadorKey.currentContext;
        return c != null && c.mounted ? mostrarDialogoPermisoAvisos(c) : false;
      },
      sincronizar: () => sync.sincronizar(),
      existeOrdenLocal: (id) async {
        final db = await LocalDatabase.instance.database;
        final f = await db.query('ordenes_locales', columns: ['id'], where: 'id = ?', whereArgs: [id]);
        return f.isNotEmpty;
      },
      alAbrir: (destino) {
        final nav = navegadorKey.currentState;
        if (nav == null) return;
        nav.popUntil((r) => r.isFirst);
        if (destino.ordenId != null) {
          nav.push(MaterialPageRoute(builder: (_) => OrdenDetailScreen(ordenId: destino.ordenId!)));
        }
      },
      mostrarAviso: (m) {
        final texto = [m.titulo, m.cuerpo].whereType<String>().where((s) => s.isNotEmpty).join(': ');
        if (texto.isEmpty) return;
        mensajesKey.currentState?.showSnackBar(snackBarAviso(texto));
      },
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
