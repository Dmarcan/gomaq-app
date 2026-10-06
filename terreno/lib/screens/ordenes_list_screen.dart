import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/auth_service.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/orden_card.dart';
import '../widgets/selector_equipo.dart';
import '../widgets/sync_banner.dart';
import 'flota_screen.dart';
import 'mi_cuenta_screen.dart';
import 'mi_furgon_screen.dart';
import 'orden_detail_screen.dart';
import 'ordenes_disponibles_screen.dart';

class OrdenesListScreen extends StatefulWidget {
  const OrdenesListScreen({super.key});

  @override
  State<OrdenesListScreen> createState() => _OrdenesListScreenState();
}

class _OrdenesListScreenState extends State<OrdenesListScreen> with WidgetsBindingObserver {
  // Sin esto la lista solo se actualizaba al abrir la app: un cambio hecho en la oficina no llegaba
  // hasta cerrar y reabrir. Se refresca al volver a primer plano (si pasaron mas de
  // _minimoEntreRefrescos) y cada _intervaloRefresco mientras la app esta abierta.
  static const _minimoEntreRefrescos = Duration(seconds: 60);
  static const _intervaloRefresco = Duration(minutes: 3);

  List<OrdenTrabajo> _ordenes = [];
  int _pendientes = 0;
  int _enError = 0;
  String? _problemaEnvio;
  // ordenes sin mecanico que se pueden tomar; null = no se pudo consultar (sin senal)
  int? _disponibles;
  StreamSubscription<bool>? _conexionSub;
  Timer? _temporizador;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _cargarLocal();

    // SyncService.notifyListeners() no puede dispararse de forma sincronica
    // durante initState (todavia en fase de build) - se difiere al primer frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _sincronizarSiHayConexion();
      _conexionSub = context.read<ConnectivityService>().onCambioConexion.listen((online) {
        if (online) _sincronizarConReintentos();
      });
      _temporizador = Timer.periodic(_intervaloRefresco, (_) => _refrescarSiCorresponde());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _temporizador?.cancel();
    _conexionSub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState estado) {
    if (estado == AppLifecycleState.resumed) _refrescarSiCorresponde();
  }

  void _refrescarSiCorresponde() {
    if (!mounted) return;
    final sync = context.read<SyncService>();
    if (sync.sincronizando) return;
    final ultima = sync.ultimaSincronizacion;
    if (ultima != null && DateTime.now().difference(ultima) < _minimoEntreRefrescos) return;
    _sincronizarSiHayConexion();
  }

  Future<void> _cargarLocal() async {
    final db = await LocalDatabase.instance.database;
    final rows = await db.query('ordenes_locales', orderBy: 'fecha_creacion DESC');
    if (!mounted) return;
    final syncService = context.read<SyncService>();
    final pendientes = await syncService.contarPendientes();
    final enError = await syncService.contarEnError();
    final problema = await syncService.ultimoProblemaPendiente();
    if (!mounted) return;
    setState(() {
      _ordenes = rows.map(OrdenTrabajo.fromLocalMap).toList();
      _pendientes = pendientes;
      _enError = enError;
      _problemaEnvio = problema;
    });
  }

  /// Qué cambio falló, en palabras del mecánico. Antes mostraba el nombre interno de la
  /// tarea y el id local ("insumo · OT #-1726...").
  static String _describirTarea(Map<String, dynamic> tarea) {
    const nombres = {
      'insumo': 'Repuesto',
      'anular_insumo': 'Anulación de repuesto',
      'evidencia': 'Foto',
      'finalizar': 'Cierre de la orden',
      'diagnostico': 'Observaciones',
      'datos_ot': 'Datos de la orden',
      'checklist': 'Sistemas intervenidos',
      'tramo': 'Tramo de trabajo',
      'horometro': 'Lectura de horómetro',
      'crear_ot': 'Orden nueva en terreno',
    };
    final id = tarea['orden_trabajo_id'] as int;
    final orden = id == 0 ? 'sin orden' : id < 0 ? 'orden creada sin señal' : 'OT-$id';
    return '${nombres[tarea['tipo']] ?? tarea['tipo']} · $orden';
  }

  /// Cerrar sesion estaba a un toque, junto al titulo. Con cambios sin enviar se explica que
  /// no se pierden, pero que solo esta cuenta puede enviarlos.
  Future<void> _confirmarCerrarSesion() async {
    final auth = context.read<AuthService>();
    final pendientes = await context.read<SyncService>().contarPendientes();
    if (!mounted) return;
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('¿Cerrar sesión?'),
        content: Text(pendientes > 0
            ? 'Tienes $pendientes cambios sin enviar. Quedan guardados en el teléfono y se enviarán '
                'cuando vuelvas a entrar con tu cuenta. Mientras tanto, nadie más podrá usar la app '
                'en este teléfono.'
            : 'Tu trabajo está sincronizado.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Cerrar sesión')),
        ],
      ),
    );
    if (confirmado == true) await auth.logout();
  }

  /// Orden nueva de cualquier equipo de la flota, sin esperar a que la oficina la cree. Nace con
  /// un id local y la cola la crea en el servidor al haber senal (igual que "intervine otro equipo").
  Future<void> _crearOrden() async {
    final equipo = await elegirEquipo(context);
    if (equipo == null || !mounted) return;
    final motivoCtrl = TextEditingController();
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Nueva orden para ${equipo['codigo']}'),
        content: TextField(
          controller: motivoCtrl,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Motivo o qué se encontró'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Crear orden')),
        ],
      ),
    );
    final motivo = motivoCtrl.text.trim();
    motivoCtrl.dispose();
    if (confirmado != true || !mounted) return;
    final sync = context.read<SyncService>();
    final ordenId = await sync.encolarOtEnTerreno(
      maquinariaId: equipo['id'] as int,
      maquinariaCodigo: equipo['codigo'] as String,
      motivo: motivo.isEmpty ? null : motivo,
    );
    await _cargarLocal();
    if (!mounted) return;
    _sincronizarSiHayConexion();
    await Navigator.push(context, MaterialPageRoute(builder: (_) => OrdenDetailScreen(ordenId: ordenId)));
    _cargarLocal();
  }

  Future<void> _mostrarErroresDeSync() async {
    final syncService = context.read<SyncService>();
    final tareas = await syncService.tareasConProblema();
    if (!mounted) return;
    await showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Cambios que no se han enviado'),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final t in tareas)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    leading: const Icon(Icons.error_outline, color: GomaqColors.estadoNegativo),
                    title: Text(_describirTarea(t)),
                    subtitle: Text('${t['ultimo_error'] ?? 'Error desconocido'}', maxLines: 3, overflow: TextOverflow.ellipsis),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cerrar')),
          FilledButton(
            onPressed: () async {
              Navigator.pop(dialogContext);
              await syncService.reintentarErrores();
              _cargarLocal();
            },
            child: const Text('Reintentar todo'),
          ),
        ],
      ),
    );
  }

  // El sistema operativo suele avisar "conectado" un par de segundos antes
  // de que la red realmente tenga salida a internet. Reintenta un par de
  // veces con espera creciente para no depender de que el mecanico refresque a mano.
  Future<void> _sincronizarConReintentos() async {
    const esperas = [Duration(seconds: 2), Duration(seconds: 5), Duration(seconds: 10)];
    for (final espera in esperas) {
      await Future.delayed(espera);
      if (!mounted) return;
      final huboExito = await _sincronizarSiHayConexion();
      if (huboExito) return;
    }
  }

  Future<bool> _sincronizarSiHayConexion() async {
    if (!context.read<ConnectivityService>().online) return false;
    var exito = true;
    try {
      await context.read<SyncService>().sincronizar();
    } catch (_) {
      exito = false;
      // sin conexion real o backend no disponible: se reintenta despues, no rompe la UI
    }
    await _cargarLocal();
    _contarDisponibles();
    return exito;
  }

  Future<void> _contarDisponibles() async {
    if (!context.read<ConnectivityService>().online) return;
    final n = await OrdenesDisponiblesScreen.contar();
    if (mounted && n != null) setState(() => _disponibles = n);
  }

  Future<void> _abrirDisponibles() async {
    final tomo = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => const OrdenesDisponiblesScreen()),
    );
    await _cargarLocal();
    _contarDisponibles();
    if (tomo == true) _sincronizarSiHayConexion();
  }

  @override
  Widget build(BuildContext context) {
    final online = context.watch<ConnectivityService>().online;
    final syncService = context.watch<SyncService>();
    final sincronizando = syncService.sincronizando;
    final sesionExpirada = syncService.sesionExpirada;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Mis órdenes de trabajo'),
        actions: [
          IconButton(
            tooltip: 'Órdenes disponibles',
            icon: Badge(
              isLabelVisible: (_disponibles ?? 0) > 0,
              label: Text('${_disponibles ?? 0}'),
              child: const Icon(Icons.inbox_outlined),
            ),
            onPressed: _abrirDisponibles,
          ),
          IconButton(
            tooltip: 'Cerrar sesión',
            icon: const Icon(Icons.logout),
            onPressed: _confirmarCerrarSesion,
          ),
        ],
      ),
      drawer: Drawer(
        backgroundColor: GomaqColors.fondoOscuro,
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.all(20),
                child: Text('GOMAQ',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: GomaqColors.primario)),
              ),
              ListTile(
                leading: const Icon(Icons.assignment_outlined),
                title: const Text('Mis órdenes'),
                onTap: () => Navigator.pop(context),
              ),
              ListTile(
                leading: const Icon(Icons.inbox_outlined),
                title: Text((_disponibles ?? 0) > 0 ? 'Órdenes disponibles ($_disponibles)' : 'Órdenes disponibles'),
                onTap: () {
                  Navigator.pop(context);
                  _abrirDisponibles();
                },
              ),
              ListTile(
                leading: const Icon(Icons.precision_manufacturing_outlined),
                title: const Text('Flota'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(builder: (_) => const FlotaScreen()));
                },
              ),
              ListTile(
                leading: const Icon(Icons.person_outline),
                title: const Text('Mi cuenta'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(builder: (_) => const MiCuentaScreen()));
                },
              ),
              ListTile(
                leading: const Icon(Icons.local_shipping_outlined),
                title: const Text('Mi furgón'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.push(context, MaterialPageRoute(builder: (_) => const MiFurgonScreen()));
                },
              ),
            ],
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _crearOrden,
        icon: const Icon(Icons.add),
        label: const Text('Nueva OT'),
      ),
      body: Column(
        children: [
          if (sesionExpirada)
            SesionExpiradaBanner(onIniciarSesion: () => context.read<AuthService>().logout()),
          SyncBanner(
            online: online,
            sincronizando: sincronizando,
            pendientes: _pendientes,
            enError: _enError,
            problema: _problemaEnvio,
            onTapErrores: _mostrarErroresDeSync,
          ),
          Expanded(
            child: _ordenes.isEmpty
                ? const Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.assignment_outlined, size: 56, color: GomaqColors.textoSecundario),
                        SizedBox(height: 12),
                        Padding(
                          padding: EdgeInsets.symmetric(horizontal: 32),
                          child: Text(
                            'No tienes órdenes asignadas. Cuando el administrativo te asigne una, aparecerá aquí. También puedes crear una con el botón Nueva OT.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: GomaqColors.textoSecundario),
                          ),
                        ),
                      ],
                    ),
                  )
                : RefreshIndicator(
                    onRefresh: _sincronizarSiHayConexion,
                    child: ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _ordenes.length,
                      itemBuilder: (context, i) {
                        final orden = _ordenes[i];
                        return OrdenCard(
                          orden: orden,
                          onAbrir: () async {
                            await Navigator.push(
                              context,
                              MaterialPageRoute(builder: (_) => OrdenDetailScreen(ordenId: orden.id)),
                            );
                            _cargarLocal();
                          },
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
