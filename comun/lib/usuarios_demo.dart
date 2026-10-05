// Usuarios de prueba para el inicio rapido del panel y de terreno. Se crean en la base con
// `node scripts/usuarios-demo.js crear` (backend/) y se borran con `... borrar`.
//
// SOLO PARA PRUEBAS: son credenciales conocidas por quien lea el repositorio. Antes de usar el
// sistema con datos reales hay que borrar estos usuarios y quitar los botones de inicio rapido
// (ver docs/informe/PENDIENTES.md). Si se cambia algo aca, cambiarlo tambien en
// backend/scripts/usuarios-demo.js.

class UsuarioDemo {
  final String rotulo;
  final String email;
  final String clave;
  const UsuarioDemo(this.rotulo, this.email, this.clave);
}

const usuarioDemoAdministrativo = UsuarioDemo('Administrativo', 'demo.admin@gomaq.demo', 'clave-demo-retirada');
const usuarioDemoMecanico = UsuarioDemo('Mecánico', 'demo.mecanico@gomaq.demo', 'clave-demo-retirada');
const usuarioDemoCliente = UsuarioDemo('Cliente', 'demo.cliente@gomaq.demo', 'clave-demo-retirada');
