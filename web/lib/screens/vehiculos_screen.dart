import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../widgets/dialogos.dart';
import '../utils/numeros.dart';

/// Vehículos del personal. Asignar uno a un mecánico le crea además su ubicación de stock:
/// ese furgón pasa a tener existencias propias, separadas de la bodega central.
///
/// Un vehículo sin mecánico asignado no lleva stock — es el caso del furgón de compras, que
/// no sale a terreno (entrevista el jefe de taller, punto 3).
class VehiculosScreen extends StatefulWidget {
  const VehiculosScreen({super.key});

  @override
  State<VehiculosScreen> createState() => _VehiculosScreenState();
}

class _VehiculosScreenState extends State<VehiculosScreen> {
  List<dynamic> _vehiculos = [];
  List<dynamic> _mecanicos = [];
  bool _cargando = true;
  String? _error;

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
      final vehiculos = await ApiClient.instance.get('/api/vehiculos');
      final mecanicos = await ApiClient.instance.get('/api/usuarios?rol=mecanico');
      if (!mounted) return;
      setState(() {
        _vehiculos = vehiculos;
        _mecanicos = mecanicos;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _formulario({Map<String, dynamic>? vehiculo}) async {
    final esNuevo = vehiculo == null;
    final patenteCtrl = TextEditingController(text: vehiculo?['patente']?.toString() ?? '');
    final marcaCtrl = TextEditingController(text: vehiculo?['marca']?.toString() ?? '');
    final modeloCtrl = TextEditingController(text: vehiculo?['modelo']?.toString() ?? '');
    final anioCtrl = TextEditingController(text: vehiculo?['anio']?.toString() ?? '');
    final tipoCtrl = TextEditingController(text: vehiculo?['tipo']?.toString() ?? 'Furgón');
    final kmCtrl = TextEditingController(text: vehiculo?['kilometraje']?.toString() ?? '');
    int? mecanicoId = vehiculo?['usuario_id'] as int?;

    final guardado = await mostrarFormulario(
      context,
      icono: Icons.local_shipping_outlined,
      titulo: esNuevo ? 'Nuevo vehículo' : 'Editar ${vehiculo['patente']}',
      subtitulo: esNuevo ? 'Vehículo del personal' : 'Datos del vehículo y su mecánico',
      textoAccion: esNuevo ? 'Crear vehículo' : 'Guardar cambios',
      ancho: 520,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (esNuevo) ...[
                Expanded(
                  child: TextFormField(
                    controller: patenteCtrl,
                    autofocus: true,
                    textCapitalization: TextCapitalization.characters,
                    decoration: decoracionCampo('Patente', obligatorio: true),
                    validator: obligatorio('Escribe la patente.'),
                  ),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(child: TextFormField(controller: tipoCtrl, decoration: decoracionCampo('Tipo'))),
            ],
          ),
          separadorCampos,
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: TextFormField(controller: marcaCtrl, decoration: decoracionCampo('Marca'))),
              const SizedBox(width: 12),
              Expanded(child: TextFormField(controller: modeloCtrl, decoration: decoracionCampo('Modelo'))),
            ],
          ),
          separadorCampos,
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextFormField(
                  controller: anioCtrl,
                  keyboardType: TextInputType.number,
                  decoration: decoracionCampo('Año'),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) return null;
                    final anio = int.tryParse(v.trim());
                    final maximo = DateTime.now().year + 1;
                    return (anio == null || anio < 1950 || anio > maximo) ? 'Escribe un año entre 1950 y $maximo.' : null;
                  },
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  controller: kmCtrl,
                  keyboardType: TextInputType.number,
                  decoration: decoracionCampo('Kilometraje', sufijo: 'km'),
                  validator: numeroOpcional('Escribe un kilometraje válido, por ejemplo 45.000.', monto: true),
                ),
              ),
            ],
          ),
          const Divider(height: 28),
          DropdownButtonFormField<int?>(
            initialValue: mecanicoId,
            isExpanded: true,
            decoration: decoracionCampo('Mecánico asignado'),
            items: [
              const DropdownMenuItem<int?>(value: null, child: Text('Sin asignar (no lleva stock)')),
              for (final m in _mecanicos) DropdownMenuItem<int?>(value: m['id'] as int, child: Text(m['nombre'])),
            ],
            onChanged: (v) => redibujar(() => mecanicoId = v),
          ),
          const SizedBox(height: 10),
          const LineaInfo(icono: Icons.inventory_2_outlined, texto: 'Al asignarle un mecánico, el furgón pasa a tener su propio stock de repuestos.'),
        ],
      ),
      alGuardar: () {
        final datos = {
          if (esNuevo) 'patente': patenteCtrl.text.trim(),
          'marca': marcaCtrl.text.trim(),
          'modelo': modeloCtrl.text.trim(),
          'anio': int.tryParse(anioCtrl.text.trim()),
          'tipo': tipoCtrl.text.trim(),
          'kilometraje': parsearMonto(kmCtrl.text)?.round(),
          'usuario_id': mecanicoId,
        };
        return esNuevo ? ApiClient.instance.post('/api/vehiculos', datos) : ApiClient.instance.patch('/api/vehiculos/${vehiculo['id']}', datos);
      },
    );
    for (final c in [patenteCtrl, marcaCtrl, modeloCtrl, anioCtrl, tipoCtrl, kmCtrl]) {
      c.dispose();
    }
    if (guardado && mounted) {
      _cargar();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(esNuevo ? 'Vehículo creado' : 'Vehículo actualizado')));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Error: $_error'),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _cargar, child: const Text('Reintentar')),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // el titulo lo pone el marco del panel (admin_dashboard_screen): aca va la bajada
        // a la izquierda y la accion a la derecha, en la misma linea
        // con el margen de 24 px del titulo del marco: antes la bajada quedaba pegada a la barra
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Text(
                  'Cada mecánico tiene un furgón asignado y ese furgón lleva su propio stock de repuestos.',
                  style: TextStyle(fontSize: 13, color: Colors.grey[700]),
                ),
              ),
              const SizedBox(width: 16),
              FilledButton.icon(
                onPressed: () => _formulario(),
                icon: const Icon(Icons.add),
                label: const Text('Nuevo vehículo'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Expanded(
          child: _vehiculos.isEmpty
              ? const Center(child: Text('Sin vehículos registrados'))
              : ListView.separated(
                  itemCount: _vehiculos.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final v = _vehiculos[i] as Map<String, dynamic>;
                    final asignado = v['usuario_nombre'] != null;
                    return ListTile(
                      leading: Icon(
                        Icons.local_shipping_outlined,
                        color: asignado ? null : Colors.grey,
                      ),
                      title: Text(
                        '${v['patente']}  ·  ${[v['marca'], v['modelo']].where((x) => x != null).join(' ')}',
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                      subtitle: Text(
                        asignado
                            ? '${v['usuario_nombre']}${v['kilometraje'] == null ? '' : ' · ${v['kilometraje']} km'}'
                            : 'Sin mecánico asignado · no lleva stock',
                        style: const TextStyle(fontSize: 12),
                      ),
                      trailing: TextButton(
                        onPressed: () => _formulario(vehiculo: v),
                        child: const Text('Editar'),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }
}
