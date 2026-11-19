import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config/reglas_negocio.dart';
import '../db/local_database.dart';
import '../models/orden_trabajo.dart';
import '../services/connectivity_service.dart';
import '../services/posicion_service.dart';
import '../services/sync_service.dart';
import '../theme/gomaq_theme.dart';
import '../widgets/estado_chip.dart';
import '../widgets/foto_del_cliente.dart';
import '../widgets/foto_thumbnail.dart';
import '../utils/accion_unica.dart';
import '../utils/datos_finales.dart';
import '../utils/formato.dart';
import '../utils/navegacion.dart';
import '../widgets/dialogo_horometro.dart';
import '../widgets/dialogo_texto.dart';
import '../widgets/errores_sync.dart';
import '../widgets/seccion_bloqueada.dart';
import '../widgets/selector_equipo.dart';
import '../widgets/sync_banner.dart' show SyncBanner;
import 'cerrar_orden_screen.dart';
import 'maquinaria_historial_screen.dart';

class OrdenDetailScreen extends StatefulWidget {
  final int ordenId;
  const OrdenDetailScreen({super.key, required this.ordenId});

  @override
  State<OrdenDetailScreen> createState() => _OrdenDetailScreenState();
}

class _OrdenDetailScreenState extends State<OrdenDetailScreen> with WidgetsBindingObserver {
  // evita pedir la posicion y encolar el cambio dos veces si se toca "Salir" dos veces seguidas
  bool _saliendo = false;
  // si el teléfono deja enviar la posición mientras va en camino (se muestra en la tarjeta del viaje)
  EstadoUbicacion _estadoUbicacion = EstadoUbicacion.ok;

  /// Id con el que se opera la OT (el real si una creada en terreno ya se sincronizo).
  late final SyncService _sincronizador;
  int get _id => _sincronizador.resolverIdOrden(widget.ordenId);

  /// Guardado como `_sincronizador`: al salir con "atras" ya no se puede leer del `context`.
  late final ConnectivityService _conectividad;

  OrdenTrabajo? _orden;
  final _diagnosticoCtrl = TextEditingController();
  // ultimo texto de observaciones iniciales que vino de la base: sirve para no pisar lo que se esta escribiendo
  String _diagnosticoGuardado = '';
  final _observacionFinalCtrl = TextEditingController();
  final _folioPapelCtrl = TextEditingController();
  final _cantidadInsumoCtrl = TextEditingController();
  final _descripcionInsumoCtrl = TextEditingController();
  final _precioInsumoCtrl = TextEditingController();
  List<Map<String, dynamic>> _fotosLocales = [];
  List<Map<String, dynamic>> _insumosLocales = [];
  List<Map<String, dynamic>> _catalogoInsumos = [];
  List<Map<String, dynamic>> _catalogoChecklist = [];
  List<Map<String, dynamic>> _tramosLocales = [];
  Set<int> _serviciosMarcados = {};
  int? _insumoSeleccionadoId;
  String? _tipoServicio;
  String _facturableLinea = 'pendiente';
  // true cuando el mecanico escribio el precio a mano: ya no se pisa con el costo del catalogo
  bool _precioEditado = false;
  // evita abrir dos tramos si se toca INICIAR dos veces seguidas
  bool _iniciando = false;
  // guardas contra el doble toque: mientras una accion se guarda, el boton queda deshabilitado
  late final AccionUnica _agregando = AccionUnica(alCambiar: _refrescar);
  late final AccionUnica _alternando = AccionUnica(alCambiar: _refrescar);
  late final AccionUnica _aceptando = AccionUnica(alCambiar: _refrescar);
  // sube cada vez que se limpia el repuesto elegido, para que el selector vuelva a "elige uno"
  int _versionSelectorInsumo = 0;
  // ultimo valor de la observacion final y del folio que vino de la base (o se encolo): permite
  // guardar lo escrito si el mecanico finaliza o sale sin pulsar "Guardar"
  String _observacionFinalGuardada = '';
  String _folioGuardado = '';
  // true si las fotos ANTES ya existian al abrir la pantalla; se decide una sola vez para que la
  // tarjeta no cambie de lugar justo despues de tomar la foto
  bool? _antesAlFinal;
  bool _habiaSincronizando = false;
  // cambios sin enviar de todo el telefono, para el icono de la barra superior
  int _pendientes = 0;
  int _enError = 0;

  /// Los seis tipos del talonario, en el mismo orden que el papel.
  static const _tiposServicio = [
    ('preventivo', 'Preventivo'),
    ('reparacion', 'Reparación'),
    ('garantia_full_mantencion', 'Garantía / Full Mantención'),
    ('correctivo', 'Correctivo'),
    ('bateria_cargador', 'Batería / Cargador'),
    ('administrativo', 'Administrativo'),
  ];

  static const _titulosGrupo = {
    'mecanicos': 'Servicios mecánicos',
    'electronicos': 'Servicios electrónicos',
    'hidraulicos': 'Servicios hidráulicos',
    'administrativos': 'Servicios administrativos',
    'complementos': 'Complementos máquinas',
  };

  @override
  void initState() {
    super.initState();
    _sincronizador = context.read<SyncService>();
    _conectividad = context.read<ConnectivityService>();
    WidgetsBinding.instance.addObserver(this);
    // la cantidad parte en 1: lo comun es poner una unidad
    _cantidadInsumoCtrl.text = '1';
    _sincronizador.addListener(_alCambiarSync);
    PosicionService.llegada.addListener(_alDetectarLlegada);
    _actualizarEstadoSync();
    _cargar();
  }

  /// El telefono detecto que llego al destino (con el destino de esta misma OT): se avisa una vez.
  /// No cambia el estado: la tarjeta de abajo deja confirmarlo con un toque.
  void _alDetectarLlegada() {
    if (!mounted || PosicionService.llegada.value != _id || _orden?.estado != 'en_camino') return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Parece que llegaste al destino. Confirma abajo para iniciar el trabajo.')),
    );
  }

  void _refrescar() {
    if (mounted) setState(() {});
  }

  void _alCambiarSync() {
    if (!mounted) return;
    _actualizarEstadoSync();
    // al terminar de enviar, los iconos de "Pendiente de envío" de repuestos y tramos se recalculan
    final sincronizando = _sincronizador.sincronizando;
    if (_habiaSincronizando && !sincronizando) _cargar();
    _habiaSincronizando = sincronizando;
  }

  Future<void> _actualizarEstadoSync() async {
    final pendientes = await _sincronizador.contarPendientes();
    final enError = await _sincronizador.contarEnError();
    if (!mounted) return;
    setState(() {
      _pendientes = pendientes;
      _enError = enError;
    });
  }

  /// Al volver a la app (por ejemplo desde Google Maps o Waze) se envia la posicion de inmediato:
  /// mientras la app esta en segundo plano Android no entrega ubicacion, asi que es el momento en que
  /// la hora de llegada se puede refrescar.
  @override
  void didChangeAppLifecycleState(AppLifecycleState estado) {
    if (estado == AppLifecycleState.resumed && _orden?.estado == 'en_camino') {
      PosicionService.enviar(_id);
      // quizá volvió de Ajustes con el permiso o el GPS ya activados: se reintenta el servicio
      _sincronizarEnvioPosicion();
    }
  }

  /// Mantiene el servicio de posicion solo mientras la OT esta en camino. El servicio sigue vivo al
  /// salir de esta pantalla o pasar a Maps o Waze: se apaga cuando la OT deja de estar en camino.
  /// Aqui la app esta a la vista, que es cuando Android deja arrancarlo.
  void _sincronizarEnvioPosicion() {
    if (_orden?.estado == 'en_camino') {
      PosicionService.iniciarSeguimiento(_id, destinoLat: _orden?.destinoLat, destinoLng: _orden?.destinoLng)
          .then((_) => _refrescarEstadoUbicacion());
    } else if (PosicionService.ordenSeguida == _id) {
      PosicionService.detenerSeguimiento();
    }
  }

  /// Lee si el teléfono deja enviar la posición, para decírselo al mecánico en la tarjeta del viaje.
  Future<void> _refrescarEstadoUbicacion() async {
    final estado = await PosicionService.estadoUbicacion();
    if (mounted && estado != _estadoUbicacion) setState(() => _estadoUbicacion = estado);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    PosicionService.llegada.removeListener(_alDetectarLlegada);
    _sincronizador.removeListener(_alCambiarSync);
    _diagnosticoCtrl.dispose();
    _observacionFinalCtrl.dispose();
    _folioPapelCtrl.dispose();
    _cantidadInsumoCtrl.dispose();
    _descripcionInsumoCtrl.dispose();
    _precioInsumoCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    final db = await LocalDatabase.instance.database;
    final rows = await db.query('ordenes_locales', where: 'id = ?', whereArgs: [_id]);
    final fotos = await db.query('evidencias_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id]);
    final insumos = await db.query('insumos_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id]);
    final catalogo = await db.query('insumos_catalogo_local', orderBy: 'nombre ASC');
    final checklist = await db.query('checklist_catalogo_local', orderBy: 'orden ASC');
    final marcados = await db.query('ot_servicios_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id]);
    final tramos = await db.query('tramos_locales', where: 'orden_trabajo_id = ?', whereArgs: [_id], orderBy: 'inicio ASC');
    if (!mounted || rows.isEmpty) return;
    setState(() {
      _orden = OrdenTrabajo.fromLocalMap(rows.first);
      // recargar (al tocar un tipo de servicio, sacar una foto o agregar un repuesto) no debe borrar lo
      // que el mecanico esta escribiendo y aun no guardo
      final diagnosticoBase = _orden!.diagnostico ?? '';
      if (_diagnosticoCtrl.text == _diagnosticoGuardado) _diagnosticoCtrl.text = diagnosticoBase;
      _diagnosticoGuardado = diagnosticoBase;
      // la cabecera del talonario tambien vive en el telefono: al reabrir la orden se ve lo ya
      // llenado
      _tipoServicio = _orden!.tipoServicio;
      if (_observacionFinalCtrl.text.isEmpty) _observacionFinalCtrl.text = _orden!.observacionFinal ?? '';
      if (_folioPapelCtrl.text.isEmpty) _folioPapelCtrl.text = _orden!.folioPapel ?? '';
      _observacionFinalGuardada = _orden!.observacionFinal ?? '';
      _folioGuardado = _orden!.folioPapel ?? '';
      _fotosLocales = fotos;
      _habiaSincronizando = _sincronizador.sincronizando;
      // la posicion de la tarjeta "Fotos ANTES" se decide con la primera carga y ya no cambia
      _antesAlFinal ??= fotos.any((f) => (f['tipo'] ?? 'antes') == 'antes');
      _insumosLocales = insumos;
      _catalogoInsumos = catalogo;
      _catalogoChecklist = checklist;
      _serviciosMarcados = marcados.map((m) => m['servicio_id'] as int).toSet();
      _tramosLocales = tramos;
      _precargarPrecio();
    });
    _sincronizarEnvioPosicion();
  }

  /// Guarda la cabecera del talonario: tipo de servicio, observación final y folio del papel.
  Future<void> _guardarDatosOt({bool aviso = true}) async {
    await context.read<SyncService>().encolarDatosOt(
          _id,
          tipoServicio: _tipoServicio,
          observacionFinal: _observacionFinalCtrl.text.trim().isEmpty ? null : _observacionFinalCtrl.text.trim(),
          folioPapel: _folioPapelCtrl.text.trim().isEmpty ? null : _folioPapelCtrl.text.trim(),
        );
    await _cargar();
    _intentarSincronizarAhora();
    if (aviso) _avisarGuardado();
  }

  void _avisarGuardado() {
    if (!mounted) return;
    final online = context.read<ConnectivityService>().online;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(online
            ? 'Guardado, enviando al servidor'
            : 'Guardado en el teléfono, se enviará cuando haya señal'),
      ),
    );
  }

  /// Boton Guardar de las observaciones: guarda las iniciales y la cabecera con un solo aviso.
  Future<void> _guardarObservaciones() async {
    await _guardarDiagnostico(aviso: false);
    await _guardarDatosOt(aviso: false);
    _avisarGuardado();
  }

  Future<void> _alternarServicio(int servicioId) async {
    final nuevos = Set<int>.from(_serviciosMarcados);
    if (!nuevos.remove(servicioId)) nuevos.add(servicioId);
    setState(() => _serviciosMarcados = nuevos);
    await context.read<SyncService>().encolarChecklist(_id, nuevos.toList());
    _intentarSincronizarAhora();
  }

  /// Cierra el tramo abierto, o abre uno nuevo. En el papel son los bloques
  /// INICIO / TÉRMINO DEL TRABAJO, y hay más de uno porque el trabajo se puede retomar.
  Future<void> _alternarTramo() => _alternando.ejecutar(_alternarTramoSinGuarda);

  Future<void> _alternarTramoSinGuarda() async {
    final abierto = _tramosLocales.where((t) => t['termino'] == null).toList();
    final sync = context.read<SyncService>();
    final db = await LocalDatabase.instance.database;
    if (abierto.isEmpty) {
      await sync.encolarTramo(_id, inicio: DateTime.now());
    } else {
      final tramo = abierto.last;
      final inicio = DateTime.parse(tramo['inicio'] as String);
      await db.delete('tramos_locales', where: 'id = ?', whereArgs: [tramo['id']]);
      await sync.encolarTramo(_id, inicio: inicio, termino: DateTime.now());
    }
    await _cargar();
    _intentarSincronizarAhora();
  }

  Future<void> _intentarSincronizarAhora() async {
    if (!mounted) return; // se invoca tras awaits: la pantalla pudo cerrarse en el intertanto
    if (!context.read<ConnectivityService>().online) return;
    try {
      await context.read<SyncService>().sincronizar();
    } catch (_) {
      // queda encolado para reintentar despues
    }
  }

  /// Guarda las observaciones iniciales si cambiaron, sin aviso ni recarga. Se usa al salir del campo y
  /// de la pantalla; usa el sincronizador guardado porque al salir ya no hay `context`. Devuelve si
  /// encoló algo.
  Future<bool> _guardarObservacionesIniciales() async {
    final texto = _diagnosticoCtrl.text.trim();
    if (texto == _diagnosticoGuardado || _orden?.estado == 'finalizada') return false;
    _diagnosticoGuardado = texto;
    await _sincronizador.encolarDiagnostico(_id, diagnostico: texto);
    return true;
  }

  Future<void> _guardarDiagnostico({String? estado, bool aviso = true}) async {
    await context.read<SyncService>().encolarDiagnostico(
          _id,
          diagnostico: _diagnosticoCtrl.text.trim(),
          estado: estado,
        );
    await _cargar();
    _intentarSincronizarAhora();
    if (aviso) _avisarGuardado();
  }

  /// El mecanico acepta el trabajo: la oficina ve que lo recibio. No hace falta senal.
  Future<void> _aceptarTrabajo() => _aceptando.ejecutar(() async {
        await context.read<SyncService>().encolarDiagnostico(_id, estado: 'aceptada');
        await _cargar();
        _intentarSincronizarAhora();
      });

  /// Sale hacia el destino: desde aqui corre el tiempo de viaje, separado del de trabajo, y el
  /// cliente ve que el tecnico va en camino.
  Future<void> _salirAlDestino() async {
    if (_saliendo) return;
    _saliendo = true;
    try {
      final sync = context.read<SyncService>();
      // la posicion de salida viaja en la misma tarea del cambio de estado. Si no hay permiso, GPS o
      // senal en unos segundos se sale igual sin ella: pedirla nunca puede frenar el viaje. Es aqui
      // donde Android pregunta por el permiso de ubicacion, una sola vez.
      final posicion = await PosicionService.obtener(pedirPermiso: true);
      await sync.encolarDiagnostico(_id, estado: 'en_camino', posicion: posicion);
      await _cargar();
      _intentarSincronizarAhora();
    } finally {
      _saliendo = false;
    }
  }

  /// Abre la ruta en la app de mapas elegida. Un enlace https abre la app si esta instalada y si no,
  /// el navegador, asi que casi nunca falla; si falla se avisa en vez de quedar en silencio.
  Future<void> _comoLlegar(Uri? enlace) async {
    if (enlace == null) return;
    var abierto = false;
    try {
      abierto = await launchUrl(enlace, mode: LaunchMode.externalApplication);
    } catch (_) {
      abierto = false;
    }
    if (!abierto && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No se pudo abrir la app de mapas. Revisa que haya una instalada.')),
      );
    }
  }

  /// "Parece que llegaste": la detecta el telefono cerca del destino. Solo avisa; el mecanico confirma
  /// con LLEGUE o la descarta (no vuelve a aparecer para esta OT). El estado no cambia solo.
  Widget _tarjetaLlegada(OrdenTrabajo orden) {
    return ValueListenableBuilder<int?>(
      valueListenable: PosicionService.llegada,
      builder: (context, id, _) {
        if (id != _id || orden.estado != 'en_camino') return const SizedBox.shrink();
        return Semantics(
          liveRegion: true,
          child: Card(
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: const BorderSide(color: GomaqColors.estadoPositivo, width: 2),
            ),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: const [
                      Icon(Icons.flag_circle_outlined, size: 20, color: GomaqColors.estadoPositivo),
                      SizedBox(width: 6),
                      Expanded(child: Text('Parece que llegaste', style: TextStyle(fontWeight: FontWeight.bold))),
                    ],
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Estás cerca del destino. Si ya estás en el lugar, confirma tu llegada.',
                    style: TextStyle(color: GomaqColors.textoSecundario, fontSize: 13),
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    children: [
                      FilledButton.icon(
                        onPressed: _iniciarTrabajo,
                        icon: const Icon(Icons.play_circle_outline),
                        label: const Text('Llegué al lugar'),
                      ),
                      TextButton(
                        onPressed: () => PosicionService.llegada.value = null,
                        child: const Text('Todavía no'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  /// Tarjeta "Como llegar" con la ubicacion que el cliente marco al registrarse. Sin ella no se muestra
  /// un boton que no lleva a ninguna parte: se avisa que hay que pedir la direccion a la oficina.
  Widget _tarjetaComoLlegar(OrdenTrabajo orden) {
    final google = enlaceGoogleMaps(orden.destinoLat, orden.destinoLng);
    final waze = enlaceWaze(orden.destinoLat, orden.destinoLng);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: const [
                Icon(Icons.place_outlined, size: 18, color: GomaqColors.textoSecundario),
                SizedBox(width: 6),
                Text('Cómo llegar', style: TextStyle(fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 8),
            if (google == null)
              const Text(
                'El cliente no marcó su ubicación. Pide la dirección a la oficina.',
                style: TextStyle(color: GomaqColors.textoSecundario, fontSize: 13),
              )
            else
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.icon(
                    onPressed: () => _comoLlegar(google),
                    icon: const Icon(Icons.map_outlined, size: 18),
                    label: const Text('Google Maps'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _comoLlegar(waze),
                    icon: const Icon(Icons.navigation_outlined, size: 18),
                    label: const Text('Waze'),
                  ),
                ],
              ),
            const SizedBox(height: 12),
            _avisoUbicacion(orden),
          ],
        ),
      ),
    );
  }

  /// Dice con claridad que se comparte la ubicación, y desde cuándo y hasta cuándo, para que el
  /// mecánico no se entere por la notificación. Si el teléfono no deja enviarla, explica qué hacer
  /// en vez de fallar en silencio.
  Widget _avisoUbicacion(OrdenTrabajo orden) {
    const estiloNota = TextStyle(color: GomaqColors.textoSecundario, fontSize: 12);
    if (orden.estado != 'en_camino') {
      return const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, size: 16, color: GomaqColors.textoSecundario),
          SizedBox(width: 6),
          Expanded(
            child: Text(
              'Al salir, la app comparte tu ubicación con la oficina solo mientras vas en camino. '
              'El cliente ve únicamente la hora estimada de llegada.',
              style: estiloNota,
            ),
          ),
        ],
      );
    }
    final estado = _estadoUbicacion;
    if (estado == EstadoUbicacion.ok || estado == EstadoUbicacion.desconocido) {
      return const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.location_on, size: 16, color: GomaqColors.estadoPositivo),
          SizedBox(width: 6),
          Expanded(
            child: Text(
              'Compartiendo tu ubicación con la oficina mientras vas en camino. Se apaga sola cuando llegues.',
              style: estiloNota,
            ),
          ),
        ],
      );
    }
    final (mensaje, boton) = switch (estado) {
      EstadoUbicacion.servicioApagado => (
          'La ubicación del teléfono está apagada: la oficina no ve tu posición ni la hora de llegada.',
          'Activar ubicación',
        ),
      EstadoUbicacion.permisoDenegado => (
          'Sin permiso de ubicación: la oficina no ve tu posición ni la hora de llegada.',
          'Dar permiso',
        ),
      _ => (
          'El permiso de ubicación está bloqueado: la oficina no ve tu posición ni la hora de llegada.',
          'Abrir ajustes',
        ),
    };
    // liveRegion: TalkBack anuncia el aviso cuando aparece (por ejemplo al retirar el permiso) y no solo
    // si la persona llega a recorrer la pantalla hasta esa tarjeta
    return Semantics(
      container: true,
      liveRegion: true,
      child: Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: GomaqColors.estadoAdvertencia.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        // borde con contraste 3:1 sobre la tarjeta
        border: Border.all(color: GomaqColors.estadoAdvertencia.withValues(alpha: 0.8)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.location_off_outlined, size: 16, color: GomaqColors.estadoAdvertencia),
              const SizedBox(width: 6),
              Expanded(child: Text(mensaje, style: const TextStyle(fontSize: 13))),
            ],
          ),
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () async {
                if (estado == EstadoUbicacion.permisoDenegado) {
                  // se pide con el diálogo normal de Android; si sigue negado (tras dos negativas
                  // Android ya no pregunta) se abren los ajustes de la app
                  final accion = await PosicionService.pedirPermisoOAjustes();
                  if (accion == AccionTrasPermiso.iniciarSeguimiento) {
                    await PosicionService.iniciarSeguimiento(
                      _id,
                      destinoLat: _orden?.destinoLat,
                      destinoLng: _orden?.destinoLng,
                    );
                  }
                } else {
                  await PosicionService.abrirAjustes(estado);
                }
                await _refrescarEstadoUbicacion();
              },
              child: Text(boton),
            ),
          ),
        ],
      ),
      ),
    );
  }

  /// INICIAR TRABAJO se pulsa ya en el sitio: pasa la orden a en terreno y arranca el reloj de
  /// trabajo (el INICIO del talonario), sin pedirle al mecanico que abra el tramo a mano.
  Future<void> _iniciarTrabajo() async {
    if (_iniciando) return;
    _iniciando = true;
    try {
      final sync = context.read<SyncService>();
      await sync.encolarDiagnostico(_id, diagnostico: _diagnosticoCtrl.text.trim(), estado: 'en_terreno');
      // despues del cambio de estado: la cola corre en orden de creacion
      if (!_tramosLocales.any((t) => t['termino'] == null)) {
        await sync.encolarTramo(_id, inicio: DateTime.now());
      }
      await _cargar();
      _intentarSincronizarAhora();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Trabajo iniciado. El tiempo de trabajo ya está corriendo.')),
        );
      }
    } finally {
      _iniciando = false;
    }
  }

  /// Lectura de horometro en cualquier momento de la visita, no solo al cerrar. Va a la cola como
  /// una tarea mas (con su uuid), asi que funciona sin senal y un reintento no la duplica.
  Future<void> _registrarHorometro() async {
    final orden = _orden;
    if (orden == null) return;
    final valor = await pedirLecturaHorometro(
      context,
      codigo: orden.maquinariaCodigo ?? 'el equipo',
      maquinariaId: orden.maquinariaId,
    );
    if (valor == null || !mounted) return;
    await context.read<SyncService>().encolarHorometro(
          _id,
          maquinariaId: orden.maquinariaId,
          valor: valor,
        );
    _intentarSincronizarAhora();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Lectura de ${formatoHoras(valor)} h guardada')),
      );
    }
  }

  Future<void> _tomarFoto(String tipo) async {
    final syncService = context.read<SyncService>();
    final XFile? foto;
    try {
      // 1600 px de ancho sobra para ver el estado del equipo y evita fotos de varios MB que tardan
      // mucho en subir con mala señal
      foto = await ImagePicker().pickImage(source: ImageSource.camera, imageQuality: 80, maxWidth: 1600);
    } catch (_) {
      // permiso de camara negado o camara ocupada: se avisa en vez de no hacer nada
      _avisarFoto('No se pudo abrir la cámara. Revisa que la app tenga permiso para usarla.');
      return;
    }
    if (foto == null) return;

    try {
      final dir = await getApplicationDocumentsDirectory();
      final nombreArchivo = 'ot${_id}_${DateTime.now().millisecondsSinceEpoch}.jpg';
      final rutaLocal = '${dir.path}/$nombreArchivo';
      await File(foto.path).copy(rutaLocal);
      await syncService.encolarEvidencia(_id, rutaLocal, tipo: tipo);
    } catch (_) {
      _avisarFoto('No se pudo guardar la foto en el teléfono. Vuelve a tomarla.');
      return;
    }
    // desde aqui la foto ya esta en la cola: un fallo al refrescar la pantalla no debe hacer repetirla
    _intentarSincronizarAhora();
    await _cargar();
  }

  void _avisarFoto(String mensaje) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(mensaje)));
  }

  List<Map<String, dynamic>> _fotosDeTipo(String tipo) =>
      _fotosLocales.where((f) => (f['tipo'] ?? 'antes') == tipo).toList();

  /// Costo del repuesto elegido, en pesos enteros, o null si no tiene (o se escribe a mano).
  double? _costoDelElegido() {
    final id = _insumoSeleccionadoId;
    if (id == null) return null;
    final fila = _catalogoInsumos.where((i) => i['id'] == id);
    if (fila.isEmpty) return null;
    final costo = (fila.first['costo_unitario'] as num?)?.toDouble();
    return (costo == null || costo <= 0) ? null : costo.roundToDouble();
  }

  /// El precio de una linea parte del que ya tiene el repuesto (por ahora su costo); el mecanico
  /// puede cambiarlo. No pisa un precio que escribio a mano.
  void _precargarPrecio() {
    if (_precioEditado) return;
    final costo = _costoDelElegido();
    _precioInsumoCtrl.text = costo == null ? '' : costo.round().toString();
  }

  Future<void> _agregarInsumo() => _agregando.ejecutar(_agregarInsumoSinGuarda);

  Future<void> _agregarInsumoSinGuarda() async {
    final cantidad = double.tryParse(_cantidadInsumoCtrl.text.replaceAll(',', '.'));
    final descripcion = _descripcionInsumoCtrl.text.trim();
    final insumoId = _insumoSeleccionadoId;
    if (cantidad == null || cantidad <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Ingresa una cantidad válida')),
      );
      return;
    }
    // como en el papel: o se elige del catálogo, o se escribe el repuesto a mano
    if (insumoId == null && descripcion.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Elige un repuesto del catálogo o escribe su descripción')),
      );
      return;
    }
    final nombre = insumoId != null
        ? _catalogoInsumos.firstWhere((i) => i['id'] == insumoId)['nombre'] as String
        : descripcion;
    await context.read<SyncService>().encolarInsumo(
          _id,
          insumoId: insumoId,
          insumoNombre: nombre,
          cantidad: cantidad,
          descripcion: descripcion.isEmpty ? null : descripcion,
          // si no es facturable el precio no se muestra, pero se guarda el costo del catalogo: el
          // gasto por equipo cuenta todas las lineas, se cobren o no
          precioUnitario: _facturableLinea == 'no'
              ? _costoDelElegido()
              : double.tryParse(_precioInsumoCtrl.text.replaceAll('.', '').replaceAll(',', '.')),
          facturable: _facturableLinea,
        );
    _cantidadInsumoCtrl.text = '1';
    _descripcionInsumoCtrl.clear();
    _precioEditado = false;
    setState(() {
      _facturableLinea = 'pendiente';
      // sin repuesto elegido: un segundo toque no repite la linea
      _insumoSeleccionadoId = null;
      _versionSelectorInsumo++;
      _precargarPrecio();
    });
    await _cargar();
    _intentarSincronizarAhora();
  }

  /// Encola la cabecera del talonario (observacion final y folio) si hay algo escrito sin guardar.
  /// Es la misma tarea `datos_ot` del boton "Guardar". Lee los campos antes de cualquier espera,
  /// porque al salir de la pantalla los controladores se liberan enseguida. Devuelve si encoló algo.
  Future<bool> _guardarDatosPendientes() async {
    if (_orden?.estado == 'finalizada') return false;
    final obs = _observacionFinalCtrl.text.trim();
    final folio = _folioPapelCtrl.text.trim();
    final tipo = _tipoServicio;
    if (!hayDatosFinalesSinGuardar(
      observacionActual: obs,
      observacionGuardada: _observacionFinalGuardada,
      folioActual: folio,
      folioGuardado: _folioGuardado,
    )) {
      return false;
    }
    _observacionFinalGuardada = obs;
    _folioGuardado = folio;
    await _sincronizador.encolarDatosOt(
      _id,
      tipoServicio: tipo,
      observacionFinal: obs.isEmpty ? null : obs,
      folioPapel: folio.isEmpty ? null : folio,
    );
    return true;
  }

  /// Al salir con "atras" no se pierde nada de lo escrito: observaciones iniciales y finales. Lo
  /// encolado aqui se envia de inmediato: la lista de ordenes, al volver, recarga lo local pero no
  /// sincroniza, y el cambio quedaria "por enviar" hasta el refresco periodico de la lista (hasta 3
  /// minutos). La sincronizacion se pide despues de que las dos tareas quedaron en la cola, para
  /// que la pasada las incluya. No usa `_intentarSincronizarAhora` porque esa revisa `mounted` y
  /// lee del `context`, y aqui la pantalla ya se esta cerrando: usa las referencias guardadas.
  Future<void> _guardarAlSalir() async {
    final encolados = await Future.wait([_guardarObservacionesIniciales(), _guardarDatosPendientes()]);
    if (!encolados.contains(true) || !_conectividad.online) return;
    try {
      // si ya hay una pasada en curso, PasadasEnSerie agenda otra que incluye estas tareas
      await _sincronizador.sincronizar();
    } catch (_) {
      // queda encolado para reintentar despues
    }
  }

  Future<void> _finalizar() async {
    final ordenInicial = _orden;
    if (ordenInicial == null) return;
    // lo escrito en observacion final y folio sin pulsar "Guardar" se encola ANTES del cierre
    await _guardarDatosPendientes();
    if (!mounted) return;
    await _cargar();
    final OrdenTrabajo orden = _orden ?? ordenInicial;
    if (!mounted) return;
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CerrarOrdenScreen(
          orden: orden,
          fotosAntes: _fotosDeTipo('antes').length,
          fotosDespues: _fotosDeTipo('despues').length,
          insumos: _insumosLocales.where((l) => l['anulada'] != 1).length,
        ),
      ),
    );
    // CerrarOrdenScreen hace popUntil(first) al confirmar; si el mecanico volvio
    // con "atras" sin cerrar, refrescamos por si acaso
    if (mounted) await _cargar();
    _intentarSincronizarAhora();
  }

  /// `completa`: true = listo (verde), false = falta completarlo (amarillo), null = sin estado
  /// (seccion opcional o la orden ya esta cerrada). Ademas del color lleva texto e icono, para
  /// que no dependa solo del color.
  Widget _tituloSeccion(IconData icono, String texto, {bool? completa}) {
    return Row(
      children: [
        Icon(icono, size: 18, color: GomaqColors.primario),
        const SizedBox(width: 8),
        Expanded(child: Text(texto, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
        if (completa != null) ...[
          Icon(
            completa ? Icons.check_circle : Icons.pending_outlined,
            size: 16,
            color: completa ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia,
          ),
          const SizedBox(width: 4),
          Text(
            completa ? 'Listo' : 'Falta',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: completa ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia,
            ),
          ),
        ],
      ],
    );
  }

  /// Tarjeta de seccion que se tine segun este completa (verde) o falte (amarillo).
  Widget _tarjeta({required Widget child, bool? completa}) {
    if (completa == null) return Card(child: child);
    final color = completa ? GomaqColors.estadoPositivo : GomaqColors.estadoAdvertencia;
    return Card(
      color: color.withValues(alpha: 0.08),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: color.withValues(alpha: 0.6)),
      ),
      child: child,
    );
  }

  Widget _cabecera(OrdenTrabajo orden) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                EstadoChip(estado: orden.estado),
                Text(
                  etiquetaOt(orden.id),
                  style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 12),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Text(
                    orden.maquinariaCodigo ?? 'Sin código',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                  ),
                ),
                TextButton.icon(
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => MaquinariaHistorialScreen(
                        maquinariaId: orden.maquinariaId,
                        codigo: orden.maquinariaCodigo ?? '',
                      ),
                    ),
                  ),
                  icon: const Icon(Icons.history, size: 16),
                  label: const Text('Historial', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            if (orden.motivo != null && orden.motivo!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(orden.motivo!, style: const TextStyle(color: GomaqColors.textoSecundario, fontSize: 13)),
            ],
            FotoDelCliente(ordenId: orden.id),
            if (orden.clienteNombre != null) ...[
              const SizedBox(height: 8),
              Text.rich(
                TextSpan(
                  style: const TextStyle(fontSize: 13),
                  children: [
                    const TextSpan(text: 'Cliente: ', style: TextStyle(color: GomaqColors.textoSecundario)),
                    TextSpan(text: orden.clienteNombre!),
                  ],
                ),
              ),
            ],
            if (orden.estado != 'finalizada') ...[
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: _registrarHorometro,
                icon: const Icon(Icons.speed, size: 18),
                label: const Text('Agregar lectura de horómetro'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _seccionFotos({
    required String tipo,
    required String titulo,
    required bool puedeAgregar,
    String? ayuda,
  }) {
    final fotos = _fotosDeTipo(tipo);
    // mientras la orden esta abierta: las de ANTES son recomendadas, las de DESPUES obligatorias
    final completa = puedeAgregar
        ? (tipo == 'despues' ? fotos.length >= ReglasNegocio.minFotosDespues : fotos.isNotEmpty)
        : null;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.photo_camera_outlined, titulo, completa: completa),
            if (ayuda != null) ...[
              const SizedBox(height: 4),
              Text(ayuda, style: const TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
            ],
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final foto in fotos)
                  FotoThumbnail(
                    rutaLocal: foto['ruta_local'] as String,
                    sincronizada: foto['sincronizado'] != 0,
                    creadoEn: foto['creado_en'] as String?,
                  ),
                if (puedeAgregar)
                  InkWell(
                    onTap: () => _tomarFoto(tipo),
                    borderRadius: BorderRadius.circular(10),
                    child: Container(
                      width: 92,
                      height: 92,
                      decoration: BoxDecoration(
                        border: Border.all(color: GomaqColors.primario.withValues(alpha: 0.6)),
                        borderRadius: BorderRadius.circular(10),
                        color: GomaqColors.primario.withValues(alpha: 0.08),
                      ),
                      child: const Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.add_a_photo_outlined, color: GomaqColors.primario),
                          SizedBox(height: 4),
                          Text('Agregar', style: TextStyle(fontSize: 12, color: GomaqColors.textoNaranja)),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Observaciones INICIALES del talonario: que se encontro al llegar. Va arriba, antes de intervenir.
  Widget _seccionObservacionesIniciales({required bool soloLectura}) {
    final completa = soloLectura ? null : (_orden?.diagnostico ?? '').trim().isNotEmpty;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.build_outlined, 'Observaciones iniciales', completa: completa),
            const SizedBox(height: 4),
            const Text('Qué se encontró al llegar',
                style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 8),
            Focus(
              // al salir del campo se guarda solo, sin necesidad de pulsar Guardar
              onFocusChange: (tieneFoco) {
                if (!tieneFoco && !soloLectura) _guardarObservacionesIniciales();
              },
              child: TextField(
                controller: _diagnosticoCtrl,
                maxLines: 3,
                readOnly: soloLectura,
                decoration: const InputDecoration(hintText: 'Ej: cliente solicita llave de contacto por pérdida'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Observaciones FINALES del talonario: que se hizo, ademas del folio del papel y los botones de
  /// guardar. Va junto a las fotos DESPUES, que es lo ultimo que se documenta antes de cerrar.
  /// Tras "Llegué al lugar" la orden queda en terreno; este es el paso siguiente. Antes estaba al final de la
  /// pantalla, bajo Observaciones finales, y no se veía.
  Widget _tarjetaPasarAReparacion() {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Ya estás en el lugar', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 6),
            const Text(
              'Cuando empieces a reparar, pasa la orden a reparación para que el cliente lo vea.',
              style: TextStyle(color: GomaqColors.textoSecundario, fontSize: 13),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: () => _guardarDiagnostico(estado: 'en_reparacion'),
                icon: const Icon(Icons.handyman_outlined),
                label: const Text('Pasar a reparación'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _seccionObservacionesFinales({required bool soloLectura}) {
    return _tarjeta(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.fact_check_outlined, 'Observaciones finales'),
            const SizedBox(height: 4),
            const Text('Qué se hizo', style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 8),
            TextField(
              controller: _observacionFinalCtrl,
              maxLines: 3,
              readOnly: soloLectura,
              decoration: const InputDecoration(hintText: 'Ej: se reemplaza llave de contacto'),
              onEditingComplete: soloLectura ? null : _guardarDatosOt,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _folioPapelCtrl,
              readOnly: soloLectura,
              decoration: const InputDecoration(
                isDense: true,
                labelText: 'N° de OT en papel (opcional)',
                hintText: '00904',
              ),
              onEditingComplete: soloLectura ? null : _guardarDatosOt,
            ),
            if (!soloLectura) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _guardarObservaciones,
                      icon: const Icon(Icons.save_outlined, size: 18),
                      label: const Text('Guardar'),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _seccionInsumos({required bool soloLectura}) {
    // opcional: sin repuestos la orden no se cobra, y eso es valido. Solo se marca cuando ya hay.
    final hayRepuestos = _insumosLocales.any((l) => l['anulada'] != 1);
    final bool? completa = soloLectura ? null : (hayRepuestos ? true : null);
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.inventory_2_outlined, 'Repuestos utilizados', completa: completa),
            const SizedBox(height: 4),
            if (!soloLectura) ...[
              const Text(
                'Elige del catálogo o escribe el repuesto a mano, e indica si se le cobra al cliente',
                style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
              ),
              const SizedBox(height: 8),
              if (_catalogoInsumos.isNotEmpty)
                DropdownButtonFormField<int?>(
                  key: ValueKey('insumo_$_versionSelectorInsumo'),
                  initialValue: _insumoSeleccionadoId,
                  isExpanded: true,
                  decoration: const InputDecoration(isDense: true, labelText: 'Repuesto del catálogo'),
                  items: [
                    const DropdownMenuItem<int?>(value: null, child: Text('— elige uno o escribe a mano —')),
                    for (final insumo in _catalogoInsumos)
                      DropdownMenuItem<int?>(
                        value: insumo['id'] as int,
                        child: Text(
                          '${insumo['nombre']} (${insumo['unidad_medida']})',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: (v) => setState(() {
                    _insumoSeleccionadoId = v;
                    _precioEditado = false;
                    _precargarPrecio();
                  }),
                ),
              TextField(
                controller: _descripcionInsumoCtrl,
                decoration: const InputDecoration(isDense: true, labelText: 'Descripción / observación'),
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  SizedBox(
                    width: 80,
                    child: TextField(
                      controller: _cantidadInsumoCtrl,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(isDense: true, labelText: 'Cant.'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    // sin cobro no hace falta pedir un precio
                    child: _facturableLinea == 'no'
                        ? const Text(
                            'No se cobra al cliente',
                            style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
                          )
                        : TextField(
                            controller: _precioInsumoCtrl,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(isDense: true, labelText: 'Precio unitario', prefixText: r'$ '),
                            onChanged: (_) => _precioEditado = true,
                          ),
                  ),
                  const SizedBox(width: 4),
                  IconButton(
                    tooltip: 'Agregar repuesto',
                    onPressed: _agregando.enCurso ? null : _agregarInsumo,
                    icon: const Icon(Icons.add_circle, color: GomaqColors.primario, size: 30),
                  ),
                ],
              ),
              // las tres casillas del papel: SI / NO / ?
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 6,
                children: [
                  const Text('Facturable:', style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario)),
                  for (final (valor, etiqueta) in [('si', 'Sí'), ('no', 'No'), ('pendiente', 'Por decidir')])
                    ChoiceChip(
                      label: Text(etiqueta, style: const TextStyle(fontSize: 12)),
                      selected: _facturableLinea == valor,
                      onSelected: (_) => setState(() => _facturableLinea = valor),
                    ),
                ],
              ),
              const SizedBox(height: 8),
            ],
            if (!soloLectura)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: _intervenirOtroEquipo,
                  icon: const Icon(Icons.add_box_outlined, size: 18),
                  label: const Text('El repuesto va a otro equipo', style: TextStyle(fontSize: 12)),
                ),
              ),
            if (_insumosLocales.isEmpty)
              const Text('Sin repuestos registrados', style: TextStyle(color: GomaqColors.textoSecundario)),
            for (final insumo in _insumosLocales)
              _lineaRepuesto(insumo, soloLectura: soloLectura),
          ],
        ),
      ),
    );
  }

  /// Una linea de repuesto. Mientras la OT esta abierta el mecanico puede anularla (queda
  /// tachada, como en el talonario); anulada, se sigue viendo para que quede constancia.
  Widget _lineaRepuesto(Map<String, dynamic> insumo, {required bool soloLectura}) {
    final anulada = insumo['anulada'] == 1;
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(Icons.build_circle_outlined,
          color: anulada ? GomaqColors.textoSecundario : null),
      title: Text(
        '${insumo['insumo_nombre']} · ${_cantidadLimpia(insumo['cantidad'])}',
        style: anulada
            ? const TextStyle(decoration: TextDecoration.lineThrough, color: GomaqColors.textoSecundario)
            : null,
      ),
      subtitle: Text(
        anulada ? 'Anulada' : _resumenLinea(insumo),
        style: const TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          insumo['sincronizado'] == 0
              ? const Icon(Icons.cloud_upload, size: 16, color: GomaqColors.estadoAdvertencia, semanticLabel: 'Pendiente de envío')
              : const Icon(Icons.cloud_done, size: 16, color: GomaqColors.estadoPositivo, semanticLabel: 'Enviado'),
          if (!soloLectura && !anulada)
            IconButton(
              tooltip: 'Anular línea',
              icon: const Icon(Icons.remove_circle_outline, color: GomaqColors.estadoNegativo),
              onPressed: () => _anularLinea(insumo),
            ),
        ],
      ),
    );
  }

  Future<void> _anularLinea(Map<String, dynamic> insumo) async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('¿Anular esta línea?'),
        content: Text(
          '${insumo['insumo_nombre']} · ${insumo['cantidad']}\n\n'
          'La línea queda tachada y el repuesto vuelve a tu furgón. No se puede deshacer: '
          'si te equivocaste, vuelve a agregar la línea correcta.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Anular línea')),
        ],
      ),
    );
    if (confirmado != true || !mounted) return;
    final error = await context.read<SyncService>().anularInsumo(insumo);
    if (!mounted) return;
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    await _cargar();
    _intentarSincronizarAhora();
  }

  static const _etiquetaFacturable = {'si': 'Se cobra', 'no': 'No se cobra', 'pendiente': 'Por decidir'};

  /// 2.0 -> 2 (las cantidades enteras no llevan decimal).
  static String _cantidadLimpia(dynamic v) {
    if (v is num && v == v.roundToDouble()) return v.round().toString();
    return '$v';
  }

  String _resumenLinea(Map<String, dynamic> linea) {
    final partes = <String>[_etiquetaFacturable[linea['facturable']] ?? 'Por decidir'];
    if (linea['precio_unitario'] != null) partes.add(Formato.clp(linea['precio_unitario'] as num));
    if (linea['descripcion'] != null && (linea['descripcion'] as String).isNotEmpty) {
      partes.add(linea['descripcion'] as String);
    }
    return partes.join(' · ');
  }

  /// Abre una OT para otro equipo intervenido durante esta misma visita: si el tecnico atiende una
  /// segunda maquina, su gasto tiene que quedar contra ESA maquina y no contra la de la orden en
  /// curso, o el costo por equipo queda mal atribuido.
  Future<void> _intervenirOtroEquipo() async {
    final equipo = await elegirEquipo(context, excluirId: _orden?.maquinariaId);
    if (equipo == null || !mounted) return;

    final motivo = await pedirTexto(
      context,
      titulo: 'Intervine ${equipo['codigo']}',
      etiqueta: 'Qué se encontró',
      ayuda: 'Se abre una orden aparte para ese equipo, para que sus repuestos queden a su nombre.',
      confirmar: 'Crear orden',
    );
    if (motivo == null || !mounted) return;

    await context.read<SyncService>().encolarOtEnTerreno(
          maquinariaId: equipo['id'] as int,
          maquinariaCodigo: equipo['codigo'] as String,
          motivo: motivo.trim().isEmpty ? null : motivo.trim(),
        );
    _intentarSincronizarAhora();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Orden creada. Aparece en tu lista de OT.')),
      );
    }
  }

  Widget _seccionTipoServicio({required bool soloLectura}) {
    final completa = soloLectura ? null : _tipoServicio != null;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.assignment_outlined, 'Tipo de servicio', completa: completa),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final (valor, etiqueta) in _tiposServicio)
                  ChoiceChip(
                    label: Text(etiqueta, style: const TextStyle(fontSize: 12)),
                    selected: _tipoServicio == valor,
                    onSelected: soloLectura
                        ? null
                        : (_) {
                            setState(() => _tipoServicio = valor);
                            _guardarDatosOt();
                          },
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Checklist del talonario: marca DÓNDE SE INTERVINO, no una pauta de revisión.
  Widget _seccionChecklist({required bool soloLectura}) {
    if (_catalogoChecklist.isEmpty) {
      return const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text(
            'Sin señal para cargar el checklist de servicios todavía',
            style: TextStyle(color: GomaqColors.textoSecundario),
          ),
        ),
      );
    }
    final grupos = <String, List<Map<String, dynamic>>>{};
    for (final item in _catalogoChecklist) {
      grupos.putIfAbsent(item['grupo'] as String, () => []).add(item);
    }
    final completa = soloLectura ? null : _serviciosMarcados.isNotEmpty;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.checklist_outlined, 'Sistemas intervenidos', completa: completa),
            const Text(
              'Marca dónde se intervino en esta visita',
              style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
            ),
            // Los 31 items se agrupan en cinco grupos plegados: en terreno, con guantes y sol,
            // tenerlos todos desplegados es un scroll enorme para marcar una o dos casillas. Cada
            // grupo se abre solo si ya tiene algo marcado.
            for (final entrada in grupos.entries)
              Builder(builder: (context) {
                final marcadosDelGrupo =
                    entrada.value.where((i) => _serviciosMarcados.contains(i['id'])).length;
                return Theme(
                  data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                  child: ExpansionTile(
                    initiallyExpanded: marcadosDelGrupo > 0,
                    tilePadding: EdgeInsets.zero,
                    childrenPadding: const EdgeInsets.only(left: 8),
                    title: Text(
                      _titulosGrupo[entrada.key] ?? entrada.key,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold),
                    ),
                    subtitle: Text(
                      marcadosDelGrupo == 0
                          ? '${entrada.value.length} sistemas'
                          : '$marcadosDelGrupo marcado${marcadosDelGrupo == 1 ? '' : 's'}',
                      style: TextStyle(
                        fontSize: 12,
                        color: marcadosDelGrupo > 0 ? GomaqColors.primario : GomaqColors.textoSecundario,
                      ),
                    ),
                    children: [
                      for (final item in entrada.value)
                        CheckboxListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          controlAffinity: ListTileControlAffinity.leading,
                          activeColor: GomaqColors.primario,
                          title: Text(item['nombre'] as String, style: const TextStyle(fontSize: 14)),
                          value: _serviciosMarcados.contains(item['id']),
                          onChanged: soloLectura ? null : (_) => _alternarServicio(item['id'] as int),
                        ),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  /// INICIO / TÉRMINO DEL TRABAJO. El papel trae dos bloques porque el trabajo se puede
  /// retomar en otra visita; aquí se pueden registrar los que hagan falta.
  Widget _seccionTramos({required bool soloLectura}) {
    final abierto = _tramosLocales.where((t) => t['termino'] == null).toList();
    final completa = soloLectura ? null : _tramosLocales.isNotEmpty;
    return _tarjeta(
      completa: completa,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _tituloSeccion(Icons.schedule_outlined, 'Tiempos de trabajo', completa: completa),
            const SizedBox(height: 8),
            if (_tramosLocales.isEmpty)
              const Text('Sin tramos registrados', style: TextStyle(color: GomaqColors.textoSecundario)),
            for (final tramo in _tramosLocales)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  tramo['termino'] == null ? Icons.play_circle_outline : Icons.check_circle_outline,
                  color: tramo['termino'] == null ? GomaqColors.estadoAdvertencia : GomaqColors.estadoPositivo,
                ),
                title: Text(_rangoTramo(tramo), style: const TextStyle(fontSize: 14)),
                trailing: tramo['sincronizado'] == 0
                    ? const Icon(Icons.cloud_upload, size: 16, color: GomaqColors.estadoAdvertencia, semanticLabel: 'Pendiente de envío')
                    : const Icon(Icons.cloud_done, size: 16, color: GomaqColors.estadoPositivo, semanticLabel: 'Enviado'),
              ),
            if (!soloLectura) ...[
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _alternando.enCurso ? null : _alternarTramo,
                  icon: Icon(abierto.isEmpty ? Icons.play_arrow : Icons.stop, size: 18),
                  label: Text(abierto.isEmpty ? 'INICIAR TIEMPO DE TRABAJO' : 'DETENER TIEMPO DE TRABAJO'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _rangoTramo(Map<String, dynamic> tramo) {
    String hhmm(DateTime f) => '${f.day}/${f.month} ${f.hour.toString().padLeft(2, '0')}:${f.minute.toString().padLeft(2, '0')}';
    final inicio = DateTime.parse(tramo['inicio'] as String).toLocal();
    final termino = tramo['termino'] == null ? null : DateTime.parse(tramo['termino'] as String).toLocal();
    if (termino == null) return '${hhmm(inicio)} — en curso';
    final minutos = termino.difference(inicio).inMinutes;
    return '${hhmm(inicio)} a ${hhmm(termino)}  ·  ${minutos ~/ 60}h ${minutos % 60}m';
  }

  Future<bool> _confirmar({required String titulo, required String mensaje, required String textoOk}) async {
    final r = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(titulo),
        content: Text(mensaje),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: Text(textoOk)),
        ],
      ),
    );
    return r == true;
  }

  Widget? _botonInferior(OrdenTrabajo orden) {
    final String texto;
    final IconData icono;
    VoidCallback? accion;
    String? notaFaltante;
    VoidCallback? accionNota;

    // alternativa para quien ya esta en el lugar y no pasa por los pasos del viaje
    VoidCallback? accionSecundaria;

    switch (orden.estado) {
      case 'asignada':
      case 'pendiente':
        texto = 'ACEPTAR TRABAJO';
        icono = Icons.check_circle_outline;
        accion = _aceptando.enCurso ? null : _aceptarTrabajo;
        accionSecundaria = _iniciarTrabajo;
        break;
      case 'aceptada':
        texto = 'SALIR HACIA EL DESTINO';
        icono = Icons.directions_car_outlined;
        accion = _salirAlDestino;
        accionSecundaria = _iniciarTrabajo;
        break;
      case 'en_camino':
        texto = 'LLEGUÉ AL LUGAR';
        icono = Icons.play_circle_outline;
        accion = _iniciarTrabajo;
        break;
      case 'en_terreno':
      case 'en_reparacion':
        texto = 'FINALIZAR TRABAJO';
        icono = Icons.check_circle_outline;
        final faltan = ReglasNegocio.minFotosDespues - _fotosDeTipo('despues').length;
        if (faltan > 0) {
          accion = null;
          notaFaltante = faltan == 1
              ? 'Falta 1 foto del trabajo terminado (DESPUÉS) para poder cerrar. Toca aquí para tomarla'
              : 'Faltan $faltan fotos del trabajo terminado (DESPUÉS) para poder cerrar. Toca aquí para tomar una';
          accionNota = () => _tomarFoto('despues');
        } else {
          accion = _finalizar;
        }
        break;
      default:
        return null; // finalizada u otro estado terminal: sin accion
    }

    return SafeArea(
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
        decoration: const BoxDecoration(
          color: GomaqColors.fondoOscuro,
          border: Border(top: BorderSide(color: GomaqColors.bordeSutil)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (notaFaltante != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InkWell(
                  onTap: accionNota,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Text(
                      notaFaltante,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 12,
                        color: accionNota == null ? GomaqColors.estadoAdvertencia : GomaqColors.textoNaranja,
                        decoration: accionNota == null ? null : TextDecoration.underline,
                      ),
                    ),
                  ),
                ),
              ),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: accion,
                icon: Icon(icono),
                label: Text(texto),
              ),
            ),
            if (accionSecundaria != null)
              TextButton(
                onPressed: () async {
                  // salta aceptar y salir: el trabajo parte ahora y no se puede deshacer
                  final seguir = await _confirmar(
                    titulo: '¿Ya estás en el lugar?',
                    mensaje: 'El trabajo parte ahora y el tiempo de trabajo empieza a correr.',
                    textoOk: 'Sí, iniciar',
                  );
                  if (seguir) accionSecundaria!();
                },
                child: const Text('Ya estoy en el lugar: iniciar trabajo'),
              ),
          ],
        ),
      ),
    );
  }

  /// Estado de sincronizacion siempre a la vista, tambien dentro de una orden: asi se sabe si lo
  /// que se acaba de guardar ya salio del telefono.
  Widget _indicadorSync() {
    final enviando = _sincronizador.sincronizando;
    final IconData icono;
    final Color color;
    final String texto;
    if (enviando) {
      icono = Icons.sync;
      color = GomaqColors.estadoPositivo;
      texto = SyncBanner.textoSincronizando(pendientes: _pendientes, enError: _enError);
    } else if (_enError > 0) {
      icono = Icons.sync_problem;
      color = GomaqColors.estadoNegativo;
      texto = _enError == 1 ? '1 cambio no se pudo enviar' : '$_enError cambios no se pudieron enviar';
    } else if (_pendientes > 0) {
      icono = Icons.cloud_upload;
      color = GomaqColors.estadoAdvertencia;
      texto = _pendientes == 1 ? '1 cambio por enviar' : '$_pendientes cambios por enviar';
    } else {
      icono = Icons.cloud_done;
      color = GomaqColors.estadoPositivo;
      texto = 'Todo enviado';
    }
    return IconButton(
      tooltip: texto,
      icon: Icon(icono, color: color),
      onPressed: () {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(texto),
          // con cambios en error, el aviso lleva al cuadro para reintentar o descartar
          action: _enError > 0
              ? SnackBarAction(label: 'Ver', onPressed: () => mostrarErroresDeSync(context, alCambiar: _cargar))
              : null,
        ));
        if (_pendientes > 0 || _enError > 0) _intentarSincronizarAhora();
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final orden = _orden;
    if (orden == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    // antes de iniciar el trabajo: asignada, aceptada o en camino
    final asignada = const ['pendiente', 'asignada', 'aceptada', 'en_camino'].contains(orden.estado);
    final enProgreso = orden.estado == 'en_terreno' || orden.estado == 'en_reparacion';
    final finalizada = orden.estado == 'finalizada';

    return PopScope(
      // salir con "atras" no debe perder lo escrito en observaciones iniciales
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) _guardarAlSalir();
      },
      child: Scaffold(
      appBar: AppBar(title: Text(etiquetaOt(orden.id)), actions: [_indicadorSync()]),
      bottomNavigationBar: _botonInferior(orden),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _cabecera(orden),

          // en el lugar pero sin empezar a reparar: el paso que sigue va arriba, a la vista
          if (orden.estado == 'en_terreno') _tarjetaPasarAReparacion(),

          // ya aceptado el trabajo y hasta llegar: la ruta al cliente
          if (orden.estado == 'en_camino') _tarjetaLlegada(orden),
          if (orden.estado == 'aceptada' || orden.estado == 'en_camino') _tarjetaComoLlegar(orden),

          // Flujo guiado: antes de iniciar solo se documenta el estado inicial;
          // diagnostico e insumos se desbloquean al pasar a en_terreno.
          if (asignada) ...[
            _seccionFotos(
              tipo: 'antes',
              titulo: 'Paso 1: Fotos ANTES',
              puedeAgregar: true,
              ayuda: 'Documenta el estado inicial de la máquina antes de intervenirla',
            ),
            const SeccionBloqueada(titulo: 'Tipo de servicio', icono: Icons.assignment_outlined),
            const SeccionBloqueada(titulo: 'Observaciones', icono: Icons.build_outlined),
            const SeccionBloqueada(titulo: 'Repuestos utilizados', icono: Icons.inventory_2_outlined),
          ] else if (enProgreso) ...[
            // en el orden en que se hace el trabajo: documentar el estado inicial, intervenir, y
            // dejar al final lo que se necesita para cerrar. El talonario en papel y el PDF
            // conservan su orden; esto es solo la pantalla.
            if (_antesAlFinal != true) _seccionFotos(tipo: 'antes', titulo: 'Fotos ANTES', puedeAgregar: true),
            _seccionObservacionesIniciales(soloLectura: false),
            _seccionTipoServicio(soloLectura: false),
            _seccionChecklist(soloLectura: false),
            _seccionInsumos(soloLectura: false),
            _seccionObservacionesFinales(soloLectura: false),
            _seccionFotos(
              tipo: 'despues',
              titulo: 'Fotos DESPUÉS',
              puedeAgregar: true,
              ayuda: 'Se requiere al menos ${ReglasNegocio.minFotosDespues} foto del trabajo terminado para cerrar',
            ),
            _seccionTramos(soloLectura: false),
            // las ANTES ya tomadas se pliegan al final: no hace falta verlas mientras se trabaja
            if (_antesAlFinal == true) _seccionFotos(tipo: 'antes', titulo: 'Fotos ANTES', puedeAgregar: true),
          ] else if (finalizada) ...[
            _seccionObservacionesIniciales(soloLectura: true),
            _seccionTipoServicio(soloLectura: true),
            _seccionChecklist(soloLectura: true),
            _seccionInsumos(soloLectura: true),
            _seccionObservacionesFinales(soloLectura: true),
            _seccionFotos(tipo: 'antes', titulo: 'Fotos ANTES', puedeAgregar: false),
            _seccionFotos(tipo: 'despues', titulo: 'Fotos DESPUÉS', puedeAgregar: false),
            _seccionTramos(soloLectura: true),
          ] else ...[
            // estado no contemplado: mostrar todo editable para no bloquear al mecanico
            _seccionObservacionesIniciales(soloLectura: false),
            _seccionTipoServicio(soloLectura: false),
            _seccionChecklist(soloLectura: false),
            _seccionInsumos(soloLectura: false),
            _seccionObservacionesFinales(soloLectura: false),
            _seccionFotos(tipo: 'antes', titulo: 'Fotos ANTES', puedeAgregar: true),
            _seccionFotos(tipo: 'despues', titulo: 'Fotos DESPUÉS', puedeAgregar: true),
            _seccionTramos(soloLectura: false),
          ],
        ],
      ),
    ));
  }
}
