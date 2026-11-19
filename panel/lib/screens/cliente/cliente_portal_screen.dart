import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/cambiar_mi_clave.dart';
import '../../widgets/boton_avisos.dart';
import '../../widgets/confirmar_cerrar_sesion.dart';
import 'cliente_mis_equipos_screen.dart';
import 'cliente_seguimiento_screen.dart';
import 'cliente_historial_screen.dart';
import 'cliente_mi_empresa_screen.dart';

class ClientePortalScreen extends StatefulWidget {
  /// Pestaña con la que se abre (`/portal?pestana=seguimiento`): 'seguimiento' o 'historial'.
  /// El router remonta la pantalla cuando cambia la URL, así que también recarga los datos.
  final String? pestanaInicial;
  const ClientePortalScreen({super.key, this.pestanaInicial});

  @override
  State<ClientePortalScreen> createState() => _ClientePortalScreenState();
}

class _ClientePortalScreenState extends State<ClientePortalScreen> {
  late int _tab = pestanaDePortal(widget.pestanaInicial);

  // cambiar esta key remonta las pestanas: su initState vuelve a cargar los datos
  Key _refreshKey = UniqueKey();

  static const _titulos = ['Mis equipos', 'Seguimiento', 'Historial', 'Mi empresa'];

  // Las tres primeras se remontan con Refrescar. Mi empresa queda fuera de esa key y sin boton
  // Refrescar: remontarla borraria lo que el cliente esta escribiendo.
  static const _tabs = [
    ClienteMisEquiposScreen(),
    ClienteSeguimientoScreen(),
    ClienteHistorialScreen(),
  ];
  static const _indiceMiEmpresa = 3;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return Scaffold(
      backgroundColor: GomaqColors.fondoCalido,
      appBar: AppBar(
        title: Row(
          children: [
            Image.asset('assets/logo_gomaq_sobre_claro.png', height: 20, semanticLabel: 'GOMAQ'),
            // en pantallas angostas los cuatro iconos de la derecha no dejan espacio al titulo (se veia "M...");
            // la seccion ya la indica la barra de abajo, asi que solo se muestra desde 480 px
            if (MediaQuery.sizeOf(context).width >= 480) ...[
              const SizedBox(width: 12),
              Flexible(child: Text(_titulos[_tab], overflow: TextOverflow.ellipsis)),
            ],
          ],
        ),
        backgroundColor: GomaqColors.fondoCalido,
        actions: [
          if (_tab != _indiceMiEmpresa)
            IconButton(
              icon: const Icon(Icons.refresh),
              tooltip: 'Refrescar',
              onPressed: () => setState(() => _refreshKey = UniqueKey()),
            ),
          const BotonAvisos(),
          IconButton(
            tooltip: 'Cambiar mi contraseña',
            icon: const Icon(Icons.password),
            onPressed: () => mostrarCambiarMiClave(context),
          ),
          IconButton(
            tooltip: 'Cerrar sesión',
            icon: const Icon(Icons.logout),
            onPressed: () => confirmarCerrarSesion(context, auth),
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab == _indiceMiEmpresa ? 1 : 0,
        children: [
          KeyedSubtree(
            key: _refreshKey,
            child: IndexedStack(index: _tab == _indiceMiEmpresa ? 0 : _tab, children: _tabs),
          ),
          const ClienteMiEmpresaScreen(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.local_shipping), label: 'Mis equipos'),
          NavigationDestination(icon: Icon(Icons.timeline), label: 'Seguimiento'),
          NavigationDestination(icon: Icon(Icons.history), label: 'Historial'),
          NavigationDestination(icon: Icon(Icons.business), label: 'Mi empresa'),
        ],
      ),
    );
  }
}
