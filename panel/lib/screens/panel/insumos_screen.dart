import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../utils/formato.dart';
import '../../utils/iva.dart';
import '../../widgets/campo_costo_iva.dart';
import '../../utils/numeros.dart';
import '../../utils/unidades.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';
import 'descuadres_tab.dart';

class InsumosScreen extends StatefulWidget {
  /// Pestaña con la que se abre: 'descuadres' llega desde el dashboard.
  final String? pestanaInicial;
  const InsumosScreen({super.key, this.pestanaInicial});

  @override
  State<InsumosScreen> createState() => _InsumosScreenState();
}

class _InsumosScreenState extends State<InsumosScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  List<dynamic> _catalogo = [];
  List<dynamic> _movimientos = [];
  List<dynamic> _descuadres = [];
  List<dynamic> _motivos = [];
  String? _errorDescuadres;
  bool _cargando = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this, initialIndex: switch (widget.pestanaInicial) { 'consumos' => 1, 'descuadres' => 2, _ => 0 });
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final catalogo = await ApiClient.instance.get('/api/insumos');
      final movimientos = (await ApiClient.instance.get('/api/insumos/movimientos'))['items'];
      // los descuadres y los motivos se piden aparte: si fallan, el catálogo y los consumos siguen
      // usables y la pestaña Descuadres muestra su propio error con Reintentar
      List<dynamic> descuadres = [];
      List<dynamic> motivos = [];
      String? errorDescuadres;
      try {
        descuadres = await ApiClient.instance.get('/api/insumos/descuadres');
        motivos = await ApiClient.instance.get('/api/insumos/motivos-ajuste');
      } catch (e) {
        errorDescuadres = mensajeErrorCarga(e);
      }
      if (!mounted) return;
      setState(() {
        _catalogo = catalogo;
        _movimientos = movimientos;
        _descuadres = descuadres;
        _motivos = motivos;
        _errorDescuadres = errorDescuadres;
      });
    } catch (e) {
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _abrirDialogoCrear() async {
    final nombreCtrl = TextEditingController();
    final unidadCtrl = TextEditingController();
    final costoCtrl = TextEditingController();
    // las que más se usan, a un toque: escribir "litro" o "Litro" o "lts" da tres unidades distintas
    const sugeridas = ['unidad', 'litro', 'kg', 'metro'];
    // el costo se guarda siempre neto; con la casilla marcada se convierte antes de enviar
    var incluyeIva = false;

    final creado = await mostrarFormulario(
      context,
      icono: Icons.inventory_2,
      titulo: 'Nuevo insumo',
      subtitulo: 'Repuesto o material del inventario',
      textoAccion: 'Crear insumo',
      ancho: 440,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextFormField(
            controller: nombreCtrl,
            autofocus: true,
            textCapitalization: TextCapitalization.sentences,
            decoration: decoracionCampo('Nombre', obligatorio: true),
            validator: obligatorio('Escribe el nombre del insumo.'),
          ),
          separadorCampos,
          TextFormField(
            controller: unidadCtrl,
            onChanged: (_) => redibujar(() {}),
            decoration: decoracionCampo('Unidad de medida', obligatorio: true),
            validator: obligatorio('Escribe la unidad de medida.'),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final u in sugeridas)
                ChoiceChip(
                  label: Text(u),
                  selected: unidadCtrl.text.trim() == u,
                  onSelected: (_) => redibujar(() => unidadCtrl.text = u),
                ),
            ],
          ),
          separadorCampos,
          CampoCostoIva(
            controller: costoCtrl,
            incluyeIva: incluyeIva,
            onIvaChanged: (v) => redibujar(() => incluyeIva = v),
            onTextoChanged: () => redibujar(() {}),
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.post('/api/insumos', {
        'nombre': nombreCtrl.text.trim(),
        'unidad_medida': unidadCtrl.text.trim(),
        'costo_unitario': costoNetoParaGuardar(parsearMonto(costoCtrl.text), incluyeIva: incluyeIva),
      }),
    );
    nombreCtrl.dispose();
    unidadCtrl.dispose();
    costoCtrl.dispose();
    if (creado && mounted) {
      _cargar();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Insumo creado')));
    }
  }

  Future<void> _abrirDialogoIngreso(Map<String, dynamic> insumo) async {
    final cantidadCtrl = TextEditingController();
    final unidad = '${insumo['unidad_medida']}';
    final actual = parsearNumero('${insumo['stock_actual'] ?? 0}') ?? 0;

    final registrado = await mostrarFormulario(
      context,
      icono: Icons.move_to_inbox,
      titulo: 'Ingreso de stock',
      subtitulo: '${insumo['nombre']}',
      textoAccion: 'Registrar ingreso',
      ancho: 420,
      contenido: (context, redibujar) {
        final cantidad = parsearNumero(cantidadCtrl.text);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextFormField(
              controller: cantidadCtrl,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              onChanged: (_) => redibujar(() {}),
              decoration: decoracionCampo('Cantidad a sumar', obligatorio: true, sufijo: unidad),
              validator: numeroPositivo('Escribe una cantidad mayor a cero.'),
            ),
            const SizedBox(height: 12),
            // lo que quedaría en bodega, antes de confirmar: evita sumar 100 queriendo sumar 10
            LineaInfo(
              icono: Icons.inventory,
              texto: cantidad != null && cantidad > 0
                  ? 'Stock actual: ${Formato.medida(actual, unidad)} → quedarán ${Formato.medida(actual + cantidad, unidad)}'
                  : 'Stock actual: ${Formato.medida(actual, unidad)}',
            ),
          ],
        );
      },
      alGuardar: () => ApiClient.instance.post('/api/insumos/${insumo['id']}/ingreso', {'cantidad': parsearNumero(cantidadCtrl.text)}),
    );
    cantidadCtrl.dispose();
    if (registrado && mounted) {
      _cargar();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ingreso de stock registrado')));
    }
  }

  @override
  Widget build(BuildContext context) {
    // crear insumos e ingresar stock es exclusivo de Administrativo (backend igual);
    // el Gerente conserva la lectura del catalogo y de los consumos
    final puedeEscribir = context.watch<AuthService>().esAdministrativo;
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        // sin título: el marco del panel ya muestra el nombre de la sección justo arriba
        toolbarHeight: 0,
        bottom: TabBar(
          controller: _tabController,
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: [
            const Tab(text: 'Catálogo'),
            const Tab(text: 'Consumos recientes'),
            Tab(text: _errorDescuadres != null ? 'Descuadres' : 'Descuadres (${_descuadres.length})'),
          ],
        ),
      ),
      floatingActionButton: puedeEscribir
          ? FloatingActionButton.extended(
              onPressed: _abrirDialogoCrear,
              icon: const Icon(Icons.add),
              label: const Text('Nuevo insumo'),
            )
          : null,
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? EstadoError(titulo: 'No se pudieron cargar los insumos', mensaje: _error!, onReintentar: _cargar)
              : TabBarView(
                  controller: _tabController,
                  children: [
                    if (_catalogo.isEmpty)
                      EstadoVacio(
                        icono: Icons.inventory_2_outlined,
                        titulo: 'Aún no hay repuestos en el catálogo',
                        mensaje: 'Agrega los repuestos que usa el taller para que los mecánicos '
                            'puedan elegirlos al registrar un trabajo.',
                        textoAccion: puedeEscribir ? 'Agregar el primero' : null,
                        onAccion: puedeEscribir ? _abrirDialogoCrear : null,
                      )
                    else
                    RefreshIndicator(
                      onRefresh: _cargar,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _catalogo.length,
                        itemBuilder: (context, i) {
                          final insumo = _catalogo[i];
                          return Card(
                            child: ListTile(
                              title: Text(insumo['nombre']),
                              subtitle: Text(
                                'Stock: ${medidaConUnidad(insumo['stock_actual'], '${insumo['unidad_medida'] ?? ''}', siVacio: '-')} · Costo unitario: ${Formato.clp(parsearNumero('${insumo['costo_unitario'] ?? ''}'), siVacio: '-')}',
                              ),
                              trailing: !puedeEscribir
                                  ? null
                                  : OutlinedButton.icon(
                                onPressed: () => _abrirDialogoIngreso(insumo),
                                icon: const Icon(Icons.add_box_outlined),
                                label: const Text('Ingreso'),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                    if (_movimientos.isEmpty)
                      const EstadoVacio(
                        icono: Icons.history,
                        titulo: 'Sin consumos registrados',
                        mensaje: 'Aquí aparecen los repuestos usados en las órdenes de trabajo, '
                            'las cargas de furgón y las compras.',
                      )
                    else
                    RefreshIndicator(
                      onRefresh: _cargar,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _movimientos.length,
                        itemBuilder: (context, i) {
                          final mov = _movimientos[i];
                          return Card(
                            child: ListTile(
                              // una línea escrita a mano no tiene insumo del catálogo: antes decía "null"
                              title: Text(
                                '${mov['tipo'] == 'ajuste' ? 'Ajuste de conteo · ' : ''}'
                                '${mov['insumo_nombre'] ?? mov['descripcion'] ?? 'Repuesto'} · '
                                '${mov['tipo'] == 'ajuste' ? (mov['ubicacion_destino_id'] != null ? '+' : '-') : ''}'
                                '${medidaConUnidad(mov['cantidad'], '${mov['unidad_medida'] ?? ''}', siVacio: '-')}',
                                style: mov['anulada_at'] != null
                                    ? const TextStyle(decoration: TextDecoration.lineThrough, color: Colors.black54)
                                    : null,
                              ),
                              subtitle: Text(
                                '${mov['anulada_at'] != null ? 'Anulada · ' : ''}'
                                '${mov['maquinaria_codigo'] != null ? 'Equipo ${mov['maquinaria_codigo']} · ' : ''}'
                                '${mov['usuario_nombre'] ?? '-'} · ${Formato.fechaHora(mov['created_at'])}',
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                    DescuadresTab(
                      descuadres: _descuadres,
                      catalogo: _catalogo,
                      motivos: _motivos,
                      puedeEscribir: puedeEscribir,
                      onRecargar: _cargar,
                      error: _errorDescuadres,
                    ),
                  ],
                ),
    );
  }
}
