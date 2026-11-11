import 'formato.dart';

/// Texto del estado de la invitación de una cuenta que aún no la acepta (`usuario['invitacion']`, que
/// arma GET /api/usuarios). Va en texto y no solo en color (WCAG 1.4.1).
String textoEstadoInvitacion(Map<String, dynamic>? invitacion) {
  switch (invitacion?['estado']) {
    case 'vigente':
      final vence = Formato.diaMesHora(invitacion!['vence_at']);
      if (invitacion['canal'] == 'correo' && invitacion['enviado'] != true) {
        return 'Invitación sin enviar (falló el correo): copia un mensaje nuevo';
      }
      return 'Invitación pendiente, vence el $vence';
    case 'vencida':
      return 'Invitación vencida: genera un código nuevo';
    case 'bloqueada':
      return 'Invitación bloqueada por intentos fallidos: genera un código nuevo';
    default:
      return 'Sin invitación vigente: genera un código nuevo';
  }
}

/// Si la invitación ya no sirve y hay que generar otra (se destaca en la lista).
bool invitacionRequiereAccion(Map<String, dynamic>? invitacion) =>
    invitacion?['estado'] != 'vigente' || (invitacion?['canal'] == 'correo' && invitacion?['enviado'] != true);
