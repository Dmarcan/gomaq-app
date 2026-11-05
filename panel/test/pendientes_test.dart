import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/services/pendientes_service.dart';
import 'package:gomaq_web/utils/pendientes.dart';
import 'package:gomaq_web/widgets/bloque_pendientes.dart';

const _todos = <String, dynamic>{
  'mantencion_vencida': 2,
  'mantencion_proxima': 3,
  'ot_sin_asignar': 4,
  'asistencias_por_atender': 1,
  'avisos_con_problemas': 5,
  'por_facturar': 6,
  'arriendos_con_aviso': 7,
  'ot_por_valorizar': 8,
  'guias_sin_documento': 9,
  'descuadres': 10,
  'cuentas_por_aprobar': 11,
};

void main() {
  group('destinos de los pendientes', () {
    String destinoDe(String clave) => pendientesDefs.firstWhere((d) => d.clave == clave).destino;

    test('cada clave lleva a la lista de la que sale su número', () {
      expect(destinoDe('mantencion_vencida'), '/mantencion?filtro=vencida');
      expect(destinoDe('mantencion_proxima'), '/mantencion?filtro=proxima');
      expect(destinoDe('ot_sin_asignar'), '/ordenes?pestana=sin_asignar');
      expect(destinoDe('asistencias_por_atender'), '/asistencias?filtro=pendiente');
      expect(destinoDe('avisos_con_problemas'), '/notificaciones?filtro=problemas');
      expect(destinoDe('por_facturar'), '/facturacion');
      expect(destinoDe('arriendos_con_aviso'), '/facturacion?pestana=en_curso&filtro=aviso');
      expect(destinoDe('ot_por_valorizar'), '/facturacion?pestana=valorizar');
      expect(destinoDe('guias_sin_documento'), '/guias');
      expect(destinoDe('descuadres'), '/insumos?pestana=descuadres');
      expect(destinoDe('cuentas_por_aprobar'), '/cuentas');
    });

    test('hay un pendiente por cada clave del backend y sin repetidos', () {
      final claves = pendientesDefs.map((d) => d.clave).toList();
      expect(claves.toSet().length, claves.length);
      expect(claves.toSet(), _todos.keys.toSet());
    });

    test('destinoConFiltro codifica los valores', () {
      expect(destinoConFiltro('/x', {}), '/x');
      expect(destinoConFiltro('/x', {'a': 'b c', 'd': 'e&f'}), '/x?a=b+c&d=e%26f');
    });
  });

  group('pendientesVisibles', () {
    test('solo los mayores que 0, en orden de urgencia', () {
      final v = pendientesVisibles(_todos);
      expect(v.map((p) => p.def.clave).toList(), [
        'mantencion_vencida', 'ot_sin_asignar', 'asistencias_por_atender', 'avisos_con_problemas', 'por_facturar',
        'arriendos_con_aviso', 'ot_por_valorizar', 'guias_sin_documento', 'descuadres', 'cuentas_por_aprobar',
        'mantencion_proxima',
      ]);
      expect(v.first.cantidad, 2);
    });

    test('los ceros, los nulos y los textos se leen bien', () {
      final v = pendientesVisibles({'ot_sin_asignar': 0, 'descuadres': '3', 'por_facturar': null, 'guias_sin_documento': 2.0});
      expect(v.map((p) => (p.def.clave, p.cantidad)).toList(), [('guias_sin_documento', 2), ('descuadres', 3)]);
    });

    test('sin datos o todo en cero no hay pendientes', () {
      expect(pendientesVisibles(null), isEmpty);
      expect(pendientesVisibles({for (final d in pendientesDefs) d.clave: 0}), isEmpty);
    });

    test('la etiqueta concuerda con el número', () {
      final uno = pendientesVisibles({'guias_sin_documento': 1}).single;
      final dos = pendientesVisibles({'guias_sin_documento': 2}).single;
      expect(etiquetaPendiente(uno), 'Guía sin documento');
      expect(etiquetaPendiente(dos), 'Guías sin documento');
      // sin singular propio, se queda igual
      expect(etiquetaPendiente(pendientesVisibles({'por_facturar': 1}).single), 'Por facturar');
    });
  });

  group('contadores del menú', () {
    test('cada ítem con lista lleva el número de su clave', () {
      expect(contadorMenu('/mantencion', _todos), 2);
      expect(contadorMenu('/ordenes', _todos), 4);
      expect(contadorMenu('/asistencias', _todos), 1);
      expect(contadorMenu('/notificaciones', _todos), 5);
      expect(contadorMenu('/facturacion', _todos), 6);
      expect(contadorMenu('/guias', _todos), 9);
      expect(contadorMenu('/insumos', _todos), 10);
      expect(contadorMenu('/cuentas', _todos), 11);
    });

    test('un ítem sin contador, o sin datos, da 0', () {
      expect(contadorMenu('/flota', _todos), 0);
      expect(contadorMenu('/', _todos), 0);
      expect(contadorMenu('/ordenes', null), 0);
    });
  });


  group('lo que hace cada rol', () {
    test('lo del otro rol no se esconde: queda marcado y después de lo propio', () {
      final admin = pendientesVisibles(_todos, rol: 'administrativo');
      expect(admin.length, pendientesVisibles(_todos).length, reason: 'no se oculta nada');
      final claves = admin.map((p) => p.def.clave).toList();
      // lo que solo hace el Gerente (valorizar) va al final y marcado
      expect(claves.last, 'ot_por_valorizar');
      expect(admin.last.delOtroRol, isTrue);
      expect(etiquetaPendiente(admin.last), 'Reparaciones por valorizar (lo hace Gerente)');
      // lo propio conserva el orden de urgencia
      expect(claves.first, 'mantencion_vencida');
      expect(admin.where((p) => !p.delOtroRol).length, admin.length - 1);
    });

    test('el Gerente ve marcado lo que hace Administrativo', () {
      final gerente = pendientesVisibles(_todos, rol: 'gerente');
      final marcados = gerente.where((p) => p.delOtroRol).map((p) => p.def.clave).toSet();
      expect(marcados, {'ot_sin_asignar', 'por_facturar', 'arriendos_con_aviso', 'guias_sin_documento', 'descuadres'});
      final guias = gerente.firstWhere((p) => p.def.clave == 'guias_sin_documento');
      expect(etiquetaPendiente(guias), 'Guías sin documento (lo hace Administrativo)');
      // lo que pueden los dos no se marca
      expect(gerente.firstWhere((p) => p.def.clave == 'mantencion_vencida').delOtroRol, isFalse);
      // los marcados van todos después de los propios
      final primerMarcado = gerente.indexWhere((p) => p.delOtroRol);
      expect(gerente.sublist(primerMarcado).every((p) => p.delOtroRol), isTrue);
    });

    test('sin rol no se marca nada', () {
      expect(pendientesVisibles(_todos).any((p) => p.delOtroRol), isFalse);
    });
  });

  group('destino del menú', () {
    test('con pendientes lleva a la lista de la que sale el contador', () {
      expect(destinoMenu('/mantencion', _todos), '/mantencion?filtro=vencida');
      expect(destinoMenu('/insumos', _todos), '/insumos?pestana=descuadres');
      expect(destinoMenu('/ordenes', _todos), '/ordenes?pestana=sin_asignar');
      expect(destinoMenu('/notificaciones', _todos), '/notificaciones?filtro=problemas');
      expect(destinoMenu('/cuentas', _todos), '/cuentas');
    });

    test('sin pendientes, o sin contador, lleva a la sección de siempre', () {
      expect(destinoMenu('/mantencion', {'mantencion_vencida': 0}), '/mantencion');
      expect(destinoMenu('/insumos', null), '/insumos');
      expect(destinoMenu('/flota', _todos), '/flota');
    });
  });

  group('PendientesService', () {
    test('invalidar vuelve a pedir el dato, una sola vez para varias escrituras seguidas', () async {
      var pedidos = 0;
      final s = PendientesService(
        esperaInvalidar: const Duration(milliseconds: 20),
        pedir: () async {
          pedidos++;
          return {'ot_sin_asignar': pedidos};
        },
      );
      await s.cargar();
      expect(pedidos, 1);
      await s.cargar(); // vigente: no vuelve a pedir
      expect(pedidos, 1);
      s.invalidar();
      s.invalidar();
      s.invalidar();
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(pedidos, 2);
      expect(s.datos!['ot_sin_asignar'], 2);
      s.dispose();
    });

    test('un cargar forzado mientras hay otro en curso no se pierde', () async {
      var pedidos = 0;
      final puerta = Completer<void>();
      final s = PendientesService(pedir: () async {
        pedidos++;
        if (pedidos == 1) await puerta.future;
        return {'descuadres': pedidos};
      });
      final primero = s.cargar();
      await s.cargar(forzar: true); // llega mientras el primero espera
      expect(pedidos, 1);
      puerta.complete();
      await primero;
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(pedidos, 2, reason: 'se repitió al terminar');
      expect(s.datos!['descuadres'], 2);
      s.dispose();
    });

    test('la respuesta de la sesión anterior no repuebla tras limpiar', () async {
      final puerta = Completer<void>();
      final s = PendientesService(pedir: () async {
        await puerta.future;
        return {'por_facturar': 9};
      });
      final carga = s.cargar();
      s.limpiar(); // cierre de sesión mientras la consulta está en camino
      puerta.complete();
      await carga;
      expect(s.datos, isNull);
      expect(s.cargadoEn, isNull);
      expect(s.cargando, isFalse);
      s.dispose();
    });

    test('un error conserva el último dato y se puede reintentar', () async {
      var falla = false;
      final s = PendientesService(pedir: () async {
        if (falla) throw Exception('sin red');
        return {'guias_sin_documento': 3};
      });
      await s.cargar();
      falla = true;
      await s.cargar(forzar: true);
      expect(s.datos!['guias_sin_documento'], 3, reason: 'el dato viejo se conserva');
      expect(s.error, isNotNull);
      falla = false;
      await s.cargar(forzar: true);
      expect(s.error, isNull);
      s.dispose();
    });
  });

  group('BloquePendientes', () {
    Future<void> montar(WidgetTester t, PendientesService s, List<String> navegaciones, {double ancho = 1000}) async {
      t.view.physicalSize = Size(ancho, 800);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await t.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: BloquePendientes(
              compacto: ancho < 600,
              servicio: s,
              onNavegar: (ruta, {filtro}) => navegaciones.add(destinoConFiltro(ruta, filtro ?? {})),
            ),
          ),
        ),
      ));
    }

    testWidgets('muestra solo lo pendiente y cada tarjeta navega a su lista', (t) async {
      final s = PendientesService()..fijar(nuevos: {..._todos, 'ot_sin_asignar': 0, 'guias_sin_documento': 1});
      final nav = <String>[];
      await montar(t, s, nav);
      expect(find.text('PENDIENTES'), findsOneWidget);
      expect(find.text('Órdenes sin asignar'), findsNothing);
      expect(find.text('Guía sin documento'), findsOneWidget);
      await t.tap(find.text('Mantenciones vencidas'));
      await t.tap(find.text('Guía sin documento'));
      expect(nav, ['/mantencion?filtro=vencida', '/guias']);
    });

    testWidgets('con todo en cero dice Todo al día', (t) async {
      final s = PendientesService()..fijar(nuevos: {for (final d in pendientesDefs) d.clave: 0});
      await montar(t, s, []);
      expect(find.textContaining('Todo al día'), findsOneWidget);
    });

    testWidgets('sin datos muestra la carga, y con error un Reintentar', (t) async {
      final s = PendientesService();
      await montar(t, s, []);
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      s.fijar(mensajeError: 'Sin conexión');
      await t.pump();
      expect(find.textContaining('No se pudieron cargar los pendientes'), findsOneWidget);
      expect(find.text('Reintentar'), findsOneWidget);
    });

    testWidgets('con datos viejos y un error muestra el aviso y Reintentar', (t) async {
      final s = PendientesService()..fijar(nuevos: _todos);
      await montar(t, s, []);
      s.fijar(nuevos: _todos, mensajeError: 'Sin conexión');
      await t.pump();
      expect(find.textContaining('No se pudo actualizar'), findsOneWidget);
      expect(find.text('Reintentar'), findsOneWidget);
      // los números viejos siguen a la vista
      expect(find.text('Mantenciones vencidas'), findsOneWidget);
    });

    testWidgets('el rol marca lo que hace el otro, sin esconderlo', (t) async {
      final s = PendientesService()..fijar(nuevos: _todos);
      t.view.physicalSize = const Size(1000, 900);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await t.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: BloquePendientes(compacto: false, servicio: s, rol: 'gerente', onNavegar: (r, {filtro}) {}),
          ),
        ),
      ));
      expect(find.textContaining('(lo hace Administrativo)'), findsWidgets);
      expect(find.text('Reparaciones por valorizar'), findsOneWidget, reason: 'lo del Gerente no lleva marca');
    });

    testWidgets('a 375 px las tarjetas van de a dos y no desbordan', (t) async {
      final s = PendientesService()..fijar(nuevos: _todos);
      await montar(t, s, [], ancho: 375);
      expect(t.takeException(), isNull);
      final a = t.getTopLeft(find.text('Mantenciones vencidas')).dy;
      final b = t.getTopLeft(find.text('Órdenes sin asignar')).dy;
      expect(a, b, reason: 'las dos primeras comparten fila');
    });
  });
}
