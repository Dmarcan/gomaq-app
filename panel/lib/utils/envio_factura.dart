// Cuerpo de `POST /api/facturacion/:id/autorizar-envio`. Lógica pura, para probar qué se manda al servidor
// sin armar el cuadro entero (panel/test/envio_factura_test.dart).

/// Lo que se manda al autorizar el envío del correo de una factura.
///
/// - [asunto] y [cuerpo] solo van si la persona los cambió (si coinciden con lo que propuso el servidor, él los
///   arma de nuevo con los datos vigentes de la factura). Aquí llegan ya como null cuando no cambiaron.
/// - [fotos]: las fotos del antes y el después que van adjuntas. Null = el cuadro no pudo cargarlas: no se manda
///   la clave y el servidor repite la selección del último correo (si lo hubo). Una lista vacía significa
///   "sin fotos" y el servidor la respeta. Los ids van ordenados, para que el cuerpo no dependa de cómo se
///   marcaron.
Map<String, dynamic> cuerpoAutorizacionEnvio({String? asunto, String? cuerpo, Set<int>? fotos}) => {
      'asunto': ?asunto,
      'cuerpo': ?cuerpo,
      if (fotos != null) 'foto_ids': (fotos.toList()..sort()),
    };
