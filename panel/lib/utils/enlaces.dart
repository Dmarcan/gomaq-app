import 'package:url_launcher/url_launcher.dart';

/// Abre un enlace (PDF de guia o factura, con URL firmada completa) fuera de la app: en una pestana
/// nueva en la web y en el navegador del telefono en Android. No usa dart:html para que el panel
/// compile tambien a Android.
Future<void> abrirEnlace(String url) async {
  await launchUrl(
    Uri.parse(url),
    mode: LaunchMode.externalApplication,
    webOnlyWindowName: '_blank',
  );
}
