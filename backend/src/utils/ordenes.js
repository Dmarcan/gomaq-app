const pool = require('../config/db');

// verifica que una orden de trabajo exista y pertenezca al mecanico dado
async function verificarDuenoOrden(ordenId, mecanicoId) {
    const result = await pool.query('SELECT mecanico_id FROM ordenes_trabajo WHERE id = $1', [ordenId]);
    if (result.rows.length === 0) return { existe: false };
    return { existe: true, esDueno: result.rows[0].mecanico_id === mecanicoId };
}

/**
 * Canal y destinatario para avisarle a un cliente: WhatsApp si hay telefono, si no correo.
 * Devuelve null cuando no hay forma de contactarlo, y en ese caso simplemente no se encola
 * nada (la OT igual avanza: el aviso nunca bloquea el evento de negocio).
 *
 * Se usa desde /asignar (HU-07) y desde /finalizar, que son los dos momentos que el BPMN
 * del informe marca como notificables.
 */
async function contactoCliente(client, clienteId) {
    if (!clienteId) return null;
    const result = await client.query('SELECT telefono, email FROM clientes WHERE id = $1', [clienteId]);
    const cliente = result.rows[0];
    if (!cliente) return null;
    if (cliente.telefono) return { canal: 'whatsapp', destinatario: cliente.telefono };
    if (cliente.email) return { canal: 'email', destinatario: cliente.email };
    return null;
}

module.exports = { verificarDuenoOrden, contactoCliente };
