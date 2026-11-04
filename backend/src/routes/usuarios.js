const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const { SQL_CUENTAS_POR_APROBAR } = require('../utils/pendientes');

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
               u.recibe_alertas_mantencion, u.telefono_whatsapp,
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
            `SELECT id, nombre_contacto, nombre_empresa, email, rut_empresa, telefono_whatsapp, horario_trabajo,
                    horario_colacion, direccion, estado, created_at
             FROM solicitudes_cliente WHERE ${SQL_CUENTAS_POR_APROBAR} ORDER BY created_at ASC`
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
        await client.query('BEGIN');

        // FOR UPDATE dentro de la transaccion: dos aprobaciones concurrentes de la misma
        // solicitud serializan aqui - la segunda ve estado != 'pendiente' y recibe 404
        // en vez de un 500 por email duplicado (mismo patron que /convertir en solicitudes.js)
        const solicitudResult = await client.query(
            `SELECT * FROM solicitudes_cliente WHERE id = $1 AND estado = 'pendiente' FOR UPDATE`,
            [req.params.id]
        );
        if (solicitudResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Solicitud de cuenta no encontrada o ya procesada' });
        }
        const s = solicitudResult.rows[0];

        let clienteIdFinal = cliente_id || null;
        if (!clienteIdFinal) {
            // el cliente es la empresa: antes se creaba con el nombre de la persona de contacto
            // porque el formulario no pedia el de la empresa (las solicitudes antiguas no lo traen)
            const nuevoCliente = await client.query(
                `INSERT INTO clientes (nombre, rut, email, telefono, horario_trabajo, horario_colacion, direccion)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [s.nombre_empresa || s.nombre_contacto, s.rut_empresa, s.email, s.telefono_whatsapp, s.horario_trabajo, s.horario_colacion, s.direccion]
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

        // Aviso de cuenta aprobada por el Outbox, en la misma transaccion. Sale en cuanto se
        // configure el proveedor de correo (pendiente del README), como el resto de avisos.
        await client.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', $1, $2)`,
            [s.email, JSON.stringify({ tipo: 'cuenta_aprobada', nombre_contacto: s.nombre_contacto })]
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
            return res.status(404).json({ error: 'Solicitud de cuenta no encontrada o ya procesada' });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al rechazar la solicitud' });
    }
});

// GET /api/usuarios/mi-perfil - los datos propios del usuario autenticado.
// Incluye lo que se le muestra al cliente en el aviso previo a la visita (HU-07), para que
// el mecanico sepa exactamente que de su ficha sale de la empresa.
router.get('/mi-perfil', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, nombre, email, rol, rut, telefono_whatsapp FROM usuarios WHERE id = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar tu perfil' });
    }
});

// PATCH /api/usuarios/mi-perfil - el usuario completa su RUT y telefono.
// El RUT lo pide el bloque de firmas del talonario y se le muestra al cliente en el aviso.
router.patch('/mi-perfil', verifyToken, async (req, res) => {
    const { rut, telefono_whatsapp } = req.body;
    if (rut === undefined && telefono_whatsapp === undefined) {
        return res.status(400).json({ error: 'Indique rut y/o telefono_whatsapp' });
    }
    try {
        const result = await pool.query(
            `UPDATE usuarios
             SET rut = COALESCE($1, rut), telefono_whatsapp = COALESCE($2, telefono_whatsapp)
             WHERE id = $3
             RETURNING id, nombre, email, rol, rut, telefono_whatsapp`,
            [
                rut === undefined ? null : (String(rut).trim() || null),
                telefono_whatsapp === undefined ? null : (String(telefono_whatsapp).trim() || null),
                req.user.id,
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar tu perfil' });
    }
});

// PATCH /api/usuarios/:id/alertas - quien recibe el aviso de mantencion proxima y por donde.
// Se configura desde el panel a proposito: cambiar el destinatario no deberia exigir entrar
// por SSH a editar el .env del servidor.
router.patch('/:id/alertas', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { recibe_alertas_mantencion, telefono_whatsapp } = req.body;
    if (recibe_alertas_mantencion === undefined && telefono_whatsapp === undefined) {
        return res.status(400).json({ error: 'Indique recibe_alertas_mantencion y/o telefono_whatsapp' });
    }
    try {
        const result = await pool.query(
            `UPDATE usuarios
             SET recibe_alertas_mantencion = COALESCE($1, recibe_alertas_mantencion),
                 telefono_whatsapp = COALESCE($2, telefono_whatsapp)
             WHERE id = $3 AND rol <> 'cliente'
             RETURNING id, nombre, email, rol, recibe_alertas_mantencion, telefono_whatsapp`,
            [
                recibe_alertas_mantencion === undefined ? null : recibe_alertas_mantencion === true || recibe_alertas_mantencion === 'true',
                telefono_whatsapp === undefined ? null : (String(telefono_whatsapp).trim() || null),
                req.params.id,
            ]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario interno no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar las alertas del usuario' });
    }
});

module.exports = router;
