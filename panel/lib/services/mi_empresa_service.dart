import 'api_client.dart';

/// Ficha de la empresa del cliente que inició sesión (`/api/clientes/mia`). La empresa la decide
/// el servidor por la cuenta: aquí nunca se manda un id de cliente.
class MiEmpresaService {
  const MiEmpresaService();

  Future<Map<String, dynamic>> cargar() async {
    final data = await ApiClient.instance.get('/api/clientes/mia');
    return Map<String, dynamic>.from(data as Map);
  }

  /// Envía solo los campos modificados; devuelve la ficha actualizada.
  Future<Map<String, dynamic>> guardar(Map<String, dynamic> cambios) async {
    final data = await ApiClient.instance.patch('/api/clientes/mia', cambios);
    return Map<String, dynamic>.from(data as Map);
  }
}
