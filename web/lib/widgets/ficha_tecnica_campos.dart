import 'package:flutter/material.dart';
import 'dialogos.dart';

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
///
/// Los campos van de a dos por fila: en una columna angosta, once campos apilados obligaban a
/// desplazarse para llegar al final.
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
  final celdas = <Widget>[
    TextFormField(controller: marcaCtrl, decoration: decoracionCampo('Marca')),
    TextFormField(controller: modeloCtrl, decoration: decoracionCampo('Modelo')),
    TextFormField(
      controller: anioCtrl,
      keyboardType: TextInputType.number,
      decoration: decoracionCampo('Año'),
      validator: _validarAnio,
    ),
    TextFormField(controller: numeroSerieCtrl, decoration: decoracionCampo('N° de serie')),
    if (mostrarCapacidad(categoria))
      TextFormField(
        controller: capacidadCargaCtrl,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        decoration: decoracionCampo('Capacidad de carga', sufijo: 'kg'),
        validator: numeroOpcional('Escribe un número válido, por ejemplo 2500.'),
      ),
    if (mostrarAltura(categoria))
      TextFormField(
        controller: alturaTrabajoCtrl,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        decoration: decoracionCampo('Altura de trabajo', sufijo: 'm'),
        validator: numeroOpcional('Escribe un número válido, por ejemplo 7,8.'),
      ),
    if (mostrarCombustible(categoria))
      DropdownButtonFormField<String>(
        initialValue: combustible,
        isExpanded: true,
        decoration: decoracionCampo('Combustible'),
        items: [for (final c in combustiblesEquipo) DropdownMenuItem(value: c.valor, child: Text(c.etiqueta))],
        onChanged: onCombustibleChanged,
      ),
    if (mostrarMastil(categoria)) TextFormField(controller: numeroMastilCtrl, decoration: decoracionCampo('N° de mástil')),
    if (mostrarMotorChasis(categoria)) ...[
      TextFormField(controller: numeroMotorCtrl, decoration: decoracionCampo('N° de motor')),
      TextFormField(controller: numeroChasisCtrl, decoration: decoracionCampo('N° de chasis')),
    ],
  ];

  return [
    for (var i = 0; i < celdas.length; i += 2) ...[
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: celdas[i]),
          const SizedBox(width: 12),
          // una celda sola queda a media fila, con el mismo ancho que las demás
          Expanded(child: i + 1 < celdas.length ? celdas[i + 1] : const SizedBox.shrink()),
        ],
      ),
      separadorCampos,
    ],
    TextFormField(
      controller: descripcionCtrl,
      minLines: 2,
      maxLines: 4,
      decoration: decoracionCampo('Descripción', ayuda: 'Cualquier dato que ayude a distinguir el equipo.'),
    ),
  ];
}

/// El año es opcional, pero si se escribe tiene que ser uno posible para un equipo.
String? _validarAnio(String? v) {
  if (v == null || v.trim().isEmpty) return null;
  final anio = int.tryParse(v.trim());
  final maximo = DateTime.now().year + 1;
  if (anio == null || anio < 1950 || anio > maximo) return 'Escribe un año entre 1950 y $maximo.';
  return null;
}
