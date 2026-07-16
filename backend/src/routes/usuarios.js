const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const ROLES_VALIDOS = ['gerente', 'administrativo', 'mecanico', 'cliente'];

// GET /api/usuarios?rol=mecanico - listado filtrado por rol (sin exponer password_hash)
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { rol } = req.query;
    if (rol && !ROLES_VALIDOS.includes(rol)) {
        return res.status(400).json({ error: `rol debe ser uno de: ${ROLES_VALIDOS.join(', ')}` });
    }
    // ot_abiertas: cuantas ordenes de trabajo no finalizadas tiene asignadas cada usuario
    // (solo es relevante para mecanicos, pero se calcula igual para cualquier rol sin costo extra)
    const selectConOtAbiertas = `
        SELECT u.id, u.nombre, u.email, u.rol,
               COALESCE(ot.abiertas, 0) AS ot_abiertas
        FROM usuarios u
        LEFT JOIN (
            SELECT mecanico_id, COUNT(*) AS abiertas
            FROM ordenes_trabajo
            WHERE mecanico_id IS NOT NULL AND estado != 'finalizada'
            GROUP BY mecanico_id
        ) ot ON ot.mecanico_id = u.id
    `;
    try {
        const result = rol
            ? await pool.query(`${selectConOtAbiertas} WHERE u.rol = $1 ORDER BY u.nombre`, [rol])
            : await pool.query(`${selectConOtAbiertas} ORDER BY u.nombre`);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar usuarios' });
    }
});

// GET /api/usuarios/solicitudes - solicitudes de registro de cliente pendientes de revisar
router.get('/solicitudes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, nombre_contacto, email, rut_empresa, telefono_whatsapp, horario_trabajo,
                    horario_colacion, direccion, estado, created_at
             FROM solicitudes_cliente WHERE estado = 'pendiente' ORDER BY created_at ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar solicitudes' });
    }
});

// POST /api/usuarios/solicitudes/:id/aprobar - crea (o vincula) el cliente y activa la cuenta
router.post('/solicitudes/:id/aprobar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { cliente_id } = req.body;
    const client = await pool.connect();
    try {
        const solicitudResult = await client.query(
            `SELECT * FROM solicitudes_cliente WHERE id = $1 AND estado = 'pendiente'`,
            [req.params.id]
        );
        if (solicitudResult.rows.length === 0) {
            return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
        }
        const s = solicitudResult.rows[0];

        await client.query('BEGIN');

        let clienteIdFinal = cliente_id || null;
        if (!clienteIdFinal) {
            const nuevoCliente = await client.query(
                `INSERT INTO clientes (nombre, rut, email, telefono, horario_trabajo, horario_colacion, direccion)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [s.nombre_contacto, s.rut_empresa, s.email, s.telefono_whatsapp, s.horario_trabajo, s.horario_colacion, s.direccion]
            );
            clienteIdFinal = nuevoCliente.rows[0].id;
        }

        const nuevoUsuario = await client.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id, estado_cuenta)
             VALUES ($1, $2, $3, 'cliente', $4, 'activo') RETURNING id, nombre, email, rol, cliente_id`,
            [s.nombre_contacto, s.email, s.password_hash, clienteIdFinal]
        );

        await client.query(
            `UPDATE solicitudes_cliente SET estado = 'aprobada', cliente_id = $1, usuario_id = $2 WHERE id = $3`,
            [clienteIdFinal, nuevoUsuario.rows[0].id, req.params.id]
        );

        await client.query('COMMIT');
        res.json({ ok: true, usuario: nuevoUsuario.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar la solicitud' });
    } finally {
        client.release();
    }
});

// POST /api/usuarios/solicitudes/:id/rechazar
router.post('/solicitudes/:id/rechazar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE solicitudes_cliente SET estado = 'rechazada' WHERE id = $1 AND estado = 'pendiente' RETURNING id`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al rechazar la solicitud' });
    }
});

module.exports = router;
