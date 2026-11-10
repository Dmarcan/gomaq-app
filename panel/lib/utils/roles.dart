/// Roles internos con su nombre legible, para listas y menús.
const rolesInternos = {
  'mecanico': 'Mecánico',
  'administrativo': 'Administrativo',
  'gerente': 'Gerente',
};

/// Nombre legible de un rol ("mecanico" -> "Mecánico"). Un rol desconocido se muestra tal cual.
String nombreRol(dynamic rol) => rolesInternos[rol] ?? '$rol';
