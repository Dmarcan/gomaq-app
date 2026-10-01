import 'dart:async';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../widgets/dialogos.dart';
import '../../utils/formato.dart';
import '../../utils/numeros.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_vacio.dart';

class OrdenesScreen extends StatefulWidget {
  /// Abre el formulario de nueva OT al entrar (el botón del Dashboard llega con ?nueva=1).
  final bool abrirNueva;

  /// Equipo con el que se abre el formulario de nueva orden (desde el perfil del equipo).
  final int? maquinariaInicial;
  const OrdenesScreen({super.key, this.abrirNueva = false, this.maquinariaInicial});

  @override
  State<OrdenesScreen> createState() => _OrdenesScreenState();
}

class _OrdenesScreenState extends State<OrdenesScreen> {
  List<dynamic> _ordenes = [];
  bool _cargando = true;
  String? _error;

  // Búsqueda y filtro: la API ya los soportaba, pero la pantalla no los ofrecía
  String _busqueda = '';
  String? _estadoFiltro;
  Timer? _esperaBusqueda;

  static const _estados = ['pendiente', 'asignada', 'en_terreno', 'en_reparacion', 'finalizada'];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _cargar();
      if (widget.abrirNueva) {
        // se quita ?nueva=1 de la URL: si quedara, refrescar o recargar la página volvería a
        // abrir el formulario y un clic distraído crearía una OT duplicada
        // el equipo se lee antes de limpiar la URL: al cambiarla la pantalla se reconstruye con
        // maquinariaInicial en null, y el formulario abriria sin el equipo elegido
        final maquinaria = widget.maquinariaInicial;
        context.go('/ordenes');
        _abrirDialogoCrear(maquinariaInicial: maquinaria);
      }
    });
  }

  @override
  void dispose() {
    _esperaBusqueda?.cancel();
    super.dispose();
  }

  void _buscar(String texto) {
    _esperaBusqueda?.cancel();
    _esperaBusqueda = Timer(const Duration(milliseconds: 350), () {
      _busqueda = texto.trim();
      _cargar();
    });
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final params = <String, String>{
        if (_busqueda.isNotEmpty) 'q': _busqueda,
        'estado': ?_estadoFiltro,
      };
      final query = params.isEmpty ? '' : '?${Uri(queryParameters: params).query}';
      final data = (await ApiClient.instance.get('/api/ordenes-trabajo$query'))['items'];
      if (!mounted) return;
      setState(() => _ordenes = data);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear({int? maquinariaInicial}) async {
    List<dynamic> maquinarias = [];
    try {
      maquinarias = (await ApiClient.instance.get('/api/maquinarias'))['items'];
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
      return;
    }

    int? maquinariaId = maquinarias.any((m) => m['id'] == maquinariaInicial) ? maquinariaInicial : null;
    final motivoCtrl = TextEditingController();

    if (!mounted) return;
    final creada = await mostrarFormulario(
      context,
      icono: Icons.assignment_add,
      titulo: 'Nueva orden de trabajo',
      subtitulo: 'Trabajo a hacer en un equipo',
      textoAccion: 'Crear orden',
      contenido: (context, redibujar) {
        final equipo = maquinarias.cast<Map<String, dynamic>?>().firstWhere((m) => m!['id'] == maquinariaId, orElse: () => null);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DropdownMenuFormField<int>(
              initialSelection: maquinariaId,
              expandedInsets: EdgeInsets.zero,
              enableFilter: true,
              requestFocusOnTap: true,
              label: const Text('Equipo *'),
              hintText: 'Busca por código o tipo',
              dropdownMenuEntries: [
                for (final m in maquinarias) DropdownMenuEntry<int>(value: m['id'] as int, label: '${m['codigo']} · ${m['tipo']}'),
              ],
              validator: (v) => v == null ? 'Elige el equipo de la orden.' : null,
              onSelected: (v) => redibujar(() => maquinariaId = v),
            ),
            if (equipo != null) ...[
              const SizedBox(height: 10),
              // el cliente no se pregunta: la base ya sabe quién tiene el equipo, y el servidor
              // lo copia a la orden al crearla
              LineaInfo(
                icono: Icons.business,
                texto: equipo['cliente'] != null ? 'Cliente: ${equipo['cliente']}' : 'Sin cliente: es una mantención interna',
              ),
            ],
            separadorCampos,
            TextFormField(
              controller: motivoCtrl,
              minLines: 2,
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
              decoration: decoracionCampo('Motivo', obligatorio: true, ayuda: 'Qué falla o qué trabajo se pide.'),
              validator: obligatorio('Escribe el motivo de la orden.'),
            ),
          ],
        );
      },
      alGuardar: () => ApiClient.instance.post('/api/ordenes-trabajo', {
        'maquinaria_id': maquinariaId,
        'motivo': motivoCtrl.text.trim(),
      }),
    );
    motivoCtrl.dispose();
    if (creada && mounted) {
      _cargar();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Orden de trabajo creada')));
    }
  }

  Future<void> _abrirDetalle(Map<String, dynamic> orden) async {
    await showDialog(
      context: context,
      builder: (_) => _DetalleOrdenDialog(orden: orden, onCambio: _cargar),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final puedeCrear = auth.esAdministrativo || auth.esGerente;

    return Scaffold(
      floatingActionButton: puedeCrear
          ? FloatingActionButton.extended(onPressed: _abrirDialogoCrear, icon: const Icon(Icons.add), label: const Text('Nueva OT'))
          : null,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    onChanged: _buscar,
                    decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search),
                      hintText: 'Buscar por equipo, cliente o motivo...',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                DropdownButton<String?>(
                  value: _estadoFiltro,
                  hint: const Text('Todos los estados'),
                  items: [
                    const DropdownMenuItem<String?>(value: null, child: Text('Todos los estados')),
                    for (final e in _estados)
                      DropdownMenuItem<String?>(value: e, child: Text(GomaqColors.etiquetaEstado(e))),
                  ],
                  onChanged: (v) {
                    setState(() => _estadoFiltro = v);
                    _cargar();
                  },
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text('Error: $_error'))
                : _ordenes.isEmpty
                    ? EstadoVacio(
                        icono: Icons.assignment_outlined,
                        titulo: _busqueda.isEmpty && _estadoFiltro == null
                            ? 'Aún no hay órdenes de trabajo'
                            : 'Ninguna orden coincide con la búsqueda',
                        mensaje: _busqueda.isEmpty && _estadoFiltro == null
                            ? 'Crea la primera con «Nueva OT».'
                            : 'Prueba con otro texto o quita el filtro de estado.',
                      )
                    : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _ordenes.length,
                    itemBuilder: (context, i) {
                      final o = _ordenes[i];
                      return Card(
                        child: ListTile(
                          title: Text('OT #${o['id']} - ${o['maquinaria_codigo'] ?? ''}'),
                          subtitle: Text('${o['motivo'] ?? ''} | Cliente: ${o['cliente_nombre'] ?? '-'}'),
                          trailing: EstadoChip(estado: o['estado']),
                          onTap: () => _abrirDetalle(o),
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

class _DetalleOrdenDialog extends StatefulWidget {
  final Map<String, dynamic> orden;
  final VoidCallback onCambio;
  const _DetalleOrdenDialog({required this.orden, required this.onCambio});

  @override
  State<_DetalleOrdenDialog> createState() => _DetalleOrdenDialogState();
}

class _DetalleOrdenDialogState extends State<_DetalleOrdenDialog> {
  List<dynamic> _mecanicos = [];
  List<dynamic> _lineas = [];
  int? _mecanicoSeleccionado;
  final _valorizacionCtrl = TextEditingController();
  bool _cargandoAccion = false;
  // avisos en su campo: antes cada uno era un mensaje pasajero abajo, o un boton que no hacia nada
  String? _errorMecanico;
  String? _errorValorizacion;
  String? _errorFolio;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _cargarMecanicos();
      _cargarLineas();
    });
  }

  Future<void> _cargarMecanicos() async {
    try {
      final data = await ApiClient.instance.get('/api/usuarios?rol=mecanico');
      if (mounted) setState(() => _mecanicos = data);
    } catch (_) {}
  }

  Future<void> _cargarLineas() async {
    try {
      final data = await ApiClient.instance.get('/api/insumos/orden/${widget.orden['id']}');
      if (mounted) setState(() => _lineas = data);
    } catch (_) {}
  }

  /// Resuelve el "?" del papel. Al cambiar una línea el backend recalcula el facturable de
  /// la OT, así que se refresca el listado para que Facturación quede consistente.
  Future<void> _resolverLinea(dynamic lineaId, String facturable) async {
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch(
        '/api/insumos/orden/${widget.orden['id']}/linea/$lineaId',
        {'facturable': facturable},
      );
      await _cargarLineas();
      widget.onCambio();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  /// Anula una línea mal ingresada: queda tachada y el repuesto vuelve a su ubicación.
  /// Desde el panel se puede incluso con la OT cerrada, para corregir lo que el mecánico no alcanzó.
  Future<void> _anularLinea(dynamic linea) async {
    final confirmado = await mostrarConfirmacion(
      context,
      titulo: '¿Anular esta línea?',
      mensaje: '${linea['insumo_nombre'] ?? linea['descripcion'] ?? 'Repuesto'} · ${linea['cantidad']}\n\n'
          'La línea queda tachada, el repuesto vuelve a su ubicación y deja de contar como gasto del equipo. '
          'No se puede deshacer.',
      textoAccion: 'Anular línea',
      peligro: true,
    );
    if (!confirmado) return;
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.post('/api/insumos/orden/${widget.orden['id']}/linea/${linea['id']}/anular', {});
      await _cargarLineas();
      widget.onCambio();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  Future<void> _asignar() async {
    if (_mecanicoSeleccionado == null) {
      setState(() => _errorMecanico = 'Elige el mecánico al que se asigna la orden.');
      return;
    }
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/asignar', {'mecanico_id': _mecanicoSeleccionado});
      widget.onCambio();
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  Future<void> _aprobarValorizacion() async {
    // "18.500" son dieciocho mil quinientos: leido con tryParse era 18,5 pesos
    final monto = parsearMonto(_valorizacionCtrl.text);
    if (monto == null || monto <= 0) {
      setState(() => _errorValorizacion = 'Escribe un monto válido, por ejemplo 249.900.');
      return;
    }
    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.patch('/api/ordenes-trabajo/${widget.orden['id']}/valorizacion', {'valorizacion': monto});
      widget.onCambio();
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  final _folioCtrl = TextEditingController();

  Future<void> _subirFactura() async {
    if (_folioCtrl.text.trim().isEmpty) {
      setState(() => _errorFolio = 'Escribe el folio de la factura.');
      return;
    }
    final resultado = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf'], withData: true);
    if (resultado == null || resultado.files.single.bytes == null) return;
    final archivo = resultado.files.single;

    setState(() => _cargandoAccion = true);
    try {
      await ApiClient.instance.postMultipart(
        '/api/ordenes-trabajo/${widget.orden['id']}/factura',
        bytes: archivo.bytes!,
        filename: archivo.name,
        fields: {'folio': _folioCtrl.text.trim()},
      );
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Factura subida correctamente')));
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _cargandoAccion = false);
    }
  }

  static const _etiquetasTipoServicio = {
    'preventivo': 'Preventivo',
    'reparacion': 'Reparación',
    'garantia_full_mantencion': 'Garantía / Full Mantención',
    'correctivo': 'Correctivo',
    'bateria_cargador': 'Batería / Cargador',
    'administrativo': 'Administrativo',
  };

  String _etiquetaTipoServicio(dynamic valor) =>
      valor == null ? 'Sin marcar' : (_etiquetasTipoServicio[valor] ?? valor.toString());

  /// Repuestos de la OT con su facturable por línea, como la tabla del talonario.
  /// Las líneas "por decidir" (el "?" del papel) son las que gerencia tiene que resolver.
  Widget _seccionLineas(AuthService auth) {
    if (_lineas.isEmpty) {
      return const Padding(
        padding: EdgeInsets.only(bottom: 16),
        child: Text('Sin repuestos registrados', style: TextStyle(color: Colors.black54)),
      );
    }
    final puedeResolver = auth.esGerente || auth.esAdministrativo;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Repuestos utilizados', style: TextStyle(fontWeight: FontWeight.bold)),
        for (final l in _lineas)
          if (l['anulada_at'] != null)
            // tachada, como en el talonario: queda la constancia de que se anuló
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(
                '${l['insumo_nombre'] ?? l['descripcion'] ?? 'Repuesto'} · ${l['cantidad']}',
                style: const TextStyle(decoration: TextDecoration.lineThrough, color: Colors.black54),
              ),
              subtitle: const Text('Anulada', style: TextStyle(fontSize: 12, color: Colors.black54)),
            )
          else
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('${l['insumo_nombre'] ?? l['descripcion'] ?? 'Repuesto'} · ${l['cantidad']}'),
              subtitle: Text(
                l['precio_unitario'] == null ? 'Sin precio' : '\$${l['precio_unitario']}',
                style: const TextStyle(fontSize: 12),
              ),
              trailing: puedeResolver
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        DropdownButton<String>(
                          value: l['facturable'] as String? ?? 'pendiente',
                          underline: const SizedBox.shrink(),
                          items: const [
                            DropdownMenuItem(value: 'si', child: Text('Se cobra')),
                            DropdownMenuItem(value: 'no', child: Text('No se cobra')),
                            DropdownMenuItem(value: 'pendiente', child: Text('Por decidir')),
                          ],
                          onChanged: _cargandoAccion ? null : (v) => _resolverLinea(l['id'], v!),
                        ),
                        IconButton(
                          tooltip: 'Anular línea',
                          icon: const Icon(Icons.remove_circle_outline, color: GomaqColors.estadoNegativo),
                          onPressed: _cargandoAccion ? null : () => _anularLinea(l),
                        ),
                      ],
                    )
                  : Text(l['facturable']?.toString() ?? 'pendiente'),
            ),
        const Divider(height: 32),
      ],
    );
  }

  /// Una fila de dato: la etiqueta apagada a la izquierda y el valor a su lado.
  Widget _fila(String etiqueta, Widget valor) {
    const estiloEtiqueta = TextStyle(fontSize: 13, color: Colors.black54);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      // Con 170 px para la etiqueta, en un teléfono el valor quedaba en ~100 px: bajo 420 px
      // la etiqueta pasa encima del valor.
      child: LayoutBuilder(
        builder: (context, c) {
          if (c.maxWidth < 420) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [Text(etiqueta, style: estiloEtiqueta), valor],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 170, child: Text(etiqueta, style: estiloEtiqueta)),
              Expanded(child: valor),
            ],
          );
        },
      ),
    );
  }

  Widget _texto(dynamic valor, {String siVacio = '-'}) {
    final t = valor?.toString().trim() ?? '';
    return Text(t.isEmpty ? siVacio : t, style: TextStyle(fontSize: 14, color: t.isEmpty ? Colors.black54 : Colors.black87));
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final o = widget.orden;
    final valorizacion = o['valorizacion'];

    return CuadroDialogo(
      icono: Icons.assignment,
      titulo: 'OT #${o['id']} · ${o['maquinaria_codigo'] ?? ''}',
      subtitulo: 'Detalle de la orden de trabajo',
      ancho: 620,
      cuerpo: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          _fila('Estado', Align(alignment: Alignment.centerLeft, child: EstadoChip(estado: o['estado']))),
          _fila('Cliente', _texto(o['cliente_nombre'])),
          _fila('Tipo de servicio', _texto(_etiquetaTipoServicio(o['tipo_servicio']))),
          _fila('Motivo', _texto(o['motivo'])),
          // el talonario separa lo que se encontró al llegar de lo que se hizo
          _fila('Observaciones iniciales', _texto(o['diagnostico'], siVacio: 'Sin registrar')),
          _fila('Observaciones finales', _texto(o['observacion_final'], siVacio: 'Sin registrar')),
          if (o['folio_papel'] != null) _fila('OT en papel', _texto('N° ${o['folio_papel']}')),
          _fila('Facturable', _texto(o['facturable'] == true ? 'Sí' : 'No')),
          _fila('Valorización', _texto(valorizacion == null ? null : Formato.clp(num.tryParse('$valorizacion')), siVacio: 'Sin aprobar')),
          const Divider(height: 32),

          _seccionLineas(auth),

          if (auth.esAdministrativo && o['mecanico_id'] == null) ...[
            const TituloSeccion('Asignar mecánico'),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: DropdownButtonFormField<int>(
                    isExpanded: true,
                    decoration: decoracionCampo('Mecánico').copyWith(errorText: _errorMecanico),
                    items: _mecanicos.map<DropdownMenuItem<int>>((m) => DropdownMenuItem(value: m['id'], child: Text(m['nombre']))).toList(),
                    onChanged: (v) => setState(() {
                      _mecanicoSeleccionado = v;
                      _errorMecanico = null;
                    }),
                  ),
                ),
                const SizedBox(width: 12),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: FilledButton(onPressed: _cargandoAccion ? null : _asignar, child: const Text('Asignar')),
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],

          if (auth.esGerente && o['facturable'] == true && o['valorizacion'] == null) ...[
            const TituloSeccion('Aprobar valorización'),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _valorizacionCtrl,
                    keyboardType: TextInputType.number,
                    decoration: decoracionCampo('Monto', prefijo: r'$ ', ayuda: 'En pesos, por ejemplo 249.900.').copyWith(errorText: _errorValorizacion),
                    onChanged: (_) {
                      if (_errorValorizacion != null) setState(() => _errorValorizacion = null);
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: FilledButton(onPressed: _cargandoAccion ? null : _aprobarValorizacion, child: const Text('Aprobar')),
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],

          if (auth.esAdministrativo && o['facturable'] == true) ...[
            const TituloSeccion('Factura'),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _folioCtrl,
                    decoration: decoracionCampo('Folio SII').copyWith(errorText: _errorFolio),
                    onChanged: (_) {
                      if (_errorFolio != null) setState(() => _errorFolio = null);
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: OutlinedButton.icon(
                    onPressed: _cargandoAccion ? null : _subirFactura,
                    icon: const Icon(Icons.upload_file),
                    label: const Text('Subir PDF de factura'),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
      acciones: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar'))],
    );
  }
}
