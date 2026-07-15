import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import 'flota_screen.dart';
import 'clientes_screen.dart';
import 'ordenes_screen.dart';
import 'solicitudes_screen.dart';
import 'notificaciones_screen.dart';

class AdminDashboardScreen extends StatefulWidget {
  const AdminDashboardScreen({super.key});

  @override
  State<AdminDashboardScreen> createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  int _seccion = 0;

  static const _destinos = [
    NavigationRailDestination(icon: Icon(Icons.local_shipping), label: Text('Flota')),
    NavigationRailDestination(icon: Icon(Icons.people), label: Text('Clientes')),
    NavigationRailDestination(icon: Icon(Icons.assignment), label: Text('Ordenes de Trabajo')),
    NavigationRailDestination(icon: Icon(Icons.support_agent), label: Text('Solicitudes')),
    NavigationRailDestination(icon: Icon(Icons.notifications), label: Text('Notificaciones')),
  ];

  static const _pantallas = [
    FlotaScreen(),
    ClientesScreen(),
    OrdenesScreen(),
    SolicitudesScreen(),
    NotificacionesScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('GOMAQ - Panel de Gestion'),
        actions: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Center(child: Text('${auth.nombre ?? ''} (${auth.rol ?? ''})')),
          ),
          IconButton(icon: const Icon(Icons.logout), onPressed: () => auth.logout()),
        ],
      ),
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: _seccion,
            onDestinationSelected: (i) => setState(() => _seccion = i),
            labelType: NavigationRailLabelType.all,
            destinations: _destinos,
          ),
          const VerticalDivider(width: 1),
          Expanded(child: _pantallas[_seccion]),
        ],
      ),
    );
  }
}
