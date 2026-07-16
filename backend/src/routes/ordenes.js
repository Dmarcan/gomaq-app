const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { verificarDuenoOrden } = require('../utils/ordenes');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');

const router = express.Router();

// POST /api/ordenes-trabajo - crear OT
router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { maquinaria_id, cliente_id, origen, motivo } = req.body;
    if (!maquinaria_id) {
        return res.status(400).json({ error: 'maquinaria_id es requerido' });
    }
    try {
        // facturable nace en false: lo decide el mecanico al finalizar la orden, no aca
        const result = await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, COALESCE($3::origen_orden, 'directo'), $4)
             RETURNING *`,
            [maquinaria_id, cliente_id || null, origen || null, motivo || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear orden de trabajo' });
    }
});

// GET /api/ordenes-trabajo - listar (mecanico solo ve las suyas)
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        let query = `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
                      FROM ordenes_trabajo ot
                      JOIN maquinarias m ON m.id = ot.maquinaria_id
                      LEFT JOIN clientes c ON c.id = ot.cliente_id`;
        const params = [];
        if (req.user.rol === 'mecanico') {
            query += ' WHERE ot.mecanico_id = $1';
            params.push(req.user.id);
        }
        query += ' ORDER BY ot.fecha_creacion DESC';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar ordenes de trabajo' });
    }
});

// GET /api/ordenes-trabajo/mias - portal cliente: su historial de OT con facturas vinculadas
router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Su usuario no esta vinculado a ninguna empresa cliente' });
    }
    try {
        const result = await pool.query(
            `SELECT ot.id, ot.estado, ot.motivo, ot.diagnostico, ot.fecha_creacion, ot.fecha_cierre,
                    m.codigo AS maquinaria_codigo, m.tipo AS maquinaria_tipo,
                    f.id AS factura_id, f.folio AS factura_folio, f.archivo_url AS factura_url
             FROM ordenes_trabajo ot
             JOIN maquinarias m ON m.id = ot.maquinaria_id
             LEFT JOIN facturas f ON f.orden_trabajo_id = ot.id
             WHERE ot.cliente_id = $1
             ORDER BY ot.fecha_creacion DESC`,
            [req.user.cliente_id]
        );

        // factura_url guarda la ruta dentro del bucket privado, no una URL directa;
        // se reemplaza por una URL firmada temporal (1h) antes de responder
        const conUrlFirmada = await Promise.all(result.rows.map(async (fila) => {
            if (!fila.factura_url) return fila;
            const { data, error } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .createSignedUrl(fila.factura_url, 3600);
            return { ...fila, factura_url: error ? null : data.signedUrl };
        }));

        res.json(conUrlFirmada);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar su historial' });
    }
});

// GET /api/ordenes-trabajo/:id - detalle
router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
             FROM ordenes_trabajo ot
             JOIN maquinarias m ON m.id = ot.maquinaria_id
             LEFT JOIN clientes c ON c.id = ot.cliente_id
             WHERE ot.id = $1`,
            [req.params.id]
        );
        const orden = result.rows[0];
        if (!orden) {
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        if (req.user.rol === 'mecanico' && orden.mecanico_id !== req.user.id) {
            return res.status(403).json({ error: 'No tiene permiso para ver esta orden' });
        }
        res.json(orden);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar orden de trabajo' });
    }
});

// PATCH /api/ordenes-trabajo/:id/asignar - asignar mecanico
// Patron Outbox (informe 6.4.2): la misma transaccion que asigna el mecanico
// inserta la notificacion pendiente (HU-07) para que nunca queden desincronizadas
router.patch('/:id/asignar', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { mecanico_id } = req.body;
    if (!mecanico_id) {
        return res.status(400).json({ error: 'mecanico_id es requerido' });
    }
    const client = await pool.connect();
    try {
        const mecanico = await client.query('SELECT id, nombre FROM usuarios WHERE id = $1 AND rol = $2', [mecanico_id, 'mecanico']);
        if (mecanico.rows.length === 0) {
            return res.status(400).json({ error: 'mecanico_id no corresponde a un usuario con rol mecanico' });
        }

        await client.query('BEGIN');

        const otResult = await client.query(
            `UPDATE ordenes_trabajo SET mecanico_id = $1, estado = 'asignada' WHERE id = $2
             RETURNING *, (SELECT codigo FROM maquinarias WHERE id = ordenes_trabajo.maquinaria_id) AS maquinaria_codigo`,
            [mecanico_id, req.params.id]
        );
        if (otResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        const orden = otResult.rows[0];

        // datos de contacto del cliente para la notificacion; whatsapp si hay telefono, si no email
        let destinatario = null;
        let canal = null;
        if (orden.cliente_id) {
            const clienteResult = await client.query('SELECT telefono, email FROM clientes WHERE id = $1', [orden.cliente_id]);
            const cli = clienteResult.rows[0];
            if (cli && cli.telefono) {
                destinatario = cli.telefono;
                canal = 'whatsapp';
            } else if (cli && cli.email) {
                destinatario = cli.email;
                canal = 'email';
            }
        }

        if (destinatario) {
            await client.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ($1, $2, $3)`,
                [canal, destinatario, JSON.stringify({
                    tipo: 'mecanico_asignado',
                    orden_trabajo_id: orden.id,
                    maquinaria_codigo: orden.maquinaria_codigo,
                    mecanico_nombre: mecanico.rows[0].nombre,
                })]
            );
        }

        await client.query('COMMIT');
        res.json(orden);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al asignar mecanico' });
    } finally {
        client.release();
    }
});

// PATCH /api/ordenes-trabajo/:id/diagnostico - mecanico registra diagnostico y avanza estado
router.patch('/:id/diagnostico', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { diagnostico, estado } = req.body;
    const estadosValidos = ['en_terreno', 'en_reparacion'];
    if (estado && !estadosValidos.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${estadosValidos.join(', ')}` });
    }
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });

        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET diagnostico = COALESCE($1, diagnostico), estado = COALESCE($2, estado)
             WHERE id = $3 RETURNING *`,
            [diagnostico || null, estado || null, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar diagnostico' });
    }
});

// PATCH /api/ordenes-trabajo/:id/finalizar - mecanico cierra la OT y decide si es facturable
// (entrevista la administrativa: "el mecanico decide si es culpa al cliente o no" - esa decision es
// la que determina si la OT queda facturable, no algo que Administrativo elige al crearla)
router.patch('/:id/finalizar', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { facturable } = req.body;
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });

        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET estado = 'finalizada', fecha_cierre = now(), facturable = COALESCE($2, facturable)
             WHERE id = $1 RETURNING *`,
            [req.params.id, facturable === undefined ? null : Boolean(facturable)]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al finalizar orden de trabajo' });
    }
});

// PATCH /api/ordenes-trabajo/:id/valorizacion - gerente aprueba monto (HU-04)
router.patch('/:id/valorizacion', verifyToken, requireRole('gerente'), async (req, res) => {
    const { valorizacion } = req.body;
    if (valorizacion === undefined || isNaN(valorizacion)) {
        return res.status(400).json({ error: 'valorizacion (numerica) es requerida' });
    }
    try {
        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET valorizacion = $1, valorizacion_aprobada_por = $2, facturable = true
             WHERE id = $3 RETURNING *`,
            [valorizacion, req.user.id, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar valorizacion' });
    }
});

module.exports = router;
