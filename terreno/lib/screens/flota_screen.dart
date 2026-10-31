import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/dialogo_horometro.dart';
import '../widgets/estado_chip.dart';
import 'maquinaria_historial_screen.dart';

/// Toda la flota, con buscador. Desde aqui el mecanico consulta la ficha y el historial de cualquier
/// equipo (no solo los de sus ordenes) y registra su horometro en el momento, sin tener una orden.
///
/// La lista sale de la flota local, asi que se ve sin senal. La ficha y el historial de un equipo
/// que no es suyo se descargan al abrirlo, y eso si necesita senal.
class FlotaScreen extends StatefulWidget {
  const FlotaScreen({super.key});

  @override
  State<FlotaScreen> createState() => _FlotaScreenState();
}

class _FlotaScreenState extends State<FlotaScreen> {
  List<Map<String, dynamic>> _flota = [];
  String _filtro = '';
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final db = await LocalDatabase.instance.database;
    final filas = await db.query('maquinarias_local', orderBy: 'codigo ASC');
    if (!mounted) return;
    setState(() {
      _flota = filas;
      _cargando = false;
    });
  }

  Future<void> _abrir(Map<String, dynamic> equipo) async {
    final id = equipo['id'] as int;
    // la ficha completa y el historial solo estan en el telefono para los equipos de sus ordenes
    final tieneFicha = equipo['ficha_completa'] == 1;
    if (!tieneFicha) {
      final online = context.read<ConnectivityService>().online;
      if (online) {
        final sync = context.read<SyncService>();
        showDialog(
          context: context,
          barrierDismissible: false,
          builder: (_) => const Center(child: CircularProgressIndicator()),
        );
        try {
          await sync.descargarEquipo(id);
        } catch (_) {
          // sin respuesta: se abre con lo que haya y la pantalla del equipo lo dice
        } finally {
          if (mounted) Navigator.of(context, rootNavigator: true).pop();
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Sin señal: se muestra lo que hay guardado de este equipo')),
        );
      }
    }
    if (!mounted) return;
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => MaquinariaHistorialScreen(maquinariaId: id, codigo: '${equipo['codigo']}'),
      ),
    );
    _cargar();
  }

  Future<void> _registrarHorometro(Map<String, dynamic> equipo) async {
    final id = equipo['id'] as int;
    final valor = await pedirLecturaHorometro(context, codigo: '${equipo['codigo']}', maquinariaId: id);
    if (valor == null || !mounted) return;
    final sync = context.read<SyncService>();
    // orden 0 = lectura sin orden de trabajo: la cola la envia igual que las demas
    await sync.encolarHorometro(0, maquinariaId: id, valor: valor);
    sync.sincronizar().catchError((_) {});
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Lectura de ${formatoHoras(valor)} h guardada para ${equipo['codigo']}')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtro = _filtro.trim().toLowerCase();
    final visibles = filtro.isEmpty
        ? _flota
        : _flota.where((m) {
            final texto = '${m['codigo'] ?? ''} ${m['tipo'] ?? ''} ${m['cliente_nombre'] ?? ''} ${m['ubicacion'] ?? ''}'.toLowerCase();
            return texto.contains(filtro);
          }).toList();

    return Scaffold(
      appBar: AppBar(title: const Text('Flota')),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: TextField(
                    decoration: InputDecoration(
                      labelText: 'Buscar equipo',
                      hintText: 'Código, tipo, cliente o ubicación',
                      prefixIcon: const Icon(Icons.search),
                      suffixText: '${visibles.length} de ${_flota.length}',
                    ),
                    onChanged: (v) => setState(() => _filtro = v),
                  ),
                ),
                Expanded(
                  child: _flota.isEmpty
                      ? const Center(
                          child: Padding(
                            padding: EdgeInsets.all(32),
                            child: Text(
                              'Sin señal para cargar la flota todavía. Se descarga al sincronizar.',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: GomaqColors.textoSecundario),
                            ),
                          ),
                        )
                      : RefreshIndicator(
                          onRefresh: () async {
                            try {
                              await context.read<SyncService>().sincronizar(completa: true);
                            } catch (_) {}
                            await _cargar();
                          },
                          child: ListView.builder(
                            itemCount: visibles.length,
                            itemBuilder: (context, i) {
                              final m = visibles[i];
                              final cliente = m['cliente_nombre'] as String?;
                              final estado = m['estado'] as String?;
                              return ListTile(
                                title: Text('${m['codigo']}'),
                                subtitle: Text(
                                  [
                                    if (m['tipo'] != null) '${m['tipo']}',
                                    if (cliente != null && cliente.isNotEmpty) cliente,
                                  ].join(' · '),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                // ancho fijo: con el del chip de cada estado, los codigos quedaban desalineados
                                leading: estado == null
                                    ? null
                                    : SizedBox(
                                        width: 128,
                                        child: FittedBox(
                                          fit: BoxFit.scaleDown,
                                          alignment: Alignment.centerLeft,
                                          child: EstadoChip(estado: estado),
                                        ),
                                      ),
                                trailing: IconButton(
                                  tooltip: 'Registrar horómetro',
                                  icon: const Icon(Icons.speed),
                                  onPressed: () => _registrarHorometro(m),
                                ),
                                onTap: () => _abrir(m),
                              );
                            },
                          ),
                        ),
                ),
              ],
            ),
    );
  }
}
