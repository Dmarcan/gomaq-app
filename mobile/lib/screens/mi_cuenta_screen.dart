import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import '../db/local_database.dart';
import '../services/api_client.dart';
import '../services/connectivity_service.dart';
import '../theme/gomaq_theme.dart';

/// Mi cuenta: los datos del mecanico y de su furgon asignado.
///
/// El RUT no es un dato de adorno: lo pide el bloque de firmas del talonario en papel, y se le
/// muestra al cliente en el aviso previo a la visita (HU-07) para que porteria pueda validar
/// quien entra a la planta. Por eso la pantalla dice explicitamente que sale de la empresa.
class MiCuentaScreen extends StatefulWidget {
  const MiCuentaScreen({super.key});

  @override
  State<MiCuentaScreen> createState() => _MiCuentaScreenState();
}

class _MiCuentaScreenState extends State<MiCuentaScreen> {
  Map<String, dynamic>? _perfil;
  Map<String, dynamic>? _vehiculo;
  List<dynamic> _documentos = [];
  final _rutCtrl = TextEditingController();
  final _telefonoCtrl = TextEditingController();
  final _kmCtrl = TextEditingController();
  bool _cargando = true;
  bool _guardando = false;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  @override
  void dispose() {
    _rutCtrl.dispose();
    _telefonoCtrl.dispose();
    _kmCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargar() async {
    final db = await LocalDatabase.instance.database;
    final perfil = await db.query('mi_perfil_local', limit: 1);
    final vehiculo = await db.query('mi_vehiculo_local', limit: 1);
    if (!mounted) return;
    setState(() {
      _perfil = perfil.isEmpty ? null : perfil.first;
      _vehiculo = vehiculo.isEmpty ? null : vehiculo.first;
      _rutCtrl.text = _perfil?['rut']?.toString() ?? '';
      _telefonoCtrl.text = _perfil?['telefono_whatsapp']?.toString() ?? '';
      _kmCtrl.text = _vehiculo?['kilometraje']?.toString() ?? '';
      _cargando = false;
    });
    // los documentos viven solo en el servidor: no tiene sentido cachear PDFs del vehiculo
    if (_vehiculo != null && mounted && context.read<ConnectivityService>().online) {
      try {
        final mio = await ApiClient.instance.get('/api/vehiculos/mio');
        if (mounted) setState(() => _documentos = mio['documentos'] ?? []);
      } on ApiException catch (_) {}
    }
  }

  Future<void> _guardarPerfil() async {
    setState(() => _guardando = true);
    try {
      await ApiClient.instance.patch('/api/usuarios/mi-perfil', {
        'rut': _rutCtrl.text.trim(),
        'telefono_whatsapp': _telefonoCtrl.text.trim(),
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Datos guardados')));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Future<void> _guardarKilometraje() async {
    final km = int.tryParse(_kmCtrl.text.trim().replaceAll('.', ''));
    if (km == null || km < 0) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ingresa un kilometraje válido')));
      return;
    }
    setState(() => _guardando = true);
    try {
      await ApiClient.instance.patch('/api/vehiculos/mio', {'kilometraje': km});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Kilometraje actualizado')));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  /// El mecanico fotografia el documento (permiso de circulacion, revision tecnica...).
  /// Se usa camara o galeria y no un selector de archivos, porque es el gesto natural en
  /// terreno y `image_picker` ya es dependencia de la app.
  Future<void> _subirDocumento(String tipo, ImageSource origen) async {
    final foto = await ImagePicker().pickImage(source: origen, imageQuality: 85);
    if (foto == null || !mounted) return;
    setState(() => _guardando = true);
    try {
      await ApiClient.instance.postMultipart(
        '/api/vehiculos/${_vehiculo!['id']}/documentos',
        bytes: await foto.readAsBytes(),
        filename: foto.name,
        fields: {'tipo': tipo},
      );
      await _cargar();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Documento subido')));
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: ${e.message}')));
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  Future<void> _elegirOrigen(String tipo) async {
    final origen = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt_outlined),
              title: const Text('Tomar foto del documento'),
              onTap: () => Navigator.pop(sheetContext, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Elegir de la galería'),
              onTap: () => Navigator.pop(sheetContext, ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (origen != null) await _subirDocumento(tipo, origen);
  }

  @override
  Widget build(BuildContext context) {
    final online = context.watch<ConnectivityService>().online;
    return Scaffold(
      appBar: AppBar(title: const Text('Mi cuenta')),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _cargar,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _tarjetaPerfil(online),
                  const SizedBox(height: 8),
                  _tarjetaVehiculo(online),
                ],
              ),
            ),
    );
  }

  Widget _tarjetaPerfil(bool online) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('MIS DATOS',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 8),
            Text(_perfil?['nombre']?.toString() ?? '-',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            Text(_perfil?['email']?.toString() ?? '-',
                style: const TextStyle(fontSize: 13, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 12),
            TextField(
              controller: _rutCtrl,
              decoration: const InputDecoration(labelText: 'RUT', hintText: '12.345.678-9'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _telefonoCtrl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Teléfono / WhatsApp'),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: (_guardando || !online) ? null : _guardarPerfil,
                icon: const Icon(Icons.save_outlined, size: 18),
                label: Text(online ? 'GUARDAR' : 'SIN SEÑAL PARA GUARDAR'),
              ),
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: GomaqColors.superficieElevada,
                borderRadius: BorderRadius.circular(6),
              ),
              child: const Text(
                'Al cliente se le avisa quién va a atender su equipo: se le muestran tu nombre, tu RUT '
                'y la marca, modelo y patente de tu furgón. Tu teléfono y correo no se le envían.',
                style: TextStyle(fontSize: 12, color: GomaqColors.textoSecundario),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tarjetaVehiculo(bool online) {
    final v = _vehiculo;
    if (v == null) {
      return const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text(
            'Todavía no tienes un furgón asignado. Lo asigna Administración desde el panel.',
            style: TextStyle(color: GomaqColors.textoSecundario),
          ),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('MI VEHÍCULO',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            const SizedBox(height: 8),
            Text(v['patente']?.toString() ?? '-',
                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, letterSpacing: 1)),
            Text(
              [v['marca'], v['modelo'], v['anio']].where((x) => x != null).join(' · '),
              style: const TextStyle(fontSize: 14, color: GomaqColors.textoSecundario),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _kmCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Kilometraje'),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: (_guardando || !online) ? null : _guardarKilometraje,
                  child: const Text('Actualizar'),
                ),
              ],
            ),
            const SizedBox(height: 16),
            const Text('DOCUMENTOS',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: GomaqColors.textoSecundario)),
            if (_documentos.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('Sin documentos cargados', style: TextStyle(color: GomaqColors.textoSecundario)),
              )
            else
              for (final d in _documentos)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.description_outlined, size: 20),
                  title: Text(d['nombre']?.toString() ?? 'Documento', style: const TextStyle(fontSize: 14)),
                  subtitle: Text(_etiquetaTipo(d['tipo']), style: const TextStyle(fontSize: 12)),
                ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                for (final (tipo, etiqueta) in const [
                  ('permiso_circulacion', 'Permiso de circulación'),
                  ('revision_tecnica', 'Revisión técnica'),
                  ('seguro', 'Seguro'),
                  ('otro', 'Otro'),
                ])
                  OutlinedButton(
                    onPressed: (_guardando || !online) ? null : () => _elegirOrigen(tipo),
                    child: Text(etiqueta, style: const TextStyle(fontSize: 12)),
                  ),
              ],
            ),
            if (!online)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('Necesitas señal para subir documentos.',
                    style: TextStyle(fontSize: 12, color: GomaqColors.estadoAdvertencia)),
              ),
          ],
        ),
      ),
    );
  }

  String _etiquetaTipo(dynamic tipo) {
    switch (tipo) {
      case 'permiso_circulacion':
        return 'Permiso de circulación';
      case 'revision_tecnica':
        return 'Revisión técnica';
      case 'seguro':
        return 'Seguro';
      case 'padron':
        return 'Padrón';
      default:
        return 'Otro';
    }
  }
}
