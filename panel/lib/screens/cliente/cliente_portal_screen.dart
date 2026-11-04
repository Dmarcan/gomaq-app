import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/auth_service.dart';
import '../../theme/gomaq_theme.dart';
import '../../widgets/confirmar_cerrar_sesion.dart';
import 'cliente_mis_equipos_screen.dart';
import 'cliente_seguimiento_screen.dart';
import 'cliente_historial_screen.dart';

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

  static const _titulos = ['Mis equipos', 'Seguimiento', 'Historial'];

  static const _tabs = [
    ClienteMisEquiposScreen(),
    ClienteSeguimientoScreen(),
    ClienteHistorialScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return Scaffold(
      backgroundColor: GomaqColors.fondoCalido,
      appBar: AppBar(
        title: Text('GOMAQ - ${_titulos[_tab]}'),
        backgroundColor: GomaqColors.fondoCalido,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refrescar',
            onPressed: () => setState(() => _refreshKey = UniqueKey()),
          ),
          IconButton(
            tooltip: 'Cerrar sesión',
            icon: const Icon(Icons.logout),
            onPressed: () => confirmarCerrarSesion(context, auth),
          ),
        ],
      ),
      body: KeyedSubtree(key: _refreshKey, child: IndexedStack(index: _tab, children: _tabs)),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.local_shipping), label: 'Mis equipos'),
          NavigationDestination(icon: Icon(Icons.timeline), label: 'Seguimiento'),
          NavigationDestination(icon: Icon(Icons.history), label: 'Historial'),
        ],
      ),
    );
  }
}
