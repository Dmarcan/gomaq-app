import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../utils/efecto_guia.dart';
import '../utils/formato.dart';
import '../utils/motivo_cambio.dart' show nuevoUuid;
import 'confirmar_horometro.dart';
import 'dialogos.dart';

/// Cómo se envía la guía al servidor: ruta y campos del formulario. En producción es
/// [_enviarPorApi]; las pruebas pasan una función propia.
typedef EnviarGuia = Future<dynamic> Function(String ruta, Map<String, String> campos);

Future<dynamic> _enviarPorApi(String ruta, Map<String, String> campos) =>
    ApiClient.instance.postMultipart(ruta, fields: campos);

/// Asigna un equipo a un cliente sin tener la guia de despacho en PDF. Registra un despacho "sin
/// documento": la guia sigue siendo el evento que arrienda el equipo (de ella dependen los dias
/// de arriendo y la facturacion), solo que el PDF se adjunta despues desde Guias.
/// [clienteActual] es quien tiene hoy el equipo (si lo tiene), solo para el resumen del cuadro.
/// Devuelve true si se registro.
Future<bool> asignarEquipoACliente(
  BuildContext context, {
  required int maquinariaId,
  required String codigo,
  String? clienteActual,
}) async {
  List<dynamic> clientes;
  try {
    clientes = await ApiClient.instance.get('/api/clientes');
  } on ApiException catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No se pudo cargar la lista de clientes: ${e.message}')));
    return false;
  } catch (_) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No se pudo cargar la lista de clientes. Revisa tu conexión.')));
    }
    return false;
  }
  if (!context.mounted) return false;

  return mostrarGuiaRapida(
    context,
    tipo: 'despacho',
    maquinariaId: maquinariaId,
    codigo: codigo,
    clientes: clientes,
    clienteActual: clienteActual,
  );
}

/// Retira un equipo del cliente sin tener la guia de recepcion en PDF (misma idea que
/// [asignarEquipoACliente]). [clienteActual] es el nombre del cliente que lo tiene hoy, solo para
/// el resumen del cuadro. Devuelve true si se registro.
Future<bool> retirarEquipoDeCliente(
  BuildContext context, {
  required int maquinariaId,
  required String codigo,
  String? clienteActual,
}) {
  return mostrarGuiaRapida(
    context,
    tipo: 'recepcion',
    maquinariaId: maquinariaId,
    codigo: codigo,
    clienteActual: clienteActual,
  );
}

/// Cuadro común de Asignar y Retirar. El envío se hace dentro del propio cuadro: si falla (sin red,
/// por ejemplo) el cuadro sigue abierto.
///
/// La llave `uuid_cliente` se crea al abrir. Mientras no haya un envío con la respuesta perdida, cualquier
/// cambio de datos la renueva; si una respuesta se perdió, se conserva para que volver a intentar no
/// duplique la guía, y si el servidor ya tenía otra con datos distintos se explica.
Future<bool> mostrarGuiaRapida(
  BuildContext context, {
  required String tipo,
  required int maquinariaId,
  required String codigo,
  List<dynamic> clientes = const [],
  String? clienteActual,
  EnviarGuia enviar = _enviarPorApi,
  Future<num?> Function(int maquinariaId)? leerUltimaLectura,
}) async {
  final esDespacho = tipo == 'despacho';
  var llave = nuevoUuid();
  var respuestaPerdida = false;
  var yaRegistrada = false;
  final horometroCtrl = TextEditingController();
  final clienteCtrl = TextEditingController();
  int? clienteId;
  String? clienteNombre;
  DateTime fecha = DateTime.now();
  String? errorFecha;
  String? errorHorometro;

  // un cambio de datos con el envío anterior resuelto es otra guía: llave nueva
  void cambioDeDatos() {
    if (!respuestaPerdida) llave = nuevoUuid();
  }

  final registrado = await mostrarFormulario(
    context,
    icono: esDespacho ? Icons.north_east : Icons.south_west,
    titulo: esDespacho ? 'Asignar $codigo a un cliente' : 'Retirar $codigo del cliente',
    subtitulo: esDespacho ? 'Despacho sin documento' : 'Recepción sin documento',
    textoAccion: esDespacho ? 'Asignar' : 'Retirar',
    ancho: 520,
    contenido: (dialogContext, redibujar) {
      Future<void> elegirFecha() async {
        final ahora = DateTime.now();
        final dia = await showDatePicker(
          context: dialogContext,
          initialDate: fecha.isAfter(ahora) ? ahora : fecha,
          firstDate: ahora.subtract(const Duration(days: maxDiasAtrasGuiaRapida)),
          lastDate: DateTime.now(),
        );
        if (dia == null || !dialogContext.mounted) return;
        final hora = await showTimePicker(context: dialogContext, initialTime: TimeOfDay.fromDateTime(fecha));
        if (hora == null) return;
        redibujar(() {
          fecha = DateTime(dia.year, dia.month, dia.day, hora.hour, hora.minute);
          errorFecha = validarFechaGuiaRapida(fecha, DateTime.now());
          cambioDeDatos();
        });
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            esDespacho
                ? 'Queda registrado como despacho sin documento: el equipo pasa a ser del cliente y la guía '
                    'de despacho en PDF se adjunta después desde Guías.'
                : 'Queda registrado como recepción sin documento: el equipo vuelve a estar sin cliente y la guía '
                    'de recepción en PDF se adjunta después desde Guías.',
            style: const TextStyle(fontSize: 12, color: Colors.black54),
          ),
          separadorCampos,
          if (esDespacho) ...[
            // con buscador: la lista de clientes crece y un desplegable simple obliga a recorrerla entera
            LayoutBuilder(
              builder: (context, caja) => DropdownMenu<int>(
                controller: clienteCtrl,
                width: caja.maxWidth,
                label: const Text('Cliente'),
                enableFilter: true,
                requestFocusOnTap: true,
                menuHeight: 260,
                dropdownMenuEntries: [
                  for (final c in clientes) DropdownMenuEntry(value: c['id'] as int, label: '${c['nombre']}'),
                ],
                onSelected: (v) => redibujar(() {
                  clienteId = v;
                  clienteNombre = v == null
                      ? null
                      : '${clientes.firstWhere((c) => c['id'] == v, orElse: () => {'nombre': ''})['nombre']}';
                  cambioDeDatos();
                }),
              ),
            ),
            separadorCampos,
          ],
          Text('Fecha y hora', style: Theme.of(dialogContext).textTheme.labelMedium),
          const SizedBox(height: 6),
          OutlinedButton.icon(
            onPressed: elegirFecha,
            icon: const Icon(Icons.event, size: 18),
            label: Text('${Formato.fecha(fecha)} ${TimeOfDay.fromDateTime(fecha).format(dialogContext)}'),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              errorFecha ?? 'Por defecto, ahora. Se acepta hasta $maxDiasAtrasGuiaRapida días hacia atrás, nunca a futuro.',
              style: TextStyle(fontSize: 12, color: errorFecha == null ? Colors.black54 : Colors.red.shade800),
            ),
          ),
          separadorCampos,
          TextFormField(
            controller: horometroCtrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: decoracionCampo(
              esDespacho ? 'Horómetro al despachar (opcional)' : 'Horómetro al recibir (opcional)',
              sufijo: 'h',
            ).copyWith(errorText: errorHorometro),
            onChanged: (_) => redibujar(() {
              errorHorometro = null;
              cambioDeDatos();
            }),
          ),
          separadorCampos,
          _ResumenEfecto(
            texto: describirEfectoGuia(
              tipo: tipo,
              codigo: codigo,
              fecha: fecha,
              clienteNombre: clienteNombre,
              clienteActual: clienteActual,
              horometro: horometroCtrl.text,
              ahora: DateTime.now(),
            ),
          ),
        ],
      );
    },
    alGuardar: () async {
      if (esDespacho && clienteId == null) {
        throw ApiException(400, 'Elige el cliente al que se despacha el equipo.');
      }
      final errorDeFecha = validarFechaGuiaRapida(fecha, DateTime.now());
      if (errorDeFecha != null) throw ApiException(400, errorDeFecha);
      final textoHorometro = horometroCtrl.text.trim();
      final horometro = horometroParaEnvio(textoHorometro);
      if (textoHorometro.isNotEmpty && horometro == null) {
        throw ApiException(400, 'El horómetro no es un número válido. Escribe, por ejemplo, 1156 o 1156,5.');
      }
      if (horometro != null &&
          !await confirmarHorometroMenor(context, maquinariaId: maquinariaId, valor: num.tryParse(horometro), leerUltima: leerUltimaLectura)) {
        throw ApiException(0, 'Revisa la lectura: es menor que la última registrada.');
      }
      try {
        final respuesta = await enviar('/api/maquinarias/$maquinariaId/guias', {
          'tipo': tipo,
          'sin_documento': 'true',
          'uuid_cliente': llave,
          if (esDespacho && clienteId != null) 'cliente_id': clienteId.toString(),
          'fecha_hora': fechaIsoUtc(fecha),
          'horometro': ?horometro,
        });
        yaRegistrada = respuesta is Map && respuesta['ya_registrada'] == true;
        respuestaPerdida = false;
      } on ApiException catch (e) {
        if (e.statusCode == 409 && respuestaPerdida) {
          // el intento anterior sí llegó, con otros datos: la llave vieja ya no sirve
          respuestaPerdida = false;
          llave = nuevoUuid();
          throw ApiException(409, 'Ya se registró una guía con los datos anteriores. Revisa Recientes en Guías antes de volver a guardar.');
        }
        rethrow;
      } catch (_) {
        // sin respuesta (plazo agotado o sin red): puede que la guía sí se haya registrado
        respuestaPerdida = true;
        throw ApiException(0, 'No hubo respuesta del servidor. Si vuelves a intentar, no se duplica.');
      }
    },
  );
  // los controladores no se liberan aqui: el cuadro todavia se esta animando hacia afuera y sus
  // campos los siguen usando; dejarlos para el GC es inocuo (no tienen oyentes externos)
  if (registrado && context.mounted) {
    final pdf = 'Falta adjuntar la guía en PDF desde Guías.';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(yaRegistrada
          ? (esDespacho ? 'Esta asignación ya estaba registrada. $pdf' : 'Este retiro ya estaba registrado. $pdf')
          : (esDespacho ? 'Equipo asignado. $pdf' : 'Equipo retirado. $pdf')),
    ));
  }
  return registrado;
}

class _ResumenEfecto extends StatelessWidget {
  final String texto;
  const _ResumenEfecto({required this.texto});

  @override
  Widget build(BuildContext context) {
    return Semantics(
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
            Expanded(child: Text(texto, style: const TextStyle(fontSize: 13, height: 1.35))),
          ],
        ),
      ),
    );
  }
}
