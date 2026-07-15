import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';
import 'maquinaria_perfil_screen.dart';

const _categorias = [
  (valor: 'grua_horquilla', etiqueta: 'Grúa Horquilla'),
  (valor: 'alzahombre', etiqueta: 'Alzahombre'),
  (valor: 'transpaleta', etiqueta: 'Transpaleta'),
];

const _combustibles = [
  (valor: 'electrica', etiqueta: 'Eléctrica'),
  (valor: 'gas', etiqueta: 'Gas'),
  (valor: 'gasolina', etiqueta: 'Gasolina'),
  (valor: 'diesel', etiqueta: 'Diésel'),
];

class FlotaScreen extends StatefulWidget {
  const FlotaScreen({super.key});

  @override
  State<FlotaScreen> createState() => _FlotaScreenState();
}

class _FlotaScreenState extends State<FlotaScreen> {
  List<dynamic> _maquinarias = [];
  bool _cargando = true;
  String? _error;
  String _busqueda = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get('/api/maquinarias');
      if (!mounted) return;
      setState(() => _maquinarias = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear() async {
    final codigoCtrl = TextEditingController();
    final tipoCtrl = TextEditingController();
    final ubicacionCtrl = TextEditingController();
    final marcaCtrl = TextEditingController();
    final modeloCtrl = TextEditingController();
    final anioCtrl = TextEditingController();
    final descripcionCtrl = TextEditingController();
    final capacidadCargaCtrl = TextEditingController();
    final alturaTrabajoCtrl = TextEditingController();
    final numeroSerieCtrl = TextEditingController();
    final numeroMotorCtrl = TextEditingController();
    final numeroChasisCtrl = TextEditingController();
    final numeroMastilCtrl = TextEditingController();

    String? categoria;
    String? combustible;
    PlatformFile? foto;

    if (!mounted) return;
    final creado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          final mostrarCapacidad = categoria == 'grua_horquilla' || categoria == 'transpaleta';
          final mostrarMastil = categoria == 'grua_horquilla';
          final mostrarCombustible = categoria == 'grua_horquilla' || categoria == 'alzahombre';
          final mostrarMotorChasis = categoria == 'grua_horquilla' || categoria == 'alzahombre';
          final mostrarAltura = categoria == 'alzahombre';
          final mostrarFicha = categoria != null;

          return AlertDialog(
            title: const Text('Nueva maquinaria'),
            content: SizedBox(
              width: 420,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TextField(controller: codigoCtrl, decoration: const InputDecoration(labelText: 'Codigo (ej. GH-204)')),
                    TextField(controller: tipoCtrl, decoration: const InputDecoration(labelText: 'Tipo (ej. Grua Horquilla)')),
                    TextField(controller: ubicacionCtrl, decoration: const InputDecoration(labelText: 'Ubicacion (opcional)')),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: categoria,
                      decoration: const InputDecoration(labelText: 'Categoría (para la ficha técnica)'),
                      items: [for (final c in _categorias) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
                      onChanged: (v) => setDialogState(() => categoria = v),
                    ),
                    if (mostrarFicha) ...[
                      const SizedBox(height: 12),
                      const Text('FICHA TÉCNICA', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                      TextField(controller: marcaCtrl, decoration: const InputDecoration(labelText: 'Marca')),
                      TextField(controller: modeloCtrl, decoration: const InputDecoration(labelText: 'Modelo')),
                      TextField(controller: anioCtrl, decoration: const InputDecoration(labelText: 'Año'), keyboardType: TextInputType.number),
                      if (mostrarCapacidad)
                        TextField(
                          controller: capacidadCargaCtrl,
                          decoration: const InputDecoration(labelText: 'Capacidad de carga (kg)'),
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        ),
                      if (mostrarAltura)
                        TextField(
                          controller: alturaTrabajoCtrl,
                          decoration: const InputDecoration(labelText: 'Altura de trabajo (m)'),
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        ),
                      if (mostrarMastil)
                        TextField(controller: numeroMastilCtrl, decoration: const InputDecoration(labelText: 'N° de mástil')),
                      if (mostrarCombustible)
                        DropdownButtonFormField<String>(
                          initialValue: combustible,
                          decoration: const InputDecoration(labelText: 'Combustible'),
                          items: [for (final c in _combustibles) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
                          onChanged: (v) => setDialogState(() => combustible = v),
                        ),
                      if (mostrarMotorChasis) ...[
                        TextField(controller: numeroMotorCtrl, decoration: const InputDecoration(labelText: 'N° de motor')),
                        TextField(controller: numeroChasisCtrl, decoration: const InputDecoration(labelText: 'N° de chasis')),
                      ],
                      TextField(controller: numeroSerieCtrl, decoration: const InputDecoration(labelText: 'N° de serie')),
                      TextField(controller: descripcionCtrl, decoration: const InputDecoration(labelText: 'Descripción'), maxLines: 2),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: () async {
                          final resultado = await FilePicker.platform.pickFiles(
                            type: FileType.custom,
                            allowedExtensions: ['jpg', 'jpeg', 'png'],
                            withData: true,
                          );
                          if (resultado != null && resultado.files.single.bytes != null) {
                            setDialogState(() => foto = resultado.files.single);
                          }
                        },
                        icon: const Icon(Icons.image_outlined),
                        label: Text(foto?.name ?? 'Agregar foto (opcional)'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
              FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Crear')),
            ],
          );
        },
      ),
    );

    if (creado != true || codigoCtrl.text.trim().isEmpty || tipoCtrl.text.trim().isEmpty) return;
    try {
      await ApiClient.instance.postMultipart(
        '/api/maquinarias',
        bytes: foto?.bytes,
        filename: foto?.name,
        fields: {
          'codigo': codigoCtrl.text.trim(),
          'tipo': tipoCtrl.text.trim(),
          if (ubicacionCtrl.text.trim().isNotEmpty) 'ubicacion': ubicacionCtrl.text.trim(),
          if (categoria != null) 'categoria_equipo': categoria!,
          if (marcaCtrl.text.trim().isNotEmpty) 'marca': marcaCtrl.text.trim(),
          if (modeloCtrl.text.trim().isNotEmpty) 'modelo': modeloCtrl.text.trim(),
          if (anioCtrl.text.trim().isNotEmpty) 'anio': anioCtrl.text.trim(),
          if (descripcionCtrl.text.trim().isNotEmpty) 'descripcion': descripcionCtrl.text.trim(),
          if (capacidadCargaCtrl.text.trim().isNotEmpty) 'capacidad_carga': capacidadCargaCtrl.text.trim(),
          if (alturaTrabajoCtrl.text.trim().isNotEmpty) 'altura_trabajo': alturaTrabajoCtrl.text.trim(),
          if (numeroSerieCtrl.text.trim().isNotEmpty) 'numero_serie': numeroSerieCtrl.text.trim(),
          if (numeroMotorCtrl.text.trim().isNotEmpty) 'numero_motor': numeroMotorCtrl.text.trim(),
          if (numeroChasisCtrl.text.trim().isNotEmpty) 'numero_chasis': numeroChasisCtrl.text.trim(),
          if (numeroMastilCtrl.text.trim().isNotEmpty) 'numero_mastil': numeroMastilCtrl.text.trim(),
          'tipo_combustible': categoria == 'transpaleta' ? 'electrica' : (combustible ?? ''),
        },
      );
      _cargar();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      }
    }
  }

  List<dynamic> get _maquinariasFiltradas {
    if (_busqueda.trim().isEmpty) return _maquinarias;
    final q = _busqueda.toLowerCase();
    return _maquinarias.where((m) {
      final codigo = (m['codigo'] as String? ?? '').toLowerCase();
      final tipo = (m['tipo'] as String? ?? '').toLowerCase();
      return codigo.contains(q) || tipo.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final puedeEscribir = context.watch<AuthService>().esAdministrativo;
    final maquinarias = _maquinariasFiltradas;

    return Scaffold(
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nueva maquinaria'),
            )
          : null,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(
              onChanged: (v) => setState(() => _busqueda = v),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Buscar por código o tipo...',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _cargar,
              child: _cargando
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? Center(child: Text('Error: $_error'))
                      : maquinarias.isEmpty
                          ? const Center(child: Text('Sin resultados'))
                          : ListView.builder(
                              padding: const EdgeInsets.all(16),
                              itemCount: maquinarias.length,
                              itemBuilder: (context, i) {
                                final m = maquinarias[i];
                                return Card(
                                  child: ListTile(
                                    leading: m['foto_url'] != null
                                        ? ClipRRect(
                                            borderRadius: BorderRadius.circular(6),
                                            child: Image.network(m['foto_url'], width: 44, height: 44, fit: BoxFit.cover),
                                          )
                                        : const CircleAvatar(child: Icon(Icons.precision_manufacturing)),
                                    title: Text('${m['codigo']} - ${m['tipo']}'),
                                    subtitle: Text('Cliente: ${m['cliente'] ?? '-'} | ${m['ubicacion'] ?? 'Sin ubicacion'}'),
                                    trailing: Chip(
                                      label: Text(m['estado']),
                                      backgroundColor: GomaqColors.fondoChip(m['estado']),
                                      labelStyle: TextStyle(color: GomaqColors.colorEstado(m['estado'])),
                                    ),
                                    onTap: () => Navigator.push(
                                      context,
                                      MaterialPageRoute(builder: (_) => MaquinariaPerfilScreen(maquinariaId: m['id'])),
                                    ),
                                  ),
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
