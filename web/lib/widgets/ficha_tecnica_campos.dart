import 'package:flutter/material.dart';

const categoriasEquipo = [
  (valor: 'grua_horquilla', etiqueta: 'Grúa Horquilla'),
  (valor: 'alzahombre', etiqueta: 'Alzahombre'),
  (valor: 'transpaleta', etiqueta: 'Transpaleta'),
  (valor: 'apilador', etiqueta: 'Apilador'),
];

const combustiblesEquipo = [
  (valor: 'electrica', etiqueta: 'Eléctrica'),
  (valor: 'gas', etiqueta: 'Gas'),
  (valor: 'gasolina', etiqueta: 'Gasolina'),
  (valor: 'diesel', etiqueta: 'Diésel'),
];

const etiquetasCategoria = {
  'grua_horquilla': 'Grúa Horquilla',
  'alzahombre': 'Alzahombre',
  'transpaleta': 'Transpaleta',
  'apilador': 'Apilador',
};

const etiquetasCombustible = {
  'electrica': 'Eléctrica',
  'gas': 'Gas',
  'gasolina': 'Gasolina',
  'diesel': 'Diésel',
};

IconData iconoCategoria(String? categoria) {
  switch (categoria) {
    case 'grua_horquilla':
      return Icons.precision_manufacturing;
    case 'alzahombre':
      return Icons.height;
    case 'transpaleta':
      return Icons.local_shipping;
    case 'apilador':
      return Icons.inventory_2;
    default:
      return Icons.precision_manufacturing;
  }
}

bool mostrarCapacidad(String? categoria) => categoria == null || categoria == 'grua_horquilla' || categoria == 'transpaleta' || categoria == 'apilador';
bool mostrarMastil(String? categoria) => categoria == null || categoria == 'grua_horquilla';
bool mostrarCombustible(String? categoria) => categoria == null || categoria == 'grua_horquilla' || categoria == 'alzahombre';
bool mostrarMotorChasis(String? categoria) => categoria == null || categoria == 'grua_horquilla' || categoria == 'alzahombre';
bool mostrarAltura(String? categoria) => categoria == null || categoria == 'alzahombre';

/// Campos de ficha tecnica que se muestran u ocultan segun la categoria elegida
/// (grua horquilla / alzahombre / transpaleta / apilador piden datos distintos). Se usa tanto
/// en el dialogo de creacion (FlotaScreen) como en el de edicion (MaquinariaPerfilScreen)
/// para no duplicar esta logica en dos lugares.
List<Widget> camposFichaTecnica({
  required String? categoria,
  required String? combustible,
  required void Function(String?) onCombustibleChanged,
  required TextEditingController marcaCtrl,
  required TextEditingController modeloCtrl,
  required TextEditingController anioCtrl,
  required TextEditingController capacidadCargaCtrl,
  required TextEditingController alturaTrabajoCtrl,
  required TextEditingController numeroMastilCtrl,
  required TextEditingController numeroMotorCtrl,
  required TextEditingController numeroChasisCtrl,
  required TextEditingController numeroSerieCtrl,
  required TextEditingController descripcionCtrl,
}) {
  return [
    TextField(controller: marcaCtrl, decoration: const InputDecoration(labelText: 'Marca')),
    TextField(controller: modeloCtrl, decoration: const InputDecoration(labelText: 'Modelo')),
    TextField(controller: anioCtrl, decoration: const InputDecoration(labelText: 'Año'), keyboardType: TextInputType.number),
    if (mostrarCapacidad(categoria))
      TextField(
        controller: capacidadCargaCtrl,
        decoration: const InputDecoration(labelText: 'Capacidad de carga (kg)'),
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
      ),
    if (mostrarAltura(categoria))
      TextField(
        controller: alturaTrabajoCtrl,
        decoration: const InputDecoration(labelText: 'Altura de trabajo (m)'),
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
      ),
    if (mostrarMastil(categoria))
      TextField(controller: numeroMastilCtrl, decoration: const InputDecoration(labelText: 'N° de mástil')),
    if (mostrarCombustible(categoria))
      DropdownButtonFormField<String>(
        initialValue: combustible,
        decoration: const InputDecoration(labelText: 'Combustible'),
        items: [for (final c in combustiblesEquipo) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
        onChanged: onCombustibleChanged,
      ),
    if (mostrarMotorChasis(categoria)) ...[
      TextField(controller: numeroMotorCtrl, decoration: const InputDecoration(labelText: 'N° de motor')),
      TextField(controller: numeroChasisCtrl, decoration: const InputDecoration(labelText: 'N° de chasis')),
    ],
    TextField(controller: numeroSerieCtrl, decoration: const InputDecoration(labelText: 'N° de serie')),
    TextField(controller: descripcionCtrl, decoration: const InputDecoration(labelText: 'Descripción'), maxLines: 2),
  ];
}
