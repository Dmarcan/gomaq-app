import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../theme/gomaq_theme.dart';
import 'dashboard_screen.dart';
import 'flota_screen.dart';
import 'guias_screen.dart';
import 'facturacion_screen.dart';
import 'asignacion_screen.dart';
import 'clientes_screen.dart';
import 'ordenes_screen.dart';
import 'solicitudes_screen.dart';
import 'notificaciones_screen.dart';
import 'insumos_screen.dart';

class AdminDashboardScreen extends StatefulWidget {
  const AdminDashboardScreen({super.key});

  @override
  State<AdminDashboardScreen> createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  int _seccion = 0;
  Map<String, dynamic>? _filtroFlota;

  static const _items = [
    (icon: Icons.dashboard, label: 'Dashboard'),
    (icon: Icons.local_shipping, label: 'Flota'),
    (icon: Icons.description, label: 'Guías'),
    (icon: Icons.receipt_long, label: 'Facturación'),
    (icon: Icons.build, label: 'Asignación'),
    (icon: Icons.assignment, label: 'Ordenes de Trabajo'),
    (icon: Icons.people, label: 'Clientes'),
    (icon: Icons.support_agent, label: 'Solicitudes'),
    (icon: Icons.notifications, label: 'Notificaciones'),
    (icon: Icons.inventory_2, label: 'Insumos'),
  ];

  List<Widget> get _pantallas => [
        DashboardScreen(
          onNavegar: (i, {filtro}) => setState(() {
            _seccion = i;
            _filtroFlota = filtro;
          }),
        ),
        FlotaScreen(key: ValueKey(_filtroFlota?.toString() ?? 'sin-filtro'), filtroInicial: _filtroFlota),
        const GuiasScreen(),
        const FacturacionScreen(),
        const AsignacionScreen(),
        const OrdenesScreen(),
        const ClientesScreen(),
        const SolicitudesScreen(),
        const NotificacionesScreen(),
        const InsumosScreen(),
      ];

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return Scaffold(
      body: Row(
        children: [
          Container(
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
                      const Text('GOMAQ Panel', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
                    ],
                  ),
                ),
                const Divider(color: Colors.white24, height: 1),
                const SizedBox(height: 12),
                Expanded(
                  child: ListView(
                    padding: EdgeInsets.zero,
                    children: [for (var i = 0; i < _items.length; i++) _itemMenu(i)],
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
                            Text(auth.nombre ?? '', style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
                            Text(auth.rol ?? '', style: const TextStyle(color: Colors.white54, fontSize: 11)),
                          ],
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.logout, color: Colors.white70, size: 18),
                        onPressed: () => auth.logout(),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
                  child: Text(_items[_seccion].label, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                ),
                Expanded(child: _pantallas[_seccion]),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _itemMenu(int i) {
    final activo = i == _seccion;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: Material(
        color: activo ? GomaqColors.sidebarResaltado : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => setState(() {
            _seccion = i;
            _filtroFlota = null;
          }),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            child: Row(
              children: [
                Icon(_items[i].icon, color: activo ? GomaqColors.primario : Colors.white70, size: 20),
                const SizedBox(width: 12),
                Text(
                  _items[i].label,
                  style: TextStyle(color: activo ? Colors.white : Colors.white70, fontSize: 13),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
