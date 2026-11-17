import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/auth_service.dart';
import 'facturas_emitidas_tab.dart';

/// Facturas ya emitidas y su cobranza (vencidas, por vencer, pagadas, notas de crédito, exportar a Excel).
/// Antes era la pestaña "Emitidas" de Facturación; ahora tiene su propia entrada en el menú, porque emitir
/// y cobrar son dos tareas distintas.
class FacturasEmitidasScreen extends StatelessWidget {
  /// `vencidas` o `proximas` llegan desde las tarjetas de cobranza del inicio.
  final String? filtroInicial;
  const FacturasEmitidasScreen({super.key, this.filtroInicial});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: FacturasEmitidasTab(
        key: ValueKey('emitidas|$filtroInicial'),
        filtroInicial: filtroInicial,
        puedeEscribir: context.watch<AuthService>().esAdministrativo,
      ),
    );
  }
}
