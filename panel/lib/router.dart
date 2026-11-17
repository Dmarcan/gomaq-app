import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'services/auth_service.dart';
import 'screens/acceso/codigo_cuenta_screen.dart';
import 'screens/acceso/login_screen.dart';
import 'screens/acceso/registro_cliente_screen.dart';
import 'screens/panel/admin_dashboard_screen.dart';
import 'screens/cliente/cliente_portal_screen.dart';
import 'screens/acceso/rol_no_soportado_screen.dart';
import 'screens/panel/dashboard_screen.dart';
import 'screens/panel/flota_screen.dart';
import 'screens/panel/maquinaria_perfil_screen.dart';
import 'screens/panel/guias_screen.dart';
import 'screens/panel/facturacion_screen.dart';
import 'screens/panel/orden_detalle.dart' show OrdenDetalleScreen;
import 'screens/panel/cliente_historial_screen.dart';
import 'screens/panel/clientes_screen.dart';
import 'screens/panel/ordenes_screen.dart';
import 'screens/panel/solicitudes_screen.dart';
import 'screens/panel/notificaciones_screen.dart';
import 'screens/panel/insumos_screen.dart';
import 'screens/panel/horometro_screen.dart';
import 'screens/panel/rentabilidad_screen.dart';
import 'screens/panel/mapa_screen.dart';
import 'screens/panel/vehiculos_screen.dart';
import 'utils/pendientes.dart' show destinoConFiltro;
import 'widgets/estado_vacio.dart';

/// Rutas del panel.
///
/// Antes la navegacion era un `int _seccion` dentro del dashboard: la URL nunca cambiaba, asi
/// que F5 siempre volvia al inicio, el boton atras del navegador salia del panel y no se podia
/// compartir el enlace de una seccion. Era el punto 10 del "Que falta" del README.
///
/// Las secciones del panel viven dentro de un ShellRoute para que la barra lateral no se
/// reconstruya al cambiar de una a otra.

/// Una seccion del menu lateral, agrupada por area.
typedef ItemMenu = ({String ruta, IconData icono, String etiqueta, String grupo});

/// El menu eran 13 items planos. Pasado el septimo la gente deja de escanear y empieza a
/// buscar, asi que se agrupan por area de trabajo.
const List<ItemMenu> itemsMenu = [
  (ruta: '/', icono: Icons.dashboard, etiqueta: 'Inicio', grupo: 'Operación'),
  (ruta: '/flota', icono: Icons.local_shipping, etiqueta: 'Flota', grupo: 'Operación'),
  (ruta: '/mapa', icono: Icons.map_outlined, etiqueta: 'Mapa', grupo: 'Operación'),
  (ruta: '/ordenes', icono: Icons.assignment, etiqueta: 'Órdenes de Trabajo', grupo: 'Operación'),
  (ruta: '/asistencias', icono: Icons.support_agent, etiqueta: 'Asistencias', grupo: 'Operación'),
  // la mantención se calcula con las lecturas del horómetro; en el menú se llama por lo que se hace con ella
  (ruta: '/mantencion', icono: Icons.build_circle_outlined, etiqueta: 'Mantención', grupo: 'Operación'),

  (ruta: '/insumos', icono: Icons.inventory_2, etiqueta: 'Insumos', grupo: 'Inventario'),
  (ruta: '/vehiculos', icono: Icons.local_shipping_outlined, etiqueta: 'Vehículos', grupo: 'Inventario'),

  (ruta: '/guias', icono: Icons.description, etiqueta: 'Guías', grupo: 'Comercial'),
  (ruta: '/facturacion', icono: Icons.receipt_long, etiqueta: 'Facturación', grupo: 'Comercial'),
  (ruta: '/costos', icono: Icons.trending_up, etiqueta: 'Costo por equipo', grupo: 'Comercial'),
  (ruta: '/clientes', icono: Icons.people, etiqueta: 'Clientes', grupo: 'Comercial'),
  (ruta: '/cuentas', icono: Icons.how_to_reg_outlined, etiqueta: 'Cuentas por aprobar', grupo: 'Comercial'),

  (ruta: '/notificaciones', icono: Icons.notifications, etiqueta: 'Notificaciones', grupo: 'Administración'),
];

/// Rutas que se ven sin sesion. Con la sesion iniciada redirigen al inicio de cada rol.
const rutasPublicas = {'/login', '/registro', '/activar', '/recuperar'};

GoRouter construirRouter(AuthService auth) {
  // Sin esto, context.push('/flota/12') abre el perfil pero la barra de direcciones sigue en
  // /flota: F5 o compartir el enlace volverian a la lista. Con la opcion activa la URL sigue
  // tambien a las navegaciones con push, que Flota usa para conservar su pestana y filtros.
  GoRouter.optionURLReflectsImperativeAPIs = true;

  return GoRouter(
    // reevalua el redirect cuando cambia la sesion (login, logout, token vencido)
    refreshListenable: auth,
    initialLocation: '/',
    redirect: (context, estado) {
      // mientras se restaura la sesion guardada no se decide nada, o se mandaria al login
      // a alguien que si tiene sesion valida
      if (auth.verificandoSesion) return null;

      // pantallas publicas: el login, el registro de clientes (antes el registro se abria con
      // Navigator.push sobre /login, asi que recargar la pagina borraba lo escrito) y el canje de los
      // codigos de la cuenta (activar una invitacion, recuperar la contrasena)
      final yendoALogin = rutasPublicas.contains(estado.matchedLocation);
      if (!auth.autenticado) return yendoALogin ? null : '/login';

      // enrutado por rol: solo los roles con interfaz web entran a sus pantallas;
      // al mecanico se le explica en vez de mostrarle un panel que no le sirve
      final destino = auth.esCliente
          ? '/portal'
          : (auth.esAdministrativo || auth.esGerente)
              ? null // el panel completo
              : '/rol-no-soportado';

      if (destino != null && estado.matchedLocation != destino) return destino;
      if (destino == null && (yendoALogin || estado.matchedLocation == '/portal')) return '/';
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/registro', builder: (_, _) => const RegistroClienteScreen()),
      GoRoute(path: '/activar', builder: (_, _) => const CodigoCuentaScreen(modo: ModoCodigo.activar)),
      GoRoute(path: '/recuperar', builder: (_, _) => const CodigoCuentaScreen(modo: ModoCodigo.recuperar)),
      GoRoute(
        path: '/portal',
        // la llave lleva toda la query: pedir una asistencia navega a ?pestana=seguimiento&r=... y la
        // pantalla se remonta, abre en Seguimiento y vuelve a cargar
        builder: (_, estado) => ClientePortalScreen(
          key: ValueKey(estado.uri.query),
          pestanaInicial: estado.uri.queryParameters['pestana'],
        ),
      ),
      GoRoute(path: '/rol-no-soportado', builder: (_, _) => const RolNoSoportadoScreen()),

      // el shell mantiene la barra lateral montada entre secciones
      ShellRoute(
        builder: (context, estado, hijo) => AdminDashboardScreen(rutaActual: estado.uri.path, child: hijo),
        routes: [
          GoRoute(
            path: '/',
            builder: (context, estado) => DashboardScreen(
              // el dashboard navega a Flota ya filtrada; el filtro viaja en la URL, asi que
              // ese estado tambien se puede compartir y sobrevive a un F5
              onNavegar: (ruta, {Map<String, String>? filtro}) {
                final query = (filtro == null || filtro.isEmpty)
                    ? ''
                    : '?${filtro.entries.map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}').join('&')}';
                context.go('$ruta$query');
              },
            ),
          ),
          GoRoute(
            path: '/flota',
            builder: (context, estado) {
              final p = estado.uri.queryParameters;
              return FlotaScreen(
                // la key fuerza recargar cuando cambia el filtro que llega por la URL
                key: ValueKey(estado.uri.query),
                filtroInicial: p.isEmpty ? null : {...p},
              );
            },
          ),
          GoRoute(
            // el perfil de un equipo tiene URL propia: F5 y los enlaces compartidos vuelven a el
            // (antes se abria con Navigator.push y recargar la pagina lo perdia)
            path: '/flota/:id',
            builder: (context, estado) {
              final id = int.tryParse(estado.pathParameters['id'] ?? '');
              if (id == null) {
                return const EstadoVacio(
                  icono: Icons.search_off,
                  titulo: 'No encontramos ese equipo',
                  mensaje: 'El enlace no corresponde a un equipo. Vuelve a Flota y elígelo de la lista.',
                );
              }
              return MaquinariaPerfilScreen(
                key: ValueKey(id),
                maquinariaId: id,
                pestanaInicial: estado.uri.queryParameters['pestana'] ?? 'resumen',
              );
            },
          ),
          GoRoute(
            path: '/ordenes',
            // sin key por la consulta: OrdenesScreen limpia ?nueva=1 apenas abre el formulario,
            // y una key nueva la volvería a montar y cerraría el formulario recién abierto
            builder: (_, estado) => OrdenesScreen(
              abrirNueva: estado.uri.queryParameters['nueva'] == '1',
              // llega desde "Crear orden de trabajo" en el perfil de un equipo
              maquinariaInicial: int.tryParse(estado.uri.queryParameters['maquinaria'] ?? ''),
              pestanaInicial: estado.uri.queryParameters['pestana'],
            ),
            routes: [
              // detalle de una orden como página: /ordenes/12 (se puede recargar y compartir)
              GoRoute(
                path: ':id',
                // un id que no es número, 0 o negativo lo resuelve la propia pantalla ('No encontramos esa orden')
                builder: (_, estado) {
                  final id = int.tryParse(estado.pathParameters['id'] ?? '');
                  return OrdenDetalleScreen(key: ValueKey(id), id: id);
                },
              ),
            ],
          ),
          // Asignación se integró en Órdenes (pestaña "Sin asignar")
          GoRoute(path: '/asignacion', redirect: (_, _) => '/ordenes?pestana=sin_asignar'),
          GoRoute(
            path: '/asistencias',
            // la llave lleva la consulta: llegar con otro filtro desde el dashboard recarga la lista
            builder: (_, estado) => SolicitudesScreen(
              key: ValueKey(estado.uri.query),
              filtroInicial: estado.uri.queryParameters['filtro'],
            ),
          ),
          GoRoute(
            path: '/insumos',
            builder: (_, estado) => InsumosScreen(
              key: ValueKey(estado.uri.query),
              pestanaInicial: estado.uri.queryParameters['pestana'],
            ),
          ),
          GoRoute(
            path: '/mantencion',
            builder: (_, estado) => HorometroScreen(
              key: ValueKey(estado.uri.query),
              filtroInicial: estado.uri.queryParameters['filtro'],
            ),
          ),
          // el Horómetro pasó a llamarse Mantención: los enlaces guardados siguen funcionando
          GoRoute(path: '/horometro', redirect: (_, estado) => destinoConFiltro('/mantencion', estado.uri.queryParameters)),
          GoRoute(path: '/mapa', builder: (_, _) => const MapaScreen()),
          GoRoute(path: '/vehiculos', builder: (_, _) => const VehiculosScreen()),
          GoRoute(path: '/guias', builder: (_, _) => const GuiasScreen()),
          GoRoute(
            path: '/facturacion',
            // la key sigue solo al filtro: cambiar de pestaña actualiza la URL sin reconstruir la
            // pantalla (la pestaña nueva la toma didUpdateWidget); un filtro nuevo sí la reabre
            builder: (_, estado) => FacturacionScreen(
              key: ValueKey('facturacion|${estado.uri.queryParameters['filtro']}'),
              pestanaInicial: estado.uri.queryParameters['pestana'],
              filtroInicial: estado.uri.queryParameters['filtro'],
            ),
          ),
          GoRoute(path: '/costos', builder: (_, _) => const RentabilidadScreen()),
          GoRoute(path: '/clientes', builder: (_, _) => const ClientesScreen()),
          // historial de un cliente: lo que arrendó y facturó (se puede recargar y compartir)
          GoRoute(
            path: '/clientes/:id',
            builder: (_, estado) {
              final id = int.tryParse(estado.pathParameters['id'] ?? '');
              return HistorialDeClienteScreen(key: ValueKey(id), id: id);
            },
          ),
          // Cuentas por aprobar es la segunda pestaña de Clientes, con su propia entrada en el menú
          GoRoute(path: '/cuentas', builder: (_, _) => const ClientesScreen(pestanaInicial: 'cuentas')),
          GoRoute(
            path: '/notificaciones',
            builder: (_, estado) => NotificacionesScreen(
              key: ValueKey(estado.uri.query),
              filtroInicial: estado.uri.queryParameters['filtro'],
            ),
          ),
        ],
      ),
    ],
  );
}
