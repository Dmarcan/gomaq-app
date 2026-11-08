import 'package:flutter/widgets.dart';
import 'package:flutter_map/flutter_map.dart';

import 'enlaces.dart';

/// Servidor de mapas. OpenStreetMap sirve para un panel interno con pocos usuarios; si algún día
/// lo bloquean se cambia con --dart-define=GOMAQ_TILES_URL=... (y se agrega el dominio al CSP del
/// backend, server.js).
const urlTilesMapa = String.fromEnvironment('GOMAQ_TILES_URL', defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');

/// Capa de imágenes del mapa, con el identificador de la app que pide OpenStreetMap.
Widget capaTilesMapa() => TileLayer(
      urlTemplate: urlTilesMapa,
      userAgentPackageName: 'cl.gomaq.gomaq_panel',
    );

/// Atribución obligatoria de OpenStreetMap: siempre visible en cualquier mapa del panel.
Widget atribucionMapa() => RichAttributionWidget(
      attributions: [
        TextSourceAttribution('© OpenStreetMap contributors', onTap: () => abrirEnlace('https://www.openstreetmap.org/copyright')),
      ],
    );
