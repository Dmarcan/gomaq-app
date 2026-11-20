import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/efecto_guia.dart';
import '../../utils/enlaces.dart';
import '../../utils/formato.dart';
import '../../utils/motivo_cambio.dart' show nuevoUuid;
import '../../utils/selector_pdf.dart';
import '../../widgets/confirmar_horometro.dart';
import '../../widgets/estado_vacio.dart';
import '../../widgets/selector_dia_arriendo.dart';
import '../../widgets/zona_arrastre_pdf.dart';

/// Mismo tope que aplica el backend (middleware/upload.js).

class GuiasScreen extends StatefulWidget {
  const GuiasScreen({super.key});

  @override
  State<GuiasScreen> createState() => _GuiasScreenState();
}

class _GuiasScreenState extends State<GuiasScreen> {
  List<dynamic> _maquinarias = [];
  List<dynamic> _clientes = [];
  List<dynamic> _recientes = [];
  Map<String, dynamic>? _seleccionada;
  int? _clienteId;
  String _tipo = 'despacho';

  /// Llave del envío: se conserva mientras se reintenta el mismo guardado (si la respuesta se pierde,
  /// el servidor no crea otra guía) y se renueva al guardar bien o al cambiar de equipo o de tipo.
  String _llaveEnvio = nuevoUuid();
  PlatformFile? _archivo;
  bool _subiendo = false;
  bool _cargando = true;
  bool _detectando = false;
  bool _huboDeteccion = false;
  bool _horaDetectada = false;
  // código del equipo que dice el PDF cuando no está entre los que se pueden elegir
  String? _equipoFueraDeLista;
  final _horometroCtrl = TextEditingController();
  // hora de corte del cobro (configuración del servidor); null si no se pudo leer: entonces no se muestra la frase
  int? _horaCorte;
  DateTime _fecha = DateTime.now();
  TimeOfDay _hora = TimeOfDay.now();
  bool _fallido = false;
  // el equipo salio antes de tener la guia en PDF: se registra igual y el PDF se adjunta despues
  bool _sinDocumento = false;
  List<dynamic> _faltaDocumento = [];
  // por defecto se muestran los equipos que corresponden al tipo; con esto, todos
  bool _verTodos = false;
  // se cambia al guardar para que el selector de equipo se arme de nuevo (sin la selección anterior)
  int _claveEquipo = 0;
  // el último envío no tuvo respuesta (plazo agotado o sin red): puede que sí se haya registrado
  bool _respuestaPerdida = false;
  String? _errorCarga;
  String? _errorRecientes;
  final _equipoCtrl = TextEditingController();
  final _clienteCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _equipoCtrl.addListener(_alEscribirEquipo);
    _clienteCtrl.addListener(_alEscribirCliente);
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargarDatos());
  }

  // si el texto del buscador deja de coincidir con lo elegido, la selección ya no vale
  void _alEscribirEquipo() {
    final elegida = _seleccionada;
    if (elegida != null && _equipoCtrl.text != _etiquetaEquipo(elegida)) {
      setState(() {
        _seleccionada = null;
        _cambioDeDatos();
      });
    }
  }

  void _alEscribirCliente() {
    if (_clienteId != null && _clienteCtrl.text != (_nombreCliente ?? '')) {
      setState(() {
        _clienteId = null;
        _cambioDeDatos();
      });
    }
  }

  /// Con el envío anterior resuelto, cualquier cambio de datos es otra guía y lleva llave nueva. Si una
  /// respuesta se perdió se conserva la llave: volver a guardar no duplica la guía.
  void _cambioDeDatos() {
    if (!_respuestaPerdida) _llaveEnvio = nuevoUuid();
  }

  @override
  void dispose() {
    _horometroCtrl.dispose();
    _equipoCtrl.dispose();
    _clienteCtrl.dispose();
    super.dispose();
  }

  /// Equipos que se pueden elegir (ver [equiposParaGuia]): un despacho no admite uno fuera de servicio,
  /// pero la recepción sí (un averiado se recibe de vuelta y se despacha otro en su lugar).
  List<Map<String, dynamic>> get _maquinariasDisponibles => equiposParaGuia(_maquinarias, tipo: _tipo, verTodos: _verTodos);

  String _etiquetaEquipo(Map<String, dynamic> m) =>
      '${m['codigo']} - ${m['tipo']}${m['cliente'] != null ? ' (${m['cliente']})' : ''}';

  String? get _nombreCliente {
    if (_clienteId == null) return null;
    for (final c in _clientes) {
      if (c['id'] == _clienteId) return '${c['nombre']}';
    }
    return null;
  }

  /// Cambia despacho/recepción. Debe llamarse dentro de setState: si el equipo elegido ya no está en
  /// la lista del tipo nuevo se limpia, o el desplegable fallaría por tener un valor que no existe.
  void _fijarTipo(String tipo) {
    if (tipo != _tipo) _cambioDeDatos();
    _tipo = tipo;
    final elegida = _seleccionada;
    if (elegida != null && !_maquinariasDisponibles.any((m) => m['id'] == elegida['id'])) {
      _seleccionada = null;
      _equipoCtrl.clear();
    }
  }

  /// Últimas guías subidas, para confirmar que quedó bien la que se acaba de guardar.
  Future<void> _cargarRecientes() async {
    try {
      final data = await ApiClient.instance.get('/api/maquinarias/guias/recientes');
      final faltan = await ApiClient.instance.get('/api/maquinarias/guias/recientes?sin_documento=1');
      if (mounted) {
        setState(() {
          _recientes = data;
          _faltaDocumento = faltan;
          _errorRecientes = null;
        });
      }
    } catch (e) {
      // la lista es de apoyo: si falla, el formulario sigue sirviendo, pero se dice y se puede reintentar
      if (mounted) setState(() => _errorRecientes = mensajeErrorCarga(e));
    }
  }

  /// Solo informativa: si falla, la pantalla no muestra la frase del día que se cobra.
  Future<void> _cargarHoraCorte() async {
    try {
      final config = await ApiClient.instance.get('/api/facturacion/configuracion');
      final hora = config is Map ? config['hora_corte_despacho'] : null;
      if (mounted && hora is num) setState(() => _horaCorte = hora.toInt());
    } catch (_) {
      // el servidor sigue decidiendo el día de cobro
    }
  }

  Future<void> _cargarMaquinarias() async {
    final maquinarias = (await ApiClient.instance.get('/api/maquinarias'))['items'];
    if (mounted) setState(() => _maquinarias = maquinarias);
  }

  Future<void> _cargarDatos() async {
    setState(() {
      _cargando = true;
      _errorCarga = null;
    });
    // el Gerente no registra guías: solo ve cuáles faltan de documento (lo que cuenta el dashboard)
    if (!context.read<AuthService>().esAdministrativo) {
      await _cargarRecientes();
      if (mounted) setState(() => _cargando = false);
      return;
    }
    _cargarRecientes();
    try {
      await _cargarMaquinarias();
      final clientes = await ApiClient.instance.get('/api/clientes');
      if (mounted) setState(() => _clientes = clientes);
      _cargarHoraCorte();
    } catch (e) {
      if (mounted) setState(() => _errorCarga = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _elegirArchivo() async {
    final archivo = await elegirPdf();
    if (archivo == null) return;
    await _recibirArchivo(archivo);
  }

  /// Camino comun del clic (selector) y del arrastre: valida el tamano y arma la guia.
  Future<void> _recibirArchivo(PlatformFile archivo) async {
    if (archivo.bytes == null) return;
    // el backend rechaza sobre 10 MB; avisar aca evita subir el archivo entero para nada
    if (archivo.bytes!.length > maxBytesPdf) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('El PDF supera los 10 MB')),
      );
      return;
    }
    setState(() {
      _cambioDeDatos();
      _archivo = archivo;
      _huboDeteccion = false;
      _horaDetectada = false;
      _equipoFueraDeLista = null;
      _hora = TimeOfDay.now();
      _horometroCtrl.clear();
    });
    await _detectarDatos();
  }

  Future<void> _detectarDatos() async {
    if (_archivo == null) return;
    setState(() => _detectando = true);
    try {
      final resultado = await ApiClient.instance.postMultipart(
        '/api/maquinarias/guias/detectar',
        bytes: _archivo!.bytes,
        filename: _archivo!.name,
      );
      if (!mounted) return;
      setState(() {
        _huboDeteccion = true;
        _cambioDeDatos();
        if (resultado['tipo_detectado'] != null) _fijarTipo(resultado['tipo_detectado']);
        if (resultado['fecha_hora_detectada'] != null) {
          final detectada = DateTime.parse(resultado['fecha_hora_detectada']).toLocal();
          _fecha = detectada;
          // la hora solo se toma si venia de verdad en el PDF. Las guias del SII no la
          // traen, y el backend completa con 00:00 para armar el instante: darla por buena
          // haria que HORA_CORTE cobre el dia del despacho sin que nadie lo haya decidido.
          _horaDetectada = resultado['hora_detectada'] == true;
          // sin hora en el PDF se propone la del momento en que se carga la guia (no la de
          // cuando se abrio la pantalla); queda a la vista y editable
          _hora = _horaDetectada ? TimeOfDay(hour: detectada.hour, minute: detectada.minute) : TimeOfDay.now();
        }
        // las guias de entrega traen impreso "HOROMETRO: 1156"; queda como una lectura
        // mas del equipo, editable por si viene mal leido
        if (resultado['horometro_detectado'] != null) {
          _horometroCtrl.text = resultado['horometro_detectado'].toString();
        }
        // solo asignar el cliente detectado si existe en la lista ya cargada del dropdown
        // (si se creo despues de abrir la pantalla, un value sin item crashea el Dropdown)
        if (resultado['cliente_detectado'] != null) {
          final idDetectado = resultado['cliente_detectado']['id'];
          if (_clientes.any((c) => c['id'] == idDetectado)) {
            _clienteId = idDetectado;
            _clienteCtrl.text = _nombreCliente ?? '';
          }
        }
        // el equipo sale del "N° INTERNO" impreso en la guía. Solo se elige si está en la lista
        // del tipo de guía (un despacho no toma uno ya arrendado); si no, se avisa cuál era
        _equipoFueraDeLista = null;
        final equipoDetectado = resultado['equipo_detectado'];
        if (equipoDetectado != null) {
          Map<String, dynamic>? enLista;
          for (final m in _maquinariasDisponibles) {
            if (m['id'] == equipoDetectado['id']) enLista = m;
          }
          if (enLista != null) {
            _seleccionada = enLista;
            _equipoCtrl.text = _etiquetaEquipo(enLista);
            _claveEquipo++;
          } else if (_seleccionada == null) {
            _equipoFueraDeLista = '${equipoDetectado['codigo']}';
          }
        }
      });
    } on ApiException catch (_) {
      // deteccion best-effort: si falla, el usuario sigue llenando a mano sin interrupcion
    } finally {
      if (mounted) setState(() => _detectando = false);
    }
  }

  Future<void> _elegirFecha() async {
    final elegida = await showDatePicker(
      context: context,
      initialDate: _fecha.isAfter(DateTime.now()) ? DateTime.now() : _fecha,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
    );
    if (elegida != null) {
      setState(() {
        _cambioDeDatos();
        _fecha = elegida;
      });
    }
  }

  Future<void> _elegirHora() async {
    final elegida = await showTimePicker(context: context, initialTime: _hora);
    if (elegida != null) {
      setState(() {
        _cambioDeDatos();
        _hora = elegida;
      });
    }
  }

  Future<void> _adjuntarDocumento(Map<String, dynamic> guia) async {
    final archivo = await elegirPdf();
    if (archivo == null) return;
    if (archivo.bytes!.length > maxBytesPdf) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('El PDF supera los 10 MB')));
      return;
    }
    try {
      await ApiClient.instance.postMultipart(
        '/api/maquinarias/guias/${guia['id']}/archivo',
        bytes: archivo.bytes!,
        filename: archivo.name,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Documento adjuntado')));
        _cargarRecientes();
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo adjuntar el documento: ${e.message}')));
    }
  }

  Future<void> _guardar() async {
    if (_seleccionada == null || (_archivo == null && !_sinDocumento)) return;
    if (_tipo == 'despacho' && !_fallido && _clienteId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Selecciona el cliente al que se despacha el equipo')),
      );
      return;
    }
    final fechaHora = DateTime(_fecha.year, _fecha.month, _fecha.day, _hora.hour, _hora.minute);
    if (fechaHora.isAfter(DateTime.now().add(const Duration(minutes: 5)))) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('La fecha y la hora no pueden ser futuras.')),
      );
      return;
    }
    final textoHorometro = _horometroCtrl.text.trim();
    final horometro = horometroParaEnvio(textoHorometro);
    if (textoHorometro.isNotEmpty && horometro == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('El horómetro no es un número válido. Escribe, por ejemplo, 1156 o 1156,5.')),
      );
      return;
    }
    if (horometro != null &&
        !await confirmarHorometroMenor(context, maquinariaId: _seleccionada!['id'] as int, valor: num.tryParse(horometro))) {
      return;
    }
    if (!mounted) return;
    setState(() => _subiendo = true);
    try {
      final respuesta = await ApiClient.instance.postMultipart(
        '/api/maquinarias/${_seleccionada!['id']}/guias',
        bytes: _archivo?.bytes,
        filename: _archivo?.name,
        fields: {
          if (_archivo == null && _sinDocumento) 'sin_documento': 'true',
          'tipo': _tipo,
          'uuid_cliente': _llaveEnvio,
          'fecha_hora': fechaIsoUtc(fechaHora),
          'fallido': _fallido.toString(),
          if (_tipo == 'despacho' && _clienteId != null) 'cliente_id': _clienteId.toString(),
          'horometro': ?horometro,
        },
      );
      if (mounted) {
        // si el servidor ya tenía esta guía (se perdió la respuesta del primer intento), se dice
        final yaEstaba = respuesta is Map && respuesta['ya_registrada'] == true;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(yaEstaba
              ? 'Esta guía ya estaba registrada. Revisa la lista de recientes y las que faltan documento.'
              : 'Guía guardada'),
        ));
        _cargarRecientes();
        // la lista de equipos ya no es la misma (el despacho le puso cliente al equipo, la recepción se lo quitó):
        // se vuelve a pedir y se limpia la selección, o se podría despachar dos veces con la lista vieja
        try {
          await _cargarMaquinarias();
        } catch (_) {
          // si falla, el equipo queda con el cliente anterior en memoria; se quita igual de la selección
        }
        if (mounted) {
          setState(() {
            _respuestaPerdida = false;
            _llaveEnvio = nuevoUuid();
            _archivo = null;
            _sinDocumento = false;
            _fallido = false;
            _huboDeteccion = false;
            _clienteId = null;
            _clienteCtrl.clear();
            _seleccionada = null;
            _equipoCtrl.clear();
            _claveEquipo++;
            _horometroCtrl.clear();
          });
        }
      }
    } on ApiException catch (e) {
      if (mounted) {
        if (e.statusCode == 409 && _respuestaPerdida) {
          // el intento anterior sí llegó, con otros datos: la llave vieja ya no sirve
          setState(() {
            _respuestaPerdida = false;
            _llaveEnvio = nuevoUuid();
          });
          _cargarRecientes();
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Ya se registró una guía con los datos anteriores; revisa Recientes antes de volver a guardar.'),
          ));
        } else {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo guardar la guía: ${e.message}')));
        }
      }
    } catch (_) {
      // sin respuesta (tiempo agotado o sin red): ClienteApi deja pasar estas excepciones sin envolver.
      // La llave del envío se conserva, así que volver a guardar no duplica la guía.
      if (mounted) {
        setState(() => _respuestaPerdida = true);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No hubo respuesta del servidor. Vuelve a guardar; la guía no se duplicará.')),
        );
      }
    } finally {
      if (mounted) setState(() => _subiendo = false);
    }
  }

  /// Las guías ya registradas a las que les falta el PDF. El administrativo puede adjuntarlo; el Gerente
  /// solo la ve (es la lista a la que lleva el número del dashboard).
  List<Widget> _seccionFaltaDocumento({required bool puedeAdjuntar}) {
    if (_errorRecientes != null && _faltaDocumento.isEmpty && !puedeAdjuntar) {
      return [
        Text('No se pudo cargar la lista. $_errorRecientes', style: const TextStyle(fontSize: 13)),
        TextButton(onPressed: _cargarRecientes, child: const Text('Reintentar')),
      ];
    }
    if (_faltaDocumento.isEmpty) return const [];
    return [
      Text('FALTA EL DOCUMENTO (${_faltaDocumento.length})',
          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.estadoAdvertencia)),
      const SizedBox(height: 4),
      Text(
        puedeAdjuntar
            ? 'Estas guías ya asignaron o liberaron el equipo, pero no tienen el PDF.'
            : 'Estas guías ya asignaron o liberaron el equipo, pero no tienen el PDF. Lo adjunta Administrativo.',
        style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
      ),
      const SizedBox(height: 8),
      for (final g in _faltaDocumento)
        ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          leading: Icon(g['tipo'] == 'despacho' ? Icons.north_east : Icons.south_west, color: GomaqColors.estadoAdvertencia),
          title: Text('${g['tipo'] == 'despacho' ? 'Despacho' : 'Recepción'} · ${g['maquinaria_codigo']}'),
          subtitle: Text(
            '${g['cliente_nombre'] ?? 'Sin cliente'} · ${Formato.fechaHora(g['fecha'])}'
            '${g['registrada_por_nombre'] != null ? ' · registró ${g['registrada_por_nombre']}' : ''}',
          ),
          trailing: puedeAdjuntar
              ? TextButton.icon(
                  onPressed: () => _adjuntarDocumento(Map<String, dynamic>.from(g as Map)),
                  icon: const Icon(Icons.attach_file, size: 18),
                  label: const Text('Adjuntar PDF'),
                )
              : null,
        ),
      const SizedBox(height: 24),
    ];
  }

  @override
  Widget build(BuildContext context) {
    if (_cargando) return const Center(child: CircularProgressIndicator());
    if (_errorCarga != null && _maquinarias.isEmpty && context.read<AuthService>().esAdministrativo) {
      return EstadoError(titulo: 'No se pudo cargar Guías', mensaje: _errorCarga!, onReintentar: _cargarDatos);
    }

    // el registro de guias es exclusivo de Administrativo (backend igual);
    // al Gerente se le explica en vez de mostrarle un formulario que le fallara
    if (!context.watch<AuthService>().esAdministrativo) {
      return SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ..._seccionFaltaDocumento(puedeAdjuntar: false),
              const Icon(Icons.description_outlined, size: 40, color: Colors.grey),
              const SizedBox(height: 12),
              const Text('El registro de guías lo realiza Administrativo', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              const Text(
                'Los días de arriendo calculados a partir de las guías se ven en Facturación y en el perfil de cada equipo.',
                style: TextStyle(color: Colors.black54),
              ),
            ],
          ),
        ),
      );
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ..._seccionFaltaDocumento(puedeAdjuntar: true),
            const Text('El sistema calcula automáticamente los días de arriendo al cruzar ambos documentos',
                style: TextStyle(color: Colors.black54)),
            const SizedBox(height: 20),
            if (_huboDeteccion)
              const Padding(
                padding: EdgeInsets.only(bottom: 8),
                child: Text(
                  'Revisa lo que se detectó y corrige si algo está mal antes de guardar',
                  style: TextStyle(fontSize: 12, color: Colors.black54, fontStyle: FontStyle.italic),
                ),
              ),
            const Text('TIPO DE DOCUMENTO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(child: _botonTipo('despacho', 'Guía de Despacho')),
                const SizedBox(width: 12),
                Expanded(child: _botonTipo('recepcion', 'Guía de Recepción')),
              ],
            ),
            const SizedBox(height: 20),
            const Text('EQUIPO ASOCIADO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(
              _tipo == 'despacho'
                  ? 'Se muestran los equipos disponibles para arrendar.'
                  : 'Se muestran los equipos que están con un cliente.',
              style: const TextStyle(fontSize: 12, color: Colors.black54),
            ),
            const SizedBox(height: 8),
            LayoutBuilder(
              builder: (context, caja) => DropdownMenu<int>(
                // con otra clave se rearma al cambiar despacho/recepción o la lista (los equipos cambian)
                key: ValueKey('equipo-$_tipo-$_verTodos-$_claveEquipo'),
                controller: _equipoCtrl,
                width: caja.maxWidth,
                hintText: 'Busca o selecciona el equipo',
                enableFilter: true,
                requestFocusOnTap: true,
                menuHeight: 280,
                initialSelection: _seleccionada?['id'] as int?,
                dropdownMenuEntries: [
                  for (final m in _maquinariasDisponibles) DropdownMenuEntry(value: m['id'] as int, label: _etiquetaEquipo(m)),
                ],
                onSelected: (id) => setState(() {
                  Map<String, dynamic>? elegida;
                  for (final m in _maquinariasDisponibles) {
                    if (m['id'] == id) elegida = m;
                  }
                  if (elegida?['id'] != _seleccionada?['id']) _cambioDeDatos();
                  _seleccionada = elegida;
                }),
              ),
            ),
            if (_equipoFueraDeLista != null && _seleccionada == null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    'El PDF menciona el equipo $_equipoFueraDeLista, pero no está en esta lista. '
                    'Revisa su estado o activa "Ver todos los equipos".',
                    style: const TextStyle(fontSize: 12, color: Color(0xFFB25000)),
                  ),
                ),
              ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: const Text('Ver todos los equipos'),
              subtitle: const Text('Incluye los que no corresponden a este tipo de guía'),
              value: _verTodos,
              onChanged: (v) => setState(() {
                _verTodos = v;
                _fijarTipo(_tipo);
              }),
            ),
            if (_tipo == 'despacho') ...[
              const SizedBox(height: 12),
              const Text('CLIENTE', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              const Text(
                'El equipo quedará marcado como arrendado a este cliente',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
              const SizedBox(height: 8),
              LayoutBuilder(
                builder: (context, caja) => DropdownMenu<int>(
                  controller: _clienteCtrl,
                  width: caja.maxWidth,
                  hintText: 'Busca o selecciona el cliente',
                  enableFilter: true,
                  requestFocusOnTap: true,
                  menuHeight: 280,
                  initialSelection: _clienteId,
                  dropdownMenuEntries: [
                    for (final c in _clientes) DropdownMenuEntry(value: c['id'] as int, label: '${c['nombre']}'),
                  ],
                  onSelected: (v) => setState(() {
                    _cambioDeDatos();
                    _clienteId = v;
                  }),
                ),
              ),
            ],
            const SizedBox(height: 20),
            const Text('DOCUMENTO PDF', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            ZonaArrastrePdf(
              onArchivo: _recibirArchivo,
              builder: (context, arrastrando) => InkWell(
                onTap: _elegirArchivo,
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(32),
                  decoration: BoxDecoration(
                    color: arrastrando ? Colors.blue.shade50 : null,
                    border: Border.all(
                      color: arrastrando ? Colors.blue.shade800 : Colors.grey.shade400,
                      width: arrastrando ? 3 : 1,
                    ),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    children: [
                      const Icon(Icons.upload_file, size: 32, color: Colors.grey),
                      const SizedBox(height: 8),
                      Text(
                        arrastrando
                            ? 'Suelta el PDF aquí'
                            : (_archivo?.name ?? 'Haz clic o arrastra aquí el PDF de la guía'),
                        textAlign: TextAlign.center,
                        style: arrastrando ? const TextStyle(fontWeight: FontWeight.bold) : null,
                      ),
                      if (_archivo == null) Text('Solo PDF · hasta 10 MB', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                    ],
                  ),
                ),
              ),
            ),
            // el equipo a veces sale antes de tener la guia escaneada
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text('Todavía no tengo el PDF: registrar sin documento'),
              subtitle: const Text('La guía queda registrada (el equipo se asigna o se libera igual) y el PDF se adjunta después'),
              value: _sinDocumento && _archivo == null,
              onChanged: _archivo != null
                  ? null
                  : (v) => setState(() {
                        _cambioDeDatos();
                        _sinDocumento = v ?? false;
                      }),
            ),
            if (_detectando) ...[
              const SizedBox(height: 12),
              const Row(
                children: [
                  SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text('Leyendo el PDF para detectar fecha, hora y tipo...', style: TextStyle(fontSize: 12, color: Colors.black54)),
                  ),
                ],
              ),
            ],
            if ((_archivo != null || _sinDocumento) && !_detectando) ...[
              const SizedBox(height: 20),
              SelectorDiaArriendo(
                tipo: _tipo,
                fecha: _fecha,
                hora: _hora,
                horaTexto: _hora.format(context),
                onElegirFecha: _elegirFecha,
                onElegirHora: _elegirHora,
                horaCorte: _horaCorte,
                fallido: _fallido,
                avisoHora: (_huboDeteccion && !_horaDetectada)
                    ? 'La hora no venía en el PDF: se usó la hora en que cargaste la guía. Cámbiala si fue otra, porque define si se cobra este día.'
                    : null,
              ),
              const SizedBox(height: 20),
              const Text('HORÓMETRO DEL EQUIPO', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              const Text(
                'Opcional. Las guías de entrega lo traen impreso; queda registrado como lectura del equipo.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _horometroCtrl,
                keyboardType: TextInputType.number,
                onChanged: (_) => setState(_cambioDeDatos),
                decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'Horas, por ejemplo 1156 o 1156,5'),
              ),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(_tipo == 'despacho' ? 'Marcar como despacho fallido' : 'Marcar como retiro fallido'),
                subtitle: const Text('El equipo no se usó o el retiro no se concretó: no se factura ni cuenta como día de arriendo'),
                value: _fallido,
                onChanged: (v) => setState(() {
                  _cambioDeDatos();
                  _fallido = v ?? false;
                }),
              ),
            ],
            // lo que va a pasar al guardar, para leerlo antes de confirmar
            if (_seleccionada != null && (_archivo != null || _sinDocumento)) ...[
              const SizedBox(height: 16),
              Semantics(
                liveRegion: true,
                child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.04),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.black12),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.info_outline, size: 18),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        describirEfectoGuia(
                          tipo: _tipo,
                          codigo: '${_seleccionada!['codigo']}',
                          fecha: DateTime(_fecha.year, _fecha.month, _fecha.day, _hora.hour, _hora.minute),
                          clienteNombre: _nombreCliente,
                          clienteActual: _seleccionada!['cliente'] as String?,
                          fallido: _fallido,
                          horometro: _horometroCtrl.text,
                          ahora: DateTime.now(),
                        ),
                        style: const TextStyle(fontSize: 13, height: 1.35),
                      ),
                    ),
                  ],
                ),
              ),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: (_seleccionada != null && (_archivo != null || _sinDocumento) && !_subiendo && !_detectando) ? _guardar : null,
              child: _subiendo
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Guardar guía'),
            ),
            // el botón deshabilitado no decía qué faltaba
            if (_seleccionada == null || (_archivo == null && !_sinDocumento))
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _seleccionada == null && _archivo == null && !_sinDocumento
                      ? 'Elige el equipo y el PDF de la guía (o marca que todavía no lo tienes) para poder guardar.'
                      : _seleccionada == null
                          ? 'Falta elegir el equipo.'
                          : 'Falta elegir el PDF de la guía.',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                ),
              ),
            const SizedBox(height: 32),
            const Text('GUÍAS RECIENTES', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            if (_errorRecientes != null)
              Row(
                children: [
                  Expanded(child: Text('No se pudieron cargar las guías: $_errorRecientes', style: TextStyle(color: Colors.red.shade800))),
                  TextButton(onPressed: _cargarRecientes, child: const Text('Reintentar')),
                ],
              )
            else if (_recientes.isEmpty)
              Text('Aún no se han subido guías.', style: TextStyle(color: Colors.grey.shade700))
            else
              for (final g in _recientes)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(g['tipo'] == 'despacho' ? Icons.north_east : Icons.south_west),
                  title: Text(
                    '${g['tipo'] == 'despacho' ? 'Despacho' : 'Recepción'} · ${g['maquinaria_codigo']}'
                    '${g['fallido'] == true ? ' · fallido' : ''}'
                    '${g['falta_documento'] == true ? ' · sin documento' : ''}',
                  ),
                  subtitle: Text('${g['cliente_nombre'] ?? 'Sin cliente'} · ${Formato.fechaHora(g['fecha'])}'),
                  trailing: g['url'] == null
                      ? null
                      : TextButton.icon(
                          onPressed: () => abrirEnlace(g['url']),
                          icon: const Icon(Icons.picture_as_pdf, size: 18),
                          label: const Text('Ver PDF'),
                        ),
                ),
          ],
        ),
      ),
    );
  }

  Widget _botonTipo(String valor, String etiqueta) {
    final activo = _tipo == valor;
    return OutlinedButton(
      onPressed: () => setState(() => _fijarTipo(valor)),
      style: OutlinedButton.styleFrom(
        backgroundColor: activo ? GomaqColors.accion : Colors.white,
        foregroundColor: activo ? Colors.white : GomaqColors.accion,
      ),
      child: Text(etiqueta),
    );
  }
}
