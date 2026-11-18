const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta, esDiaValido } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { dejarEvento } = require('../utils/eventosOt');
const { validarMotivo, detalleFacturaAnulada, esIdPositivo, montoEnteroONulo } = require('../utils/auditoriaLinea');
const { cancelarCorreosFactura, encolarCorreoFactura, validarFolio } = require('../utils/correoFactura');

const { avisarFacturaAnulada } = require('../utils/avisos');
const { validarNeto } = require('../utils/trasladoFactura');
const { validarFechasFactura } = require('../utils/cobranza');

const router = express.Router();
validarIdsEnRuta(router, ['id', 'facturaId']);

// un monto 0 es un monto valido: `monto || null` lo volveria nulo
const montoVacio = (v) => v === undefined || v === null || v === '';
const montoONulo = (v) => (montoVacio(v) ? null : montoEnteroONulo(v));
const URL_EXPIRACION_SEGUNDOS = 3600;

// subir PDF de factura ya emitida en el SII (va a Supabase Storage)
//
// La fila de la OT se bloquea (FOR NO KEY UPDATE) en la misma transaccion que inserta la factura: asi un
// cambio de linea que corre al mismo tiempo (routes/insumos.js, que tambien bloquea la OT) termina
// antes o empieza despues, y la factura nunca queda sobre lineas distintas a las que se cobraron.
// La subida del PDF va antes, fuera de la transaccion: no conviene tener la OT bloqueada mientras
// se espera a Supabase, y si algo falla despues el archivo se borra.
// Opcionales (038): monto_neto (no mayor que el monto) y fecha_vencimiento (no anterior a la emision).
router.post('/:id/factura', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    const { id } = req.params;
    const { folio, monto, fecha_emision, fecha_vencimiento, monto_neto } = req.body;
    if (!esIdPositivo(id)) return res.status(400).json({ error: 'Id de orden inválido' });
    if (!folio || !req.file) {
        return res.status(400).json({ error: 'folio y archivo (PDF) son requeridos' });
    }
    const folioValido = validarFolio(folio);
    if (folioValido.error) return res.status(400).json({ error: folioValido.error });
    // mismo criterio que la factura de arriendo: pesos enteros y sin signo, que quepan en
    // NUMERIC(12,2). Se valida ANTES de subir el PDF para no dejar un archivo huerfano.
    if (!montoVacio(monto) && montoEnteroONulo(monto) === null) {
        return res.status(400).json({ error: 'El monto debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos' });
    }
    if (!montoVacio(fecha_emision) && !esDiaValido(fecha_emision)) {
        return res.status(400).json({ error: 'fecha_emision debe ser una fecha válida (AAAA-MM-DD)' });
    }
    const neto = validarNeto(monto, monto_neto);
    if (neto.error) return res.status(400).json({ error: neto.error });
    const vencimiento = validarFechasFactura({ fecha_vencimiento });
    if (vencimiento.error) return res.status(400).json({ error: vencimiento.error });
    if (vencimiento.fecha_vencimiento && !montoVacio(fecha_emision) && vencimiento.fecha_vencimiento < fecha_emision) {
        return res.status(400).json({ error: 'La fecha de vencimiento no puede ser anterior a la emisión' });
    }
    let rutaStorage = null;
    let client = null;
    const borrarArchivo = async () => {
        if (rutaStorage) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
        }
    };
    try {
        rutaStorage = rutaArchivo(['facturas', Number(id)], req.file.originalname);
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_DOCUMENTOS)
            .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        client = await pool.connect();
        await client.query('BEGIN');
        const orden = await client.query('SELECT id, estado FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE', [id]);
        if (orden.rows.length === 0) {
            await client.query('ROLLBACK');
            await borrarArchivo();
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        // Una factura congela las lineas de la OT (desde ahi no admite cambios). Solo tiene sentido
        // sobre trabajo terminado: con la OT abierta el mecanico todavia agrega o anula repuestos.
        // No se exige valorizacion: basta con que la OT este finalizada.
        const rechazo = orden.rows[0].estado !== 'finalizada'
            ? 'Solo se factura una orden ya finalizada: la orden sigue abierta y todavía puede cambiar sus repuestos'
            : null;
        if (rechazo) {
            await client.query('ROLLBACK');
            await borrarArchivo();
            return res.status(409).json({ error: rechazo });
        }
        const result = await client.query(
            `INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto, fecha_emision, fecha_vencimiento, monto_neto)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [id, folioValido.folio, rutaStorage, montoONulo(monto), montoVacio(fecha_emision) ? null : fecha_emision,
             vencimiento.fecha_vencimiento, neto.neto]
        );
        const factura = result.rows[0];
        await dejarEvento(client, {
            ordenId: factura.orden_trabajo_id, tipo: 'factura_cargada', origen: 'panel', usuario: req.user,
            detalle: {
                factura_id: factura.id,
                folio: factura.folio,
                monto: factura.monto === null ? null : Number(factura.monto),
            },
        });
        await client.query('COMMIT');
        res.status(201).json(factura);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        await borrarArchivo();
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Esta orden de trabajo ya tiene su factura' });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al subir factura' });
    } finally {
        if (client) client.release();
    }
});

router.get('/:id/factura', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM facturas WHERE orden_trabajo_id = $1 ORDER BY created_at DESC',
            [req.params.id]
        );
        const conUrlFirmada = await Promise.all(result.rows.map(async (fila) => {
            const { data, error } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .createSignedUrl(fila.archivo_url, URL_EXPIRACION_SEGUNDOS);
            return { ...fila, url: error ? null : data.signedUrl };
        }));
        res.json(conUrlFirmada);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar facturas' });
    }
});

const UUID_ESTRICTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// anula una factura subida por error.
//
// Borra la fila de facturas y, antes, deja el evento en el historial de la OT con folio, monto,
// archivo, motivo y quien la anulo (evento 'factura_anulada', migracion 021). El PDF NO se borra de Supabase: queda de respaldo. Desde ahi
// la OT vuelve a admitir cambios de lineas y a poder facturarse de nuevo.
// Esto solo corrige el registro en GOMAQ: la factura real se anula en el SII con una nota de credito.
//
// El motivo es obligatorio, igual que al cambiar una linea de una OT cerrada. Bloquea la fila de la
// OT y despues la factura, en el mismo orden que el resto de las rutas de la OT. Idempotency-Key
// opcional: si ya hay un evento con esa llave, el cambio se hizo y se responde 200 sin repetirlo.
router.post('/:id/factura/:facturaId/anular', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { id, facturaId } = req.params;
    if (!esIdPositivo(id)) return res.status(400).json({ error: 'Id de orden inválido' });
    if (!esIdPositivo(facturaId)) return res.status(400).json({ error: 'Id de factura inválido' });
    const cabecera = req.get('Idempotency-Key');
    if (cabecera !== undefined && !UUID_ESTRICTO.test(cabecera.trim())) {
        return res.status(400).json({ error: 'Idempotency-Key no es un UUID valido' });
    }
    const llave = cabecera === undefined ? null : cabecera.trim().toLowerCase();
    // anular una factura siempre exige motivo, esté la OT como esté
    const motivo = validarMotivo({
        ordenCerrada: true,
        motivoCodigo: req.body ? req.body.motivo_codigo : undefined,
        motivo: req.body ? req.body.motivo : undefined,
    });
    if (!motivo.valido) return res.status(400).json({ error: motivo.error });

    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const orden = await client.query('SELECT id FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE', [id]);
        if (orden.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        if (llave) {
            const previo = await client.query(
                `SELECT orden_trabajo_id, detalle->>'factura_id' AS factura_id FROM ordenes_eventos
                 WHERE uuid_cliente = $1 AND tipo = 'factura_anulada'`,
                [llave]
            );
            if (previo.rows[0]) {
                await client.query('ROLLBACK');
                if (previo.rows[0].orden_trabajo_id !== orden.rows[0].id || previo.rows[0].factura_id !== String(facturaId)) {
                    return res.status(409).json({ error: 'Idempotency-Key ya fue usada en otra operación' });
                }
                return res.json({ ok: true, ya_registrada: true });
            }
        }
        const factura = await client.query(
            // fecha_emision_texto: la fecha como la guarda la base, sin pasar por la zona del servidor
            'SELECT *, fecha_emision::text AS fecha_emision_texto FROM facturas WHERE id = $1 AND orden_trabajo_id = $2 FOR UPDATE',
            [facturaId, id]
        );
        if (factura.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Factura no encontrada para esta orden de trabajo' });
        }
        const registrado = await dejarEvento(client, {
            ordenId: orden.rows[0].id, tipo: 'factura_anulada', origen: 'panel', usuario: req.user,
            uuidCliente: llave,
            detalle: detalleFacturaAnulada(factura.rows[0], { motivoCodigo: motivo.motivoCodigo, motivo: motivo.motivo }),
        });
        if (!registrado) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Idempotency-Key ya fue usada en otra operación' });
        }
        // el correo que ya estaba encolado y no salio se cancela en la misma transaccion
        await cancelarCorreosFactura(client, factura.rows[0]);
        await client.query('DELETE FROM facturas WHERE id = $1', [facturaId]);
        // aviso al gerente en la misma transaccion; la repeticion con la misma Idempotency-Key salio arriba
        await avisarFacturaAnulada(client, { factura: factura.rows[0], excluirUsuarioId: req.user.id });
        await client.query('COMMIT');
        res.json({ ok: true, factura_id: factura.rows[0].id, folio: factura.rows[0].folio });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al anular la factura' });
    } finally {
        if (client) client.release();
    }
});

// Encola el envio del correo con la factura al cliente (patron Outbox: lo envia el worker de notificaciones).
router.post('/:id/factura/:facturaId/autorizar-envio', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { id, facturaId } = req.params;
    if (!esIdPositivo(id)) return res.status(400).json({ error: 'Id de orden inválido' });
    if (!esIdPositivo(facturaId)) return res.status(400).json({ error: 'Id de factura inválido' });
    try {
        const cuerpoPeticion = req.body || {};
        const r = await encolarCorreoFactura(pool, {
            facturaId, ordenId: id, asunto: cuerpoPeticion.asunto, cuerpo: cuerpoPeticion.cuerpo,
        });
        res.status(r.status).json(r.body);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al autorizar el envío de la factura' });
    }
});

module.exports = router;
