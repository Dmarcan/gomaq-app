import 'package:flutter/material.dart';
import '../db/local_database.dart';
import '../theme/gomaq_theme.dart';
import '../utils/formato.dart';

/// Historial tecnico del equipo, para consultarlo en terreno.
///
/// La diapositiva 12 del informe dice que el mecanico "consulta historial tecnico"; hasta
/// ahora la app solo le mostraba la OT en curso. Lee de la base local, asi que funciona sin
/// señal: sync_service baja la ficha y el historial de los equipos de sus OT asignadas.
class MaquinariaHistorialScreen extends StatefulWidget {
  final int maquinariaId;
  final String codigo;
  const MaquinariaHistorialScreen({super.key, required this.maquinariaId, required this.codigo});

  @override
  State<MaquinariaHistorialScreen> createState() => _MaquinariaHistorialScreenState();
}

class _MaquinariaHistorialScreenState extends State<MaquinariaHistorialScreen> {
  Map<String, dynamic>? _ficha;
  List<Map<String, dynamic>> _historial = [];
  List<Map<String, dynamic>> _horometro = [];
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final db = await LocalDatabase.instance.database;
    final ficha = await db.query('maquinarias_local', where: 'id = ?', whereArgs: [widget.maquinariaId]);
    final historial = await db.query('historial_ot_local',
        where: 'maquinaria_id = ?', whereArgs: [widget.maquinariaId], orderBy: 'fecha_creacion DESC');
    final horometro = await db.query('horometro_local',
        where: 'maquinaria_id = ?', whereArgs: [widget.maquinariaId], orderBy: 'fecha DESC');
    if (!mounted) return;
    setState(() {
      _ficha = ficha.isEmpty ? null : ficha.first;
      _historial = historial;
      _horometro = horometro;
      _cargando = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Equipo ${widget.codigo}')),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _cargar,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _tarjetaFicha(),
                  const SizedBox(height: 8),
                  _tarjetaHorometro(),
                  const SizedBox(height: 8),
                  _tarjetaHistorial(),
                ],
              ),
            ),
    );
  }

  Widget _tarjetaFicha() {
    final f = _ficha;
    if (f == null || f['ficha_completa'] != 1) {
      return const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text(
            'La ficha de este equipo todavía no se ha descargado. Sincroniza con señal para verla.',
            style: TextStyle(color: GomaqColors.textoSecundario),
          ),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('FICHA TÉCNICA',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 8),
            _dato('Tipo', f['tipo']),
            _dato('Estado', f['estado'] == null ? null : GomaqColors.etiquetaEstado('${f['estado']}')),
            _dato('Marca', f['marca']),
            _dato('Modelo', f['modelo']),
            _dato('Año', f['anio']),
            _dato('N° serie', f['numero_serie']),
            _dato('N° motor', f['numero_motor']),
            _dato('N° chasis', f['numero_chasis']),
            _dato('N° mástil', f['numero_mastil']),
            _dato('Capacidad de carga', f['capacidad_carga'] == null ? null : '${f['capacidad_carga']} kg'),
            _dato('Altura de trabajo', f['altura_trabajo'] == null ? null : '${f['altura_trabajo']} m'),
            _dato('Combustible', f['tipo_combustible']),
            _dato('Ubicación', f['ubicacion']),
          ],
        ),
      ),
    );
  }

  Widget _tarjetaHorometro() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('HORÓMETRO',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 8),
            if (_horometro.isEmpty)
              const Text('Sin lecturas registradas', style: TextStyle(color: GomaqColors.textoSecundario))
            else
              for (final l in _horometro.take(10))
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.timer_outlined, size: 20),
                  title: Text('${l['valor']} h'),
                  subtitle: Text('${_fecha(l['fecha'])} · ${l['origen'] ?? ''}',
                      style: const TextStyle(fontSize: 12)),
                ),
          ],
        ),
      ),
    );
  }

  Widget _tarjetaHistorial() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('ÓRDENES DE TRABAJO ANTERIORES',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 8),
            if (_historial.isEmpty)
              const Text('Sin órdenes anteriores', style: TextStyle(color: GomaqColors.textoSecundario))
            else
              for (final ot in _historial)
                ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: Text('OT-${ot['id']} · ${ot['estado']}', style: const TextStyle(fontSize: 14)),
                  subtitle: Text(
                    '${_fecha(ot['fecha_creacion'])} · ${ot['motivo'] ?? 'Sin motivo'}',
                    style: const TextStyle(fontSize: 12),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(left: 8, right: 8, bottom: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _dato('Se encontró', ot['diagnostico']),
                          _dato('Se hizo', ot['observacion_final']),
                          _dato('Cierre', _fecha(ot['fecha_cierre'])),
                        ],
                      ),
                    ),
                  ],
                ),
          ],
        ),
      ),
    );
  }

  Widget _dato(String etiqueta, dynamic valor) {
    if (valor == null || valor.toString().trim().isEmpty || valor.toString() == '-') {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: RichText(
        text: TextSpan(
          style: const TextStyle(fontSize: 13, color: GomaqColors.textoPrimario),
          children: [
            TextSpan(text: '$etiqueta: ', style: const TextStyle(fontWeight: FontWeight.w600)),
            TextSpan(text: valor.toString()),
          ],
        ),
      ),
    );
  }

  String _fecha(dynamic iso) => Formato.fecha(iso);
}
