import 'package:url_launcher/url_launcher.dart';

/// Abre un enlace (PDF de guía o factura, ya con URL firmada completa) fuera de la app: en una
/// pestaña nueva en el navegador y en el navegador del teléfono en Android. Reemplaza el
/// `dart:html` que solo existe en la web y no dejaba compilar el panel a Android.
Future<void> abrirEnlace(String url) async {
  await launchUrl(
    Uri.parse(url),
    mode: LaunchMode.externalApplication,
    webOnlyWindowName: '_blank',
  );
}
