const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { validarNuevaCuenta, validarCambioDeEstado, ROLES_INTERNOS } = require('../utils/cuentasInternas');
const { verifyToken, requireRole } = require('../middleware/auth');

const { SQL_CUENTAS_POR_APROBAR } = require('../utils/pendientes');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

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
        SELECT u.id, u.nombre, u.email, u.rol, u.estado_cuenta,
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

// POST /api/usuarios - crea una cuenta interna (mecanico, administrativo o gerente). Antes solo se
// podia con el script create-user.js por SSH. La contrasena la escribe quien crea la cuenta (no hay
// proveedor de correo para enviarla): se guarda solo como hash y no vuelve en ninguna respuesta.
// Las cuentas de cliente se crean con el registro y se aprueban en Solicitudes.
router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarNuevaCuenta(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { nombre, email, rol, password } = v.datos;
    try {
        // el correo se compara sin distinguir mayusculas: el inicio de sesion tambien
        const existe = await pool.query('SELECT 1 FROM usuarios WHERE lower(email) = $1', [email]);
        if (existe.rows.length > 0) {
            return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
        }
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ($1, $2, $3, $4, 'activo')
             RETURNING id, nombre, email, rol, estado_cuenta`,
            [nombre, email, hash, rol]
        );
        const nueva = result.rows[0];
        console.log(`Cuenta ${nueva.id} (${nueva.rol}) creada por el usuario ${req.user.id}`);
        res.status(201).json(nueva);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
        console.error(err);
        res.status(500).json({ error: 'Error al crear la cuenta' });
    }
});

// PATCH /api/usuarios/:id/estado - desactiva o reactiva una cuenta interna. Una cuenta desactivada
// no puede iniciar sesion y su sesion vigente deja de valer en la siguiente peticion (verifyToken
// la revisa en la base). No se puede desactivar la propia cuenta.
router.patch('/:id/estado', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarCambioDeEstado(req.body, req.params.id, req.user.id);
    if (!v.ok) return res.status(v.codigo).json({ error: v.error });
    try {
        const result = await pool.query(
            `UPDATE usuarios SET estado_cuenta = $1
             WHERE id = $2 AND rol = ANY($3::rol_usuario[])
             RETURNING id, nombre, email, rol, estado_cuenta`,
            [v.estado, req.params.id, ROLES_INTERNOS]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario interno no encontrado' });
        }
        console.log(`Cuenta ${result.rows[0].id} pasó a ${v.estado} por el usuario ${req.user.id}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al cambiar el estado de la cuenta' });
    }
});

// GET /api/usuarios/solicitudes - solicitudes de registro de cliente pendientes de revisar
router.get('/solicitudes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, nombre_contacto, nombre_empresa, email, rut_empresa, telefono_whatsapp, horario_trabajo,
                    horario_colacion, direccion, latitud, longitud, estado, created_at
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
    const errCuerpo = validarCuerpo(req.body, { ids: ['cliente_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    let client;
    try {
        client = await pool.connect();
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
                `INSERT INTO clientes (nombre, rut, email, telefono, horario_trabajo, horario_colacion, direccion, latitud, longitud)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
                [s.nombre_empresa || s.nombre_contacto, s.rut_empresa, s.email, s.telefono_whatsapp, s.horario_trabajo, s.horario_colacion, s.direccion, s.latitud, s.longitud]
            );
            clienteIdFinal = nuevoCliente.rows[0].id;
        } else if (s.latitud !== null && s.longitud !== null) {
            // se vincula a un cliente que ya existe: recibe la ubicacion marcada al registrarse
            // solo si aun no tiene una, para no pisar la que el administrativo haya cargado
            await client.query(
                'UPDATE clientes SET latitud = $1, longitud = $2 WHERE id = $3 AND latitud IS NULL',
                [s.latitud, s.longitud, clienteIdFinal]
            );
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
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar la solicitud' });
    } finally {
        if (client) client.release();
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
    const errCuerpo = validarCuerpo(req.body, { textos: { rut: 20, telefono_whatsapp: 30 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
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
    const errCuerpo = validarCuerpo(req.body, { textos: { telefono_whatsapp: 30 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
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
