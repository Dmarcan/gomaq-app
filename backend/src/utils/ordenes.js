const pool = require('../config/db');

const { mecanicoPuedeEditar } = require('./estadosOt');

// verifica que una orden de trabajo exista y pertenezca al mecanico dado. Devuelve tambien el
// estado y si el mecanico todavia puede modificarla (no, una vez finalizada).
// `db` es el cliente de una transaccion en curso, y `bloquear` toma la fila con FOR NO KEY UPDATE (no FOR UPDATE: ver utils/estadoEquipo.js): lo usa
// quien necesita que el estado leido siga siendo el real hasta el COMMIT (ver /diagnostico).
async function verificarDuenoOrden(ordenId, mecanicoId, { db = pool, bloquear = false } = {}) {
    const result = await db.query(
        `SELECT mecanico_id, estado, fecha_creacion, uuid_cliente FROM ordenes_trabajo WHERE id = $1${bloquear ? ' FOR NO KEY UPDATE' : ''}`,
        [ordenId]
    );
    if (result.rows.length === 0) return { existe: false };
    const { mecanico_id: dueno, estado, fecha_creacion: creadaEn, uuid_cliente: uuidOt } = result.rows[0];
    // una OT creada por el mecanico en terreno (con uuid_cliente) lleva como fecha de creacion la
    // hora en que llego al servidor, no la del telefono
    return {
        existe: true, esDueno: dueno === mecanicoId, estado, creadaEn, nacioPorSincronizacion: Boolean(uuidOt),
        editable: mecanicoPuedeEditar(estado),
    };
}

/** Respuesta comun cuando el mecanico intenta modificar una OT ya cerrada. */
const MENSAJE_OT_CERRADA = 'La orden ya está cerrada y no se puede modificar';

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

// Predicados que comparten una lista y el numero que el dashboard muestra de ella: que el contador
// y la lista cuenten lo mismo es lo que se prueba en test/escritura.test.js.
/** Orden creada por la oficina o por un cliente que todavia no tiene mecanico (alias `ot`). */
const SQL_OT_SIN_ASIGNAR = `(ot.mecanico_id IS NULL AND ot.estado = 'pendiente')`;
/** Reparacion terminada y facturable que aun no se valoriza ni se factura (alias `ot`). */
const SQL_OT_POR_VALORIZAR = `ot.facturable = true AND ot.valorizacion IS NULL AND ot.estado = 'finalizada'
    AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.orden_trabajo_id = ot.id)`;
/** Reparacion valorizada, terminada y sin factura: lista para facturar (alias `ot`). */
const SQL_OT_LISTA_FACTURAR = `ot.facturable = true AND ot.valorizacion IS NOT NULL AND ot.estado = 'finalizada'
    AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.orden_trabajo_id = ot.id)`;

module.exports = {
    verificarDuenoOrden, contactoCliente, MENSAJE_OT_CERRADA,
    SQL_OT_SIN_ASIGNAR, SQL_OT_POR_VALORIZAR, SQL_OT_LISTA_FACTURAR,
};
