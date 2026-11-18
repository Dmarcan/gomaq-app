import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/auth_service.dart';
import '../services/connectivity_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../utils/cambios.dart';
import '../widgets/dialogo_texto.dart';
import '../widgets/errores_sync.dart';
import '../widgets/lista_vacia_ordenes.dart';
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
  // La lista se refresca al volver a primer plano (si pasaron mas de _minimoEntreRefrescos) y cada
  // _intervaloRefresco mientras la app esta abierta: un cambio hecho en la oficina no llega solo.
  static const _minimoEntreRefrescos = Duration(seconds: 60);
  static const _intervaloRefresco = Duration(minutes: 3);

  List<OrdenTrabajo> _ordenes = [];
  int _pendientes = 0;
  int _enError = 0;
  int _enEspera = 0;
  String? _problemaEnvio;
  // OT cerradas en el telefono cuyo cierre sigue en la cola: no se pliegan con las finalizadas
  Set<int> _cierreSinEnviar = {};
  // ordenes sin mecanico que se pueden tomar; null = no se pudo consultar (sin senal)
  int? _disponibles;
  StreamSubscription<bool>? _conexionSub;
  Timer? _temporizador;
  // las finalizadas se pliegan: con el tiempo se acumulan y empujarian hacia abajo lo que se esta
  // trabajando
  bool _verFinalizadas = false;
  bool _syncEnCurso = false;
  late final SyncService _sync;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _cargarLocal();
    _sync = context.read<SyncService>();
    _sync.addListener(_alCambiarSync);

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

  /// La lista tambien se recarga con las sincronizaciones lanzadas desde otras pantallas: una orden
  /// tomada desde Disponibles (cuya sincronizacion corre aparte) no apareceria hasta tirar para
  /// actualizar.
  void _alCambiarSync() {
    if (!mounted) return;
    final termino = _syncEnCurso && !_sync.sincronizando;
    _syncEnCurso = _sync.sincronizando;
    if (termino) {
      _cargarLocal();
    } else {
      // para mostrar o quitar el aviso de carga inicial
      setState(() {});
    }
  }

  @override
  void dispose() {
    _sync.removeListener(_alCambiarSync);
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
    final enEspera = enError > 0 ? await syncService.contarDetrasDeErrores() : 0;
    final problema = await syncService.ultimoProblemaPendiente();
    final cierreSinEnviar = await syncService.ordenesConCierreSinEnviar();
    if (!mounted) return;
    setState(() {
      _ordenes = rows.map(OrdenTrabajo.fromLocalMap).toList();
      _pendientes = pendientes;
      _enError = enError;
      _enEspera = enEspera;
      _problemaEnvio = problema;
      _cierreSinEnviar = cierreSinEnviar;
    });
  }

  /// "Actualizar" tocado a mano (franja o lista vacia). Sin senal lo dice, en vez de no hacer nada.
  Future<void> _actualizarAMano() async {
    if (!context.read<ConnectivityService>().online) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Sin conexión. Se actualizará cuando vuelva la señal.'),
      ));
      return;
    }
    await _sincronizarSiHayConexion();
  }

  /// Pide confirmar antes de cerrar sesion (esta a un toque, junto al titulo). Con cambios sin
  /// enviar se explica que no se pierden, pero que solo esta cuenta puede enviarlos.
  Future<void> _confirmarCerrarSesion() async {
    final auth = context.read<AuthService>();
    final pendientes = await context.read<SyncService>().contarPendientes();
    if (!mounted) return;
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('¿Cerrar sesión?'),
        content: Text(pendientes > 0
            ? 'Tienes ${textoCambios(pendientes)} sin enviar. Quedan guardados en el teléfono y se enviarán '
                'cuando vuelvas a entrar con tu cuenta. Mientras tanto, nadie más podrá usar la app '
                'en este teléfono.'
            : 'Tu trabajo está sincronizado.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Cerrar sesión')),
        ],
      ),
    );
    if (confirmado == true) await auth.cerrarSesion();
  }

  /// Orden nueva de cualquier equipo de la flota, sin esperar a que la oficina la cree. Nace con
  /// un id local y la cola la crea en el servidor al haber senal (igual que "intervine otro equipo").
  Future<void> _crearOrden() async {
    final equipo = await elegirEquipo(context);
    if (equipo == null || !mounted) return;
    final motivo = await pedirTexto(
      context,
      titulo: 'Nueva orden para ${equipo['codigo']}',
      etiqueta: 'Motivo o qué se encontró',
      confirmar: 'Crear orden',
    );
    if (motivo == null || !mounted) return;
    final sync = context.read<SyncService>();
    final ordenId = await sync.encolarOtEnTerreno(
      maquinariaId: equipo['id'] as int,
      maquinariaCodigo: equipo['codigo'] as String,
      motivo: motivo.trim().isEmpty ? null : motivo.trim(),
    );
    await _cargarLocal();
    if (!mounted) return;
    _sincronizarSiHayConexion();
    await Navigator.push(context, MaterialPageRoute(builder: (_) => OrdenDetailScreen(ordenId: ordenId)));
    _cargarLocal();
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

  /// Lo que se esta trabajando primero (en terreno o en reparacion), despues el viaje, y al final lo
  /// que aun no se acepta. Dentro de cada grupo se respeta el orden de la lista (mas nuevas primero).
  static int _prioridad(String estado) => switch (estado) {
        'en_terreno' || 'en_reparacion' => 0,
        'en_camino' => 1,
        'aceptada' => 2,
        _ => 3,
      };

  List<Widget> _tarjetas() {
    Widget tarjeta(OrdenTrabajo orden) => OrdenCard(
          orden: orden,
          cierreSinEnviar: orden.estado == 'finalizada' && _cierreSinEnviar.contains(orden.id),
          onAbrir: () async {
            await Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => OrdenDetailScreen(ordenId: orden.id)),
            );
            _cargarLocal();
          },
        );

    final abiertas = _ordenes.where((o) => o.estado != 'finalizada').toList();
    // cerradas en el telefono pero con el cierre aun en la cola: quedan a la vista, no plegadas
    // entre las finalizadas, porque para la oficina siguen abiertas
    final sinEnviar = _ordenes.where((o) => o.estado == 'finalizada' && _cierreSinEnviar.contains(o.id)).toList();
    final finalizadas =
        _ordenes.where((o) => o.estado == 'finalizada' && !_cierreSinEnviar.contains(o.id)).toList();
    final conPosicion = abiertas.asMap().entries.toList()
      ..sort((a, b) {
        final c = _prioridad(a.value.estado).compareTo(_prioridad(b.value.estado));
        return c != 0 ? c : a.key.compareTo(b.key);
      });

    return [
      for (final e in conPosicion) tarjeta(e.value),
      for (final o in sinEnviar) tarjeta(o),
      if (finalizadas.isNotEmpty) ...[
        InkWell(
          onTap: () => setState(() => _verFinalizadas = !_verFinalizadas),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 4),
            child: Row(
              children: [
                Icon(_verFinalizadas ? Icons.expand_less : Icons.expand_more, color: GomaqColors.textoSecundario),
                const SizedBox(width: 8),
                Text(
                  'Finalizadas (${finalizadas.length})',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario),
                ),
              ],
            ),
          ),
        ),
        if (_verFinalizadas) for (final o in finalizadas) tarjeta(o),
      ],
    ];
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
              const Spacer(),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.logout),
                title: const Text('Cerrar sesión'),
                onTap: () {
                  Navigator.pop(context);
                  _confirmarCerrarSesion();
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
            enEspera: _enEspera,
            problema: _problemaEnvio,
            onTapErrores: () => mostrarErroresDeSync(context, alCambiar: _cargarLocal),
            onActualizar: _actualizarAMano,
          ),
          Expanded(
            child: _ordenes.isEmpty && _sync.sincronizando && _sync.ultimaSincronizacion == null
                ? const Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        CircularProgressIndicator(),
                        SizedBox(height: 12),
                        Text('Cargando tus órdenes…', style: TextStyle(color: GomaqColors.textoSecundario)),
                      ],
                    ),
                  )
                : _ordenes.isEmpty
                ? ListaVaciaOrdenes(onActualizar: _actualizarAMano)
                : RefreshIndicator(
                    onRefresh: _sincronizarSiHayConexion,
                    child: ListView(
                      padding: const EdgeInsets.all(16),
                      children: _tarjetas(),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
