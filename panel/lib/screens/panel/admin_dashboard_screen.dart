import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../router.dart';
import '../../services/auth_service.dart';
import '../../services/pendientes_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../utils/pendientes.dart';
import '../../widgets/confirmar_cerrar_sesion.dart';

/// Marco del panel: barra lateral fija y el contenido de la seccion activa.
///
/// Antes era un StatefulWidget con `int _seccion`, asi que la URL nunca cambiaba: F5 volvia
/// al Dashboard y no habia enlaces profundos. Ahora es el shell de go_router y la seccion la
/// determina la ruta, con lo que el boton atras del navegador y compartir un enlace funcionan.
class AdminDashboardScreen extends StatefulWidget {
  final String rutaActual;
  final Widget child;
  const AdminDashboardScreen({super.key, required this.rutaActual, required this.child});

  @override
  State<AdminDashboardScreen> createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  // cambiar esta key remonta la pantalla activa: su initState vuelve a cargar los datos,
  // que es un refresh universal sin depender de pull-to-refresh (inusable con mouse)
  Key _refreshKey = UniqueKey();

  // /flota/12 (el perfil de un equipo) sigue siendo la sección Flota. "/" no cuenta como prefijo
  // de nada: todas las rutas empiezan con él y dejaría siempre activo el Dashboard.
  bool _esRutaActiva(ItemMenu i) =>
      i.ruta == widget.rutaActual || (i.ruta != '/' && widget.rutaActual.startsWith('${i.ruta}/'));

  ItemMenu get _itemActivo => itemsMenu.firstWhere(_esRutaActiva, orElse: () => itemsMenu.first);

  @override
  void initState() {
    super.initState();
    // los contadores del menú: se piden al abrir el panel (la caché de 5 minutos evita repetirlo)
    WidgetsBinding.instance.addPostFrameCallback((_) => PendientesService.instance.cargar());
  }

  @override
  void dispose() {
    // al cerrar sesión no debe quedar el dato de la persona anterior
    PendientesService.instance.limpiar();
    super.dispose();
  }

  @override
  void didUpdateWidget(AdminDashboardScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    // al cambiar de seccion la key vuelve a ser unica, para que la nueva pantalla cargue
    if (oldWidget.rutaActual != widget.rutaActual) {
      _refreshKey = UniqueKey();
      // al cambiar de sección se pide de nuevo solo si la caché de 5 minutos ya venció
      PendientesService.instance.cargar();
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();

    // Por debajo de 900 px la barra lateral fija (240 px) dejaba el contenido apretado o
    // cortado: pasa a un menú desplegable que se abre con el botón del encabezado.
    return LayoutBuilder(
      builder: (context, restricciones) {
        final compacto = restricciones.maxWidth < 900;
        final contenido = _contenido(compacto: compacto);
        if (compacto) {
          return Scaffold(
            drawer: Drawer(width: 260, child: _barraLateral(auth, enMenuDesplegable: true)),
            body: contenido,
          );
        }
        return Scaffold(
          body: Row(children: [_barraLateral(auth), Expanded(child: contenido)]),
        );
      },
    );
  }

  Widget _contenido({required bool compacto}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              if (compacto)
                // Builder: Scaffold.of necesita un contexto que ya esté bajo el Scaffold
                Builder(
                  builder: (context) => IconButton(
                    icon: const Icon(Icons.menu),
                    tooltip: 'Abrir menú',
                    onPressed: () => Scaffold.of(context).openDrawer(),
                  ),
                ),
              Expanded(
                child: Text(_itemActivo.etiqueta,
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
              ),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refrescar',
                onPressed: () {
                  PendientesService.instance.cargar(forzar: true);
                  setState(() => _refreshKey = UniqueKey());
                },
              ),
            ],
          ),
        ),
        Expanded(
          child: KeyedSubtree(
            key: _refreshKey,
            // Cada página del navegador interno del ShellRoute trae una barrera modal con
            // BlockSemantics, que ocultaba al lector de pantalla todo lo dibujado antes en el mismo
            // contenedor: el menú lateral y este encabezado no existían en el árbol de
            // accesibilidad. Un contenedor propio limita la barrera al contenido de la sección.
            child: Semantics(container: true, child: widget.child),
          ),
        ),
      ],
    );
  }

  Widget _barraLateral(AuthService auth, {bool enMenuDesplegable = false}) {
    return Container(
      width: 240,
      color: GomaqColors.sidebarOscuro,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 28, 20, 20),
            child: Row(
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: GomaqColors.primario,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.business, color: Colors.white, size: 20),
                ),
                const SizedBox(width: 10),
                const Text('GOMAQ Panel',
                    style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
              ],
            ),
          ),
          const Divider(color: Colors.white24, height: 1),
          const SizedBox(height: 12),
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: _menuAgrupado(cerrarAlNavegar: enMenuDesplegable),
            ),
          ),
          const Divider(color: Colors.white24, height: 1),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(auth.nombre ?? '',
                          style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
                      Text(_etiquetaRol(auth.rol), style: const TextStyle(color: Colors.white70, fontSize: 12)),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.logout, color: Colors.white70, size: 18),
                  tooltip: 'Cerrar sesión',
                  onPressed: () => confirmarCerrarSesion(context, auth),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// El menu con encabezado por area. Eran 13 items planos, que es mas de lo que alguien
  /// escanea de una mirada.
  List<Widget> _menuAgrupado({required bool cerrarAlNavegar}) {
    final widgets = <Widget>[];
    String? grupoAnterior;
    for (final item in itemsMenu) {
      if (item.grupo != grupoAnterior) {
        widgets.add(Padding(
          padding: EdgeInsets.fromLTRB(24, grupoAnterior == null ? 4 : 18, 24, 6),
          child: Text(
            item.grupo.toUpperCase(),
            // white38 a 10 px no se leía (WCAG 1.4.3); white70 da 8,5:1 sobre la barra
            style: const TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 1),
          ),
        ));
        grupoAnterior = item.grupo;
      }
      widgets.add(_itemMenu(item, cerrarAlNavegar: cerrarAlNavegar));
    }
    return widgets;
  }

  Widget _itemMenu(ItemMenu item, {required bool cerrarAlNavegar}) {
    final activo = _esRutaActiva(item);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: Material(
        color: activo ? GomaqColors.sidebarResaltado : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          // el foco por defecto es un sombreado oscuro, invisible sobre esta barra
          focusColor: Colors.white24,
          onTap: () {
            // en el menú desplegable, elegir una sección también lo cierra
            if (cerrarAlNavegar) Navigator.of(context).maybePop();
            context.go(destinoMenu(item.ruta, PendientesService.instance.datos));
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            child: Row(
              children: [
                Icon(item.icono, color: activo ? GomaqColors.primario : Colors.white70, size: 20),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    item.etiqueta,
                    style: TextStyle(color: activo ? Colors.white : Colors.white70, fontSize: 13),
                  ),
                ),
                _contador(item.ruta),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// El número de cosas por hacer de una sección, junto a su nombre en el menú. Blanco sobre el naranja
  /// de acción (5,2:1); el de marca no llega al contraste mínimo con texto blanco.
  Widget _contador(String ruta) {
    return ListenableBuilder(
      listenable: PendientesService.instance,
      builder: (context, _) {
        final n = contadorMenu(ruta, PendientesService.instance.datos);
        if (n <= 0) return const SizedBox.shrink();
        return Semantics(
          label: '$n pendientes',
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
            decoration: BoxDecoration(color: GomaqColors.accion, borderRadius: BorderRadius.circular(10)),
            child: ExcludeSemantics(
              child: Text(
                n > 99 ? '99+' : '$n',
                style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
              ),
            ),
          ),
        );
      },
    );
  }

  static String _etiquetaRol(String? rol) => switch (rol) {
        'gerente' => 'Gerente',
        'administrativo' => 'Administrativo',
        _ => rol ?? '',
      };
}
