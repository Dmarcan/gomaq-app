import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/estado_chip.dart';
import '../../widgets/estado_equipo.dart';
import '../../widgets/ficha_tecnica_campos.dart';
import '../../widgets/pestanas.dart';
import '../../utils/formato.dart';
import '../../utils/numeros.dart';
import '../../widgets/asignar_cliente.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/desglose_costos_equipo.dart';
import '../../widgets/documentos_equipo.dart';
import '../../widgets/linea_tiempo_equipo.dart';

/// Perfil de un equipo: quién es, en qué estado está y qué hacer con él.
///
/// Arriba, lo que hay que saber de un vistazo (estado, medida principal, combustible, cliente y
/// cuánto falta para la mantención) y las acciones. Debajo, pestañas para no apilar la ficha, el
/// historial y los costos en una sola página larga. Tiene URL propia (/flota/:id), así que F5 y
/// los enlaces compartidos vuelven a este equipo.
class MaquinariaPerfilScreen extends StatefulWidget {
  final int maquinariaId;

  /// Pestaña con que abre: 'resumen', 'ficha', 'historial' (la línea de tiempo), 'documentos' o 'costos'. Costos por equipo abre
  /// el perfil directo en 'costos'.
  final String pestanaInicial;
  const MaquinariaPerfilScreen({super.key, required this.maquinariaId, this.pestanaInicial = 'resumen'});

  @override
  State<MaquinariaPerfilScreen> createState() => _MaquinariaPerfilScreenState();
}

class _MaquinariaPerfilScreenState extends State<MaquinariaPerfilScreen> {
  Map<String, dynamic>? _maquinaria;
  List<dynamic> _historial = [];
  Map<String, dynamic>? _rentabilidad;
  bool _cargando = true;
  String? _error;
  bool _subiendoFoto = false;
  late String _pestana = const ['resumen', 'ficha', 'historial', 'documentos', 'costos'].contains(widget.pestanaInicial) ? widget.pestanaInicial : 'resumen';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  /// `silencioso` recarga los datos sin volver a la rueda de carga: se usa después de cambiar
  /// el estado o la ficha, para que la pantalla no parpadee.
  Future<void> _cargar({bool silencioso = false}) async {
    if (!silencioso) {
      setState(() {
        _cargando = true;
        _error = null;
      });
    }
    try {
      final maquinaria = await ApiClient.instance.get('/api/maquinarias/${widget.maquinariaId}');
      final historial = await ApiClient.instance.get('/api/maquinarias/${widget.maquinariaId}/ordenes-trabajo');
      if (!mounted) return;
      setState(() {
        _maquinaria = maquinaria;
        _historial = historial;
      });
      // el costo va aparte: solo lo ven gerente y administrativo, y si falla no debe
      // impedir que se vea la ficha del equipo
      try {
        final rentabilidad = await ApiClient.instance.get('/api/rentabilidad/maquinaria/${widget.maquinariaId}');
        if (mounted) setState(() => _rentabilidad = rentabilidad);
      } on ApiException catch (_) {}
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  /// Gasto en repuestos contra lo facturado. El gasto cuenta todas las líneas, se hayan
  /// cobrado o no: es el costo real para GOMAQ (entrevista el jefe de taller, punto 1).
  Widget _bloqueCosto() {
    final r = _rentabilidad!;
    final perdida = r['sale_a_perdida'] == true;
    final sinPrecio = (r['lineas_sin_precio'] ?? 0) as int;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 32,
          runSpacing: 12,
          children: [
            _cifra('Gasto en repuestos', Formato.clp(r['gasto']), Colors.black87),
            _cifra('Facturado', Formato.clp(r['ingreso']), Colors.black87),
            _cifra(
              perdida ? 'Pérdida' : 'Margen',
              Formato.clp(r['margen']),
              perdida ? const Color(0xFFB23A2E) : const Color(0xFF2F8F4E),
            ),
          ],
        ),
        if (perdida)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'Este equipo gastó más de lo que facturó en el período.',
              style: TextStyle(fontSize: 12, color: Color(0xFFB23A2E), fontWeight: FontWeight.bold),
            ),
          ),
        if (sinPrecio > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '$sinPrecio línea${sinPrecio == 1 ? '' : 's'} sin precio cargado: el gasto real es mayor.',
              style: const TextStyle(fontSize: 12, color: Color(0xFFC9820A)),
            ),
          ),
      ],
    );
  }

  Widget _cifra(String etiqueta, String valor, Color color) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(etiqueta, style: const TextStyle(fontSize: 11, color: Colors.black54)),
        Text(valor, style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: color)),
      ],
    );
  }

  Future<void> _cambiarFoto() async {
    final resultado = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['jpg', 'jpeg', 'png'],
      withData: true,
    );
    if (resultado == null || resultado.files.single.bytes == null) return;

    setState(() => _subiendoFoto = true);
    try {
      await ApiClient.instance.patchMultipart(
        '/api/maquinarias/${widget.maquinariaId}/foto',
        bytes: resultado.files.single.bytes,
        filename: resultado.files.single.name,
      );
      await _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo subir la foto: ${e.message}')));
    } finally {
      if (mounted) setState(() => _subiendoFoto = false);
    }
  }

  Future<void> _editarFichaTecnica() async {
    final m = _maquinaria!;
    final tipoCtrl = TextEditingController(text: m['tipo'] ?? '');
    final ubicacionCtrl = TextEditingController(text: m['ubicacion'] ?? '');
    final marcaCtrl = TextEditingController(text: m['marca'] ?? '');
    final modeloCtrl = TextEditingController(text: m['modelo'] ?? '');
    final anioCtrl = TextEditingController(text: m['anio']?.toString() ?? '');
    final descripcionCtrl = TextEditingController(text: m['descripcion'] ?? '');
    final capacidadCargaCtrl = TextEditingController(text: numeroParaEditar(m['capacidad_carga']));
    final alturaTrabajoCtrl = TextEditingController(text: numeroParaEditar(m['altura_trabajo']));
    final numeroSerieCtrl = TextEditingController(text: m['numero_serie'] ?? '');
    final numeroMotorCtrl = TextEditingController(text: m['numero_motor'] ?? '');
    final numeroChasisCtrl = TextEditingController(text: m['numero_chasis'] ?? '');
    final numeroMastilCtrl = TextEditingController(text: m['numero_mastil'] ?? '');
    String? categoria = m['categoria_equipo'];
    String? combustible = m['tipo_combustible'];
    String? texto(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();

    final guardada = await mostrarFormulario(
      context,
      icono: Icons.edit_note,
      titulo: 'Editar ${m['codigo']}',
      subtitulo: 'Datos de la ficha técnica del equipo',
      textoAccion: 'Guardar cambios',
      ancho: 580,
      contenido: (context, redibujar) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextFormField(
                  controller: tipoCtrl,
                  autofocus: true,
                  decoration: decoracionCampo('Tipo', obligatorio: true),
                  validator: obligatorio('Escribe el tipo de equipo.'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(child: TextFormField(controller: ubicacionCtrl, decoration: decoracionCampo('Ubicación'))),
            ],
          ),
          separadorCampos,
          DropdownButtonFormField<String>(
            initialValue: categoria,
            isExpanded: true,
            decoration: decoracionCampo('Categoría', ayuda: 'Define qué datos pide la ficha.'),
            items: [for (final c in categoriasEquipo) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
            onChanged: (v) => redibujar(() => categoria = v),
          ),
          const SizedBox(height: 8),
          const Divider(),
          const TituloSeccion('Ficha técnica'),
          ...camposFichaTecnica(
            categoria: categoria,
            combustible: combustible,
            onCombustibleChanged: (v) => redibujar(() => combustible = v),
            marcaCtrl: marcaCtrl,
            modeloCtrl: modeloCtrl,
            anioCtrl: anioCtrl,
            capacidadCargaCtrl: capacidadCargaCtrl,
            alturaTrabajoCtrl: alturaTrabajoCtrl,
            numeroMastilCtrl: numeroMastilCtrl,
            numeroMotorCtrl: numeroMotorCtrl,
            numeroChasisCtrl: numeroChasisCtrl,
            numeroSerieCtrl: numeroSerieCtrl,
            descripcionCtrl: descripcionCtrl,
          ),
        ],
      ),
      alGuardar: () => ApiClient.instance.patch('/api/maquinarias/${widget.maquinariaId}', {
        'tipo': texto(tipoCtrl),
        'ubicacion': texto(ubicacionCtrl),
        'categoria_equipo': categoria,
        'marca': texto(marcaCtrl),
        'modelo': texto(modeloCtrl),
        'anio': int.tryParse(anioCtrl.text.trim()),
        'descripcion': texto(descripcionCtrl),
        'capacidad_carga': parsearNumero(capacidadCargaCtrl.text),
        'altura_trabajo': parsearNumero(alturaTrabajoCtrl.text),
        'numero_serie': texto(numeroSerieCtrl),
        'numero_motor': texto(numeroMotorCtrl),
        'numero_chasis': texto(numeroChasisCtrl),
        'numero_mastil': texto(numeroMastilCtrl),
        'tipo_combustible': combustible,
      }),
    );
    for (final c in [tipoCtrl, ubicacionCtrl, marcaCtrl, modeloCtrl, anioCtrl, descripcionCtrl, capacidadCargaCtrl, alturaTrabajoCtrl, numeroSerieCtrl, numeroMotorCtrl, numeroChasisCtrl, numeroMastilCtrl]) {
      c.dispose();
    }
    if (guardada) {
      await _cargar(silencioso: true);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ficha técnica guardada')));
    }
  }

  // ---- acciones ------------------------------------------------------------------------------

  Future<void> _asignarACliente(Map<String, dynamic> m) async {
    final hecho = await asignarEquipoACliente(context, maquinariaId: widget.maquinariaId, codigo: '${m['codigo']}');
    if (hecho && mounted) _cargar(silencioso: true);
  }

  Future<void> _retirarDeCliente(Map<String, dynamic> m) async {
    final hecho = await retirarEquipoDeCliente(
      context,
      maquinariaId: widget.maquinariaId,
      codigo: '${m['codigo']}',
      clienteActual: m['cliente'] as String?,
    );
    if (hecho && mounted) _cargar(silencioso: true);
  }

  Future<void> _cambiarEstado() async {
    final actual = _maquinaria!['estado'] as String?;
    final elegido = await showDialog<String>(
      context: context,
      builder: (dialogContext) => CuadroDialogo(
        icono: Icons.swap_horiz,
        titulo: 'Cambiar estado',
        subtitulo: '${_maquinaria!['codigo']} está ${GomaqColors.etiquetaEstado(actual).toLowerCase()}',
        ancho: 400,
        cuerpo: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final estado in const ['operativa', 'en_mantencion', 'fuera_de_servicio'])
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InkWell(
                  borderRadius: BorderRadius.circular(10),
                  onTap: () => Navigator.pop(dialogContext, estado),
                  focusColor: GomaqColors.accion.withValues(alpha: 0.12),
                  child: Semantics(
                    button: true,
                    selected: estado == actual,
                    label: '${GomaqColors.etiquetaEstado(estado)}${estado == actual ? ', estado actual' : ''}',
                    excludeSemantics: true,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: estado == actual ? GomaqColors.accion : Colors.grey.shade300, width: estado == actual ? 2 : 1),
                      ),
                      child: Row(
                        children: [
                          EstadoEquipo(estado: estado),
                          const Spacer(),
                          if (estado == actual) const Text('Actual', style: TextStyle(color: Colors.black54, fontSize: 12)),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
    if (elegido == null || elegido == actual) return;
    try {
      await ApiClient.instance.patch('/api/maquinarias/${widget.maquinariaId}/estado', {'estado': elegido});
      await _cargar(silencioso: true);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('${_maquinaria!['codigo']} quedó ${GomaqColors.etiquetaEstado(elegido).toLowerCase()}')));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo cambiar el estado: ${e.message}')));
    }
  }

  void _crearOrden() => context.go('/ordenes?nueva=1&maquinaria=${widget.maquinariaId}');

  void _volver() => context.canPop() ? context.pop() : context.go('/flota');

  // ---- datos derivados -----------------------------------------------------------------------

  static bool _vacio(dynamic v) => v == null || '$v'.trim().isEmpty;

  /// Los datos de la ficha que ayudan a distinguir y mantener el equipo y todavía no se cargaron.
  /// Motor, chasis y mástil no cuentan: no aplican a todos los equipos (un alzahombre eléctrico
  /// no tiene motor de combustión) y avisarlos como faltantes sería ruido.
  List<String> _datosFaltantes(Map<String, dynamic> m) {
    final c = m['categoria_equipo'] as String?;
    return [
      if (_vacio(m['marca'])) 'marca',
      if (_vacio(m['modelo'])) 'modelo',
      if (_vacio(m['anio'])) 'año',
      if (_vacio(m['numero_serie'])) 'N° de serie',
      if (mostrarCapacidad(c) && _vacio(m['capacidad_carga'])) 'capacidad de carga',
      if (mostrarAltura(c) && _vacio(m['altura_trabajo'])) 'altura de trabajo',
      if (mostrarCombustible(c) && _vacio(m['tipo_combustible'])) 'combustible',
      if (_vacio(m['foto_url'])) 'foto',
    ];
  }

  static String _lista(List<String> items) =>
      items.length <= 1 ? items.join() : '${items.sublist(0, items.length - 1).join(', ')} y ${items.last}';

  /// La medida que mejor describe al equipo: la altura en un alzahombre, la capacidad en el resto.
  ({String etiqueta, String valor}) _medidaPrincipal(Map<String, dynamic> m) {
    final capacidad = Formato.medida(m['capacidad_carga'], 'kg');
    final altura = Formato.medida(m['altura_trabajo'], 'm');
    switch (m['categoria_equipo']) {
      case 'alzahombre':
        return (etiqueta: 'Altura de trabajo', valor: altura);
      case null:
        // sin categoría no se sabe cuál corresponde: se muestra la que exista
        if (capacidad.isEmpty && altura.isNotEmpty) return (etiqueta: 'Altura de trabajo', valor: altura);
        return (etiqueta: 'Capacidad de carga', valor: capacidad);
      default:
        return (etiqueta: 'Capacidad de carga', valor: capacidad);
    }
  }

  /// Cuánto falta para la preventiva, según el horómetro. Devuelve el texto y un color que avisa
  /// cuando está por vencer o vencida.
  ({String texto, Color? color}) _textoMantencion(Map<String, dynamic>? mant) {
    if (mant == null || mant['horas_restantes'] == null) {
      return (texto: '', color: null);
    }
    final restantes = (mant['horas_restantes'] as num).toDouble();
    if (mant['vencida'] == true) {
      return (texto: 'Vencida hace ${Formato.medida(restantes.abs(), 'h')}', color: GomaqColors.textoEstado('fuera_de_servicio'));
    }
    final texto = 'En ${Formato.medida(restantes, 'h')}';
    return (texto: texto, color: mant['por_vencer'] == true ? GomaqColors.textoEstado('en_mantencion') : null);
  }

  // ---- pantalla ------------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();

    Widget cuerpo;
    if (_cargando) {
      cuerpo = const Center(child: CircularProgressIndicator());
    } else if (_error != null) {
      cuerpo = Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('No se pudo cargar el equipo: $_error'),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: _cargar, child: const Text('Reintentar')),
          ],
        ),
      );
    } else {
      cuerpo = _contenido(auth);
    }

    return Scaffold(backgroundColor: Colors.transparent, body: cuerpo);
  }

  Widget _contenido(AuthService auth) {
    final m = _maquinaria!;

    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 32),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(onPressed: _volver, icon: const Icon(Icons.arrow_back, size: 18), label: const Text('Flota')),
          ),
          _cabecera(m, auth),
          const SizedBox(height: 16),
          _cifrasClave(m),
          const SizedBox(height: 20),
          Pestanas(
            items: [
              (id: 'resumen', etiqueta: 'Resumen', cantidad: null),
              (id: 'ficha', etiqueta: 'Ficha técnica', cantidad: null),
              (id: 'historial', etiqueta: 'Línea de tiempo', cantidad: null),
              (id: 'documentos', etiqueta: 'Documentos', cantidad: null),
              if (_rentabilidad != null) (id: 'costos', etiqueta: 'Costos', cantidad: null),
            ],
            seleccionada: _pestana,
            onSeleccionar: (id) => setState(() => _pestana = id),
          ),
          const SizedBox(height: 20),
          switch (_pestana) {
            'ficha' => _pestanaFicha(m, auth),
            'historial' => LineaTiempoEquipo(
                maquinariaId: widget.maquinariaId,
                onIrADocumentos: () => setState(() => _pestana = 'documentos'),
              ),
            'documentos' => DocumentosEquipo(maquinariaId: widget.maquinariaId, filtrarPorCliente: true),
            'costos' => _pestanaCostos(),
            _ => _pestanaResumen(m, auth),
          },
        ],
      ),
    );
  }

  Widget _cabecera(Map<String, dynamic> m, AuthService auth) {
    final categoria = m['categoria_equipo'] as String?;
    final marcaModelo = [m['marca'], m['modelo']].where((x) => !_vacio(x)).join(' ');
    final subtitulo = [
      m['tipo'],
      if (marcaModelo.isNotEmpty) marcaModelo,
      if (categoria != null) etiquetasCategoria[categoria],
    ].where((x) => !_vacio(x)).join(' · ');

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 16, offset: const Offset(0, 4))],
      ),
      child: Wrap(
        spacing: 20,
        runSpacing: 16,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: m['foto_url'] != null
                    ? Image.network(m['foto_url'], width: 72, height: 72, fit: BoxFit.cover)
                    : Container(
                        width: 72,
                        height: 72,
                        color: GomaqColors.primario.withValues(alpha: 0.10),
                        child: Icon(iconoCategoria(categoria), size: 34, color: GomaqColors.accion),
                      ),
              ),
              const SizedBox(width: 16),
              // Flexible: sin él, el subtítulo no tenía límite de ancho en un teléfono y se salía
              // de la tarjeta en vez de pasar a la línea siguiente.
              Flexible(
                child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 12,
                      runSpacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text('${m['codigo']}', style: const TextStyle(fontFamily: 'Barlow', fontSize: 26, fontWeight: FontWeight.w700)),
                        EstadoEquipo(estado: m['estado'], grande: true),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(subtitulo, style: const TextStyle(color: Colors.black54, fontSize: 14)),
                  ],
                ),
                ),
              ),
            ],
          ),
          if (auth.esAdministrativo)
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(onPressed: _cambiarEstado, icon: const Icon(Icons.swap_horiz, size: 18), label: const Text('Cambiar estado')),
                OutlinedButton.icon(onPressed: _crearOrden, icon: const Icon(Icons.assignment_add, size: 18), label: const Text('Crear orden de trabajo')),
                // un equipo fuera de servicio no se despacha (misma regla que equiposParaGuia)
                if (_vacio(m['cliente']) && m['estado'] != 'fuera_de_servicio')
                  OutlinedButton.icon(
                    onPressed: () => _asignarACliente(m),
                    icon: const Icon(Icons.business_center_outlined, size: 18),
                    label: const Text('Asignar a cliente'),
                  )
                else
                  OutlinedButton.icon(
                    onPressed: () => _retirarDeCliente(m),
                    icon: const Icon(Icons.undo, size: 18),
                    label: const Text('Retirar del cliente'),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _cifrasClave(Map<String, dynamic> m) {
    final medida = _medidaPrincipal(m);
    final combustible = m['tipo_combustible'] != null ? etiquetasCombustible[m['tipo_combustible']] : null;
    final cliente = m['cliente'] as String?;
    final mant = _textoMantencion(m['mantencion'] as Map<String, dynamic>?);

    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: [
        _cifraClave(medida.etiqueta, medida.valor),
        _cifraClave('Combustible', combustible ?? ''),
        _cifraClave('Cliente actual', cliente ?? (m['estado'] == 'operativa' ? 'Disponible' : 'Sin cliente')),
        _cifraClave('Próxima mantención', mant.texto, color: mant.color, textoVacio: 'Sin lecturas de horómetro'),
      ],
    );
  }

  /// Una cifra grande de la cabecera. Sin dato se dice "Sin dato" en gris en vez de ocultarla:
  /// que falte la altura de un alzahombre es información, no algo que deba desaparecer.
  Widget _cifraClave(String etiqueta, String valor, {Color? color, String textoVacio = 'Sin dato'}) {
    final vacio = valor.isEmpty;
    return Semantics(
      container: true,
      label: '$etiqueta: ${vacio ? textoVacio : valor}',
      child: ExcludeSemantics(
        child: Container(
          width: 210,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Colors.grey.shade300),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black54)),
              const SizedBox(height: 4),
              Text(
                vacio ? textoVacio : valor,
                style: TextStyle(
                  fontSize: vacio ? 14 : 20,
                  fontWeight: vacio ? FontWeight.w500 : FontWeight.w700,
                  color: vacio ? Colors.black54 : (color ?? Colors.black87),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ---- pestañas ------------------------------------------------------------------------------

  Widget _pestanaResumen(Map<String, dynamic> m, AuthService auth) {
    final faltantes = _datosFaltantes(m);
    final recientes = _historial.take(3).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (faltantes.isNotEmpty) ...[
          _avisoFaltantes(faltantes, auth),
          const SizedBox(height: 20),
        ],
        const Text('Últimas órdenes de trabajo', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        if (recientes.isEmpty)
          const Text('Este equipo no tiene órdenes de trabajo registradas.', style: TextStyle(color: Colors.black54))
        else ...[
          for (final ot in recientes) _filaOt(ot),
          if (_historial.length > recientes.length)
            TextButton(onPressed: () => setState(() => _pestana = 'historial'), child: const Text('Ver la línea de tiempo completa')),
        ],
      ],
    );
  }

  Widget _avisoFaltantes(List<String> faltantes, AuthService auth) {
    final color = GomaqColors.textoEstado('en_mantencion');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: GomaqColors.estadoAdvertencia.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Icon(Icons.info_outline, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '${faltantes.length == 1 ? 'Falta 1 dato' : 'Faltan ${faltantes.length} datos'} de la ficha: ${_lista(faltantes)}.',
              style: TextStyle(color: color, fontWeight: FontWeight.w600),
            ),
          ),
          if (auth.esAdministrativo) TextButton(onPressed: _editarFichaTecnica, child: const Text('Completar')),
        ],
      ),
    );
  }

  Widget _pestanaFicha(Map<String, dynamic> m, AuthService auth) {
    final categoria = m['categoria_equipo'] as String?;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (auth.esAdministrativo) ...[
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton.icon(onPressed: _editarFichaTecnica, icon: const Icon(Icons.edit, size: 16), label: const Text('Editar ficha técnica')),
              OutlinedButton.icon(
                onPressed: _subiendoFoto ? null : _cambiarFoto,
                icon: _subiendoFoto
                    ? const SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.image_outlined, size: 16),
                label: Text(m['foto_url'] == null ? 'Agregar foto' : 'Cambiar foto'),
              ),
            ],
          ),
          const SizedBox(height: 16),
        ],
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            _tile('Marca', m['marca']),
            _tile('Modelo', m['modelo']),
            _tile('Año', m['anio']?.toString()),
            if (mostrarCapacidad(categoria)) _tile('Capacidad de carga', Formato.medida(m['capacidad_carga'], 'kg')),
            if (mostrarAltura(categoria)) _tile('Altura de trabajo', Formato.medida(m['altura_trabajo'], 'm')),
            if (mostrarCombustible(categoria))
              _tile('Combustible', m['tipo_combustible'] != null ? etiquetasCombustible[m['tipo_combustible']] : null),
            _tile('N° de serie', m['numero_serie']),
            if (mostrarMotorChasis(categoria)) ...[
              _tile('N° de motor', m['numero_motor']),
              _tile('N° de chasis', m['numero_chasis']),
            ],
            if (mostrarMastil(categoria)) _tile('N° de mástil', m['numero_mastil']),
            _tile('Ubicación', m['ubicacion']),
          ],
        ),
        if (!_vacio(m['descripcion'])) ...[
          const SizedBox(height: 16),
          Text('${m['descripcion']}', style: const TextStyle(fontSize: 14, color: Colors.black87)),
        ],
      ],
    );
  }

  Widget _tile(String etiqueta, String? valor) {
    final vacio = _vacio(valor);
    return Semantics(
      container: true,
      label: '$etiqueta: ${vacio ? 'sin dato' : valor}',
      child: ExcludeSemantics(
        child: Container(
          width: 200,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            border: Border.all(color: Colors.grey.shade300),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(etiqueta, style: const TextStyle(fontSize: 12, color: Colors.black54)),
              const SizedBox(height: 4),
              Text(
                vacio ? 'Sin dato' : valor!,
                style: TextStyle(fontSize: 14, fontWeight: vacio ? FontWeight.w400 : FontWeight.w600, color: vacio ? Colors.black54 : Colors.black87),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _pestanaCostos() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Costo del equipo, últimos 12 meses', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        _bloqueCosto(),
        DesgloseCostosEquipo(
          maquinariaId: widget.maquinariaId,
          rentabilidad: _rentabilidad!,
          onIrADocumentos: () => setState(() => _pestana = 'documentos'),
        ),
      ],
    );
  }

  Widget _filaOt(Map<String, dynamic> ot) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: IntrinsicHeight(
        child: Row(
          children: [
            Container(
              width: 4,
              decoration: BoxDecoration(
                color: GomaqColors.colorEstado(ot['estado']),
                borderRadius: const BorderRadius.horizontal(left: Radius.circular(10)),
              ),
            ),
            Expanded(
              child: ListTile(
                onTap: () => context.push('/ordenes/${ot['id']}'),
                title: Text('OT #${ot['id']} · ${ot['motivo'] ?? 'Sin motivo especificado'}'),
                subtitle: Text(
                  // dd/mm/aaaa como en el resto del sistema (antes mostraba 2026-09-09)
                  '${ot['diagnostico'] ?? 'Sin diagnóstico'}\n${Formato.fecha(ot['fecha_creacion'])}'
                  '${ot['fecha_cierre'] != null ? ' → ${Formato.fecha(ot['fecha_cierre'])}' : ''}',
                ),
                isThreeLine: true,
                trailing: EstadoChip(estado: ot['estado']),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
