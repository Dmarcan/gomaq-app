import 'package:flutter/material.dart';
import '../db/local_database.dart';
import '../theme/gomaq_theme.dart';
import '../utils/hoja_inferior.dart';

/// Elige un equipo de la flota con buscador por codigo, tipo o cliente. La flota ronda los 500
/// equipos: un desplegable simple obligaba a recorrerlos todos con el dedo.
///
/// Lee la flota local (`maquinarias_local`), asi que funciona sin senal. Devuelve la fila del
/// equipo elegido, o null si se cancela o la flota aun no se ha descargado.
Future<Map<String, dynamic>?> elegirEquipo(BuildContext context, {int? excluirId}) async {
  final db = await LocalDatabase.instance.database;
  final flota = (await db.query('maquinarias_local', orderBy: 'codigo ASC'))
      .where((m) => m['id'] != excluirId)
      .toList();
  if (!context.mounted) return null;
  if (flota.isEmpty) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Sin señal para cargar la lista de equipos todavía')),
    );
    return null;
  }
  final paddingSuperior = MediaQuery.paddingOf(context).top;
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (sheetContext) => _HojaSelectorEquipo(flota: flota, paddingSuperior: paddingSuperior),
  );
}

class _HojaSelectorEquipo extends StatefulWidget {
  final List<Map<String, dynamic>> flota;
  // barra de estado, medida fuera de la hoja: useSafeArea la descuenta dentro y ya no se puede leer
  final double paddingSuperior;
  const _HojaSelectorEquipo({required this.flota, required this.paddingSuperior});

  @override
  State<_HojaSelectorEquipo> createState() => _HojaSelectorEquipoState();
}

class _HojaSelectorEquipoState extends State<_HojaSelectorEquipo> {
  String _filtro = '';

  @override
  Widget build(BuildContext context) {
    final filtro = _filtro.trim().toLowerCase();
    final visibles = filtro.isEmpty
        ? widget.flota
        : widget.flota.where((m) {
            final texto = '${m['codigo'] ?? ''} ${m['tipo'] ?? ''} ${m['cliente_nombre'] ?? ''}'.toLowerCase();
            return texto.contains(filtro);
          }).toList();

    return SafeArea(
      child: Padding(
        // sube la hoja cuando aparece el teclado
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SizedBox(
          // con useSafeArea la hoja ya queda bajo la barra de estado; el tope descuenta el teclado
          height: alturaHojaInferior(
            altoPantalla: MediaQuery.of(context).size.height,
            alturaTeclado: MediaQuery.of(context).viewInsets.bottom,
            paddingSuperior: widget.paddingSuperior,
          ),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: TextField(
                  autofocus: true,
                  decoration: const InputDecoration(
                    labelText: 'Buscar equipo',
                    hintText: 'Código, tipo o cliente',
                    prefixIcon: Icon(Icons.search),
                  ),
                  onChanged: (v) => setState(() => _filtro = v),
                ),
              ),
              Expanded(
                child: visibles.isEmpty
                    ? const Center(
                        child: Text('Ningún equipo coincide', style: TextStyle(color: GomaqColors.textoSecundario)),
                      )
                    : ListView.builder(
                        itemCount: visibles.length,
                        itemBuilder: (context, i) {
                          final m = visibles[i];
                          final cliente = m['cliente_nombre'] as String?;
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
                            onTap: () => Navigator.pop(context, m),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
