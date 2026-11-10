import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../services/api_client.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/dialogos.dart';
import '../../widgets/estado_vacio.dart';

/// Aviso único de la lista cuando el servidor no tiene proveedor de envío conectado.
const avisoProveedorSinConectar =
    'No hay un proveedor de envío conectado (correo o mensajes): los avisos quedan registrados, pero no salen hacia el destinatario.';

/// El error que deja el worker cuando falta el proveedor ("Proveedor de email no configurado todavia").
bool errorProveedorSinConectar(Object? ultimoError) =>
    RegExp(r'Proveedor de \S+ no configurado', caseSensitive: false).hasMatch('${ultimoError ?? ''}');

/// Un aviso en error cuyo único problema es que no hay proveedor de envío: no es una falla del aviso.
bool esAvisoSinProveedor(Map n) => n['estado'] == 'error' && errorProveedorSinConectar(n['ultimo_error']);

/// Reintentar solo sirve en un error real: sin proveedor conectado volvería a fallar igual.
bool puedeReintentarAviso(Map n) => n['estado'] == 'error' && !esAvisoSinProveedor(n);

/// Color del punto de la fila: gris apagado para el aviso sin proveedor (el texto lo dice), el de siempre en el resto.
Color colorPuntoAviso(Map n) =>
    esAvisoSinProveedor(n) ? GomaqColors.grisApagado : GomaqColors.colorEstado(n['estado']);

/// La línea de detalle de un aviso. Un error por proveedor sin conectar se dice en limpio; los demás
/// errores se muestran como vienen.
String textoDetalleNotificacion(Map n) {
  if (n['estado'] == 'error') {
    if (errorProveedorSinConectar(n['ultimo_error'])) {
      return 'Sin proveedor de envío conectado: el aviso quedó registrado.';
    }
    return 'Error tras ${n['intentos']} intentos: ${n['ultimo_error'] ?? ''}';
  }
  if (n['estado'] == 'cancelado') return 'Cancelada: ${n['ultimo_error'] ?? 'ya no corresponde enviarla'}';
  return 'Estado: ${n['estado']} (${n['intentos']} intentos)';
}

class NotificacionesScreen extends StatefulWidget {
  /// 'problemas' llega desde el dashboard: solo los avisos que ese número cuenta (con error o atrasados,
  /// sin los avisos internos), con el total real aunque la lista tenga un tope.
  final String? filtroInicial;
  const NotificacionesScreen({super.key, this.filtroInicial});

  @override
  State<NotificacionesScreen> createState() => _NotificacionesScreenState();
}

class _NotificacionesScreenState extends State<NotificacionesScreen> {
  List<dynamic> _notificaciones = [];
  bool _cargando = true;
  String? _error;
  bool _soloProblemas = false;
  int _totalProblemas = 0;

  @override
  void initState() {
    super.initState();
    _soloProblemas = widget.filtroInicial == 'problemas';
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargar());
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final data = await ApiClient.instance.get(_soloProblemas ? '/api/notificaciones?problemas=1' : '/api/notificaciones');
      if (!mounted) return;
      setState(() {
        if (_soloProblemas) {
          // { items, total, hay_mas }: el total es el número que mostró el dashboard
          _notificaciones = (data['items'] as List?) ?? [];
          _totalProblemas = (data['total'] as num?)?.toInt() ?? _notificaciones.length;
        } else {
          _notificaciones = data;
        }
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      // sin red o dato inesperado
      if (mounted) setState(() => _error = mensajeErrorCarga(e));
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _reintentar(int id) async {
    try {
      await ApiClient.instance.post('/api/notificaciones/$id/reintentar', {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Notificación devuelta a la cola de envío')));
      }
      _cargar();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    }
  }

  /// Aviso de que la lista viene filtrada desde el dashboard, con la salida para ver todos.
  bool get _hayProveedorSinConectar =>
      _notificaciones.any((n) => n['estado'] == 'error' && errorProveedorSinConectar(n['ultimo_error']));

  Widget _encabezadoFiltro() {
    final hayMas = _totalProblemas > _notificaciones.length;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              hayMas
                  ? 'Avisos con problemas: $_totalProblemas (se muestran los ${_notificaciones.length} más recientes)'
                  : 'Avisos con problemas: $_totalProblemas',
              style: const TextStyle(fontSize: 13),
            ),
          ),
          TextButton(
            onPressed: () => context.go('/notificaciones'),
            child: const Text('Ver todos'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? EstadoError(titulo: 'No se pudieron cargar los avisos', mensaje: _error!, onReintentar: _cargar)
                : _notificaciones.isEmpty
                    ? Center(child: Text(_soloProblemas ? 'No hay avisos con problemas' : 'No hay notificaciones registradas'))
                    : ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _notificaciones.length + (_soloProblemas ? 1 : 0) + (_hayProveedorSinConectar ? 1 : 0),
                        itemBuilder: (context, i) {
                          if (_soloProblemas) {
                            if (i == 0) return _encabezadoFiltro();
                            i -= 1;
                          }
                          if (_hayProveedorSinConectar) {
                            if (i == 0) {
                              return const Padding(
                                padding: EdgeInsets.only(bottom: 8),
                                child: LineaInfo(icono: Icons.info_outline, texto: avisoProveedorSinConectar),
                              );
                            }
                            i -= 1;
                          }
                          final n = _notificaciones[i];
                          return Card(
                            child: ListTile(
                              leading: Icon(Icons.circle, size: 12, color: colorPuntoAviso(n)),
                              title: Text('${n['canal']} -> ${n['destinatario']}'),
                              subtitle: Text(
                                textoDetalleNotificacion(n),
                                style: esAvisoSinProveedor(n)
                                    ? const TextStyle(color: GomaqColors.grisApagado)
                                    : null,
                              ),
                              trailing: puedeReintentarAviso(n)
                                  ? OutlinedButton.icon(
                                      onPressed: () => _reintentar(n['id']),
                                      icon: const Icon(Icons.replay, size: 16),
                                      label: const Text('Reintentar'),
                                    )
                                  : null,
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}
