const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const {
    validarNuevaCuenta, validarNuevaInvitacion, validarCambioDeEstado, validarCambioDePassword, ROLES_INTERNOS,
} = require('../utils/cuentasInternas');
const { correoDisponible, estadoInvitacion, textoCodigo, urlPanel, validarCanal } = require('../utils/codigosCuenta');
const { normalizarCorreo } = require('../utils/correo');
const { crearCodigo, enviarCodigoPorCorreo } = require('../services/codigosCuenta');
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
               COALESCE(ot.abiertas, 0) AS ot_abiertas,
               inv.expira_at AS inv_expira_at, inv.intentos AS inv_intentos, inv.usado_at AS inv_usado_at,
               inv.revocado_at AS inv_revocado_at, inv.canal AS inv_canal, inv.enviado_at AS inv_enviado_at,
               inv.error_envio AS inv_error_envio
        FROM usuarios u
        LEFT JOIN (
            SELECT mecanico_id, COUNT(*) AS abiertas
            FROM ordenes_trabajo
            WHERE mecanico_id IS NOT NULL AND estado != 'finalizada'
            GROUP BY mecanico_id
        ) ot ON ot.mecanico_id = u.id
        -- ultima invitacion, solo de las cuentas que aun no la aceptan
        LEFT JOIN LATERAL (
            SELECT expira_at, intentos, usado_at, revocado_at, canal, enviado_at, error_envio
            FROM codigos_cuenta
            WHERE usuario_id = u.id AND proposito = 'invitacion'
            ORDER BY created_at DESC
            LIMIT 1
        ) inv ON u.estado_cuenta = 'pendiente'
    `;
    try {
        const result = rol
            ? await pool.query(`${selectConOtAbiertas} WHERE u.rol = $1 ORDER BY u.nombre`, [rol])
            : await pool.query(`${selectConOtAbiertas} ORDER BY u.nombre`);
        res.json(result.rows.map(conInvitacion));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar usuarios' });
    }
});

// POST /api/usuarios - crea una cuenta interna activa con una contrasena que escribe quien la crea.
// RESPALDO por un ciclo: el panel ya invita (POST /api/usuarios/invitaciones) y la persona elige su
// clave. Se mantiene para los APK antiguos del panel; quitarlo en el proximo ciclo.
// Las cuentas de cliente se crean con el registro y se aprueban en Solicitudes.
router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarNuevaCuenta(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { nombre, email, rol, password } = v.datos;
    if (rol === 'gerente' && req.user.rol !== 'gerente') {
        return res.status(403).json({ error: 'Solo un gerente puede crear una cuenta de gerente' });
    }
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

// ---- Invitaciones y codigos de restablecer ---------------------------------------------------------
//
// Quien administra escribe nombre, correo y rol; nunca la clave. La cuenta queda 'pendiente' con una
// clave aleatoria que nadie conoce, y la persona elige la suya canjeando un codigo de 6 digitos
// (POST /api/auth/codigo/confirmar). El codigo llega por correo o, con canal 'manual', vuelve UNA vez
// en la respuesta dentro de un mensaje listo para copiar y mandar por WhatsApp: la base solo guarda su
// HMAC, asi que no se puede volver a mostrar (se genera otro). Sirve tambien para quien no tiene un
// correo real: el correo es solo su identificador de acceso y el codigo queda amarrado a el.

/** Quita las columnas de la ultima invitacion y, si la cuenta esta pendiente, las resume. */
function conInvitacion(fila) {
    const {
        inv_expira_at, inv_intentos, inv_usado_at, inv_revocado_at, inv_canal, inv_enviado_at, inv_error_envio, ...resto
    } = fila;
    if (fila.estado_cuenta !== 'pendiente') return resto;
    const ultima = inv_expira_at
        ? { expira_at: inv_expira_at, intentos: inv_intentos, usado_at: inv_usado_at, revocado_at: inv_revocado_at }
        : null;
    return {
        ...resto,
        invitacion: {
            estado: estadoInvitacion(ultima),
            vence_at: inv_expira_at ?? null,
            canal: inv_canal ?? null,
            enviado: Boolean(inv_enviado_at),
            error_envio: inv_error_envio ?? null,
        },
    };
}

/** URL del panel para el mensaje manual: la configurada o, si no hay, la del panel desde donde se pide. */
function urlParaMensaje(req) {
    return urlPanel() || `${req.protocol}://${req.get('host')}`;
}

/** Si piden el canal correo y no esta configurado, el error para responder; si no, null. */
function errorCanalCorreo(canal) {
    if (canal !== 'correo') return null;
    const c = correoDisponible();
    return c.disponible ? null : `El envío por correo no está disponible: ${c.motivo} Usa "Copiar mensaje".`;
}

/**
 * Entrega un codigo recien creado (despues del COMMIT). Por correo lo envia; en manual devuelve el texto.
 * El codigo en claro solo sale en `mensaje`, y solo en el canal manual.
 */
async function entregarCodigo(req, { canal, proposito, email, nombre, codigo }) {
    if (canal === 'manual') {
        return {
            canal,
            vence_at: codigo.expiraAt,
            mensaje: textoCodigo({ proposito, nombre, email, codigo: codigo.codigo, venceAt: codigo.expiraAt, url: urlParaMensaje(req) }),
        };
    }
    const envio = await enviarCodigoPorCorreo(pool, {
        id: codigo.id, proposito, email, nombre, codigo: codigo.codigo, expiraAt: codigo.expiraAt,
    });
    return { canal, vence_at: codigo.expiraAt, enviado: envio.enviado, error: envio.error };
}

const MENSAJE_CORREO_OCUPADO = {
    activo: 'Ese correo ya tiene una cuenta activa. Si olvidó su contraseña, usa "Contraseña" en su fila.',
    rechazado: 'Ese correo es de una cuenta desactivada. Reactívala desde la lista de cuentas.',
};

// GET /api/usuarios/invitaciones/config - si el canal correo esta disponible (y si no, por que)
router.get('/invitaciones/config', verifyToken, requireRole('administrativo', 'gerente'), (req, res) => {
    const c = correoDisponible();
    res.json({ correo_disponible: c.disponible, motivo: c.motivo });
});

// POST /api/usuarios/invitaciones - invita una cuenta interna. Si el correo ya es de una cuenta que no
// acepta su invitacion, la reinvita (actualiza nombre y rol, y el codigo anterior deja de servir).
router.post('/invitaciones', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarNuevaInvitacion(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { nombre, email, rol, canal } = v.datos;
    if (rol === 'gerente' && req.user.rol !== 'gerente') {
        return res.status(403).json({ error: 'Solo un gerente puede invitar a una cuenta de gerente' });
    }
    const errCanal = errorCanalCorreo(canal);
    if (errCanal) return res.status(400).json({ error: errCanal });

    let client;
    let usuario;
    let codigo;
    let reinvitada = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const existe = await client.query(
            'SELECT id, rol, estado_cuenta FROM usuarios WHERE lower(email) = $1 FOR UPDATE',
            [email]
        );
        if (existe.rows.length > 0) {
            const e = existe.rows[0];
            if (e.rol === 'gerente' && req.user.rol !== 'gerente') {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Solo un gerente puede reinvitar a una cuenta de gerente' });
            }
            if (e.rol === 'cliente') {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Ese correo es de una cuenta de cliente' });
            }
            if (e.estado_cuenta !== 'pendiente') {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: MENSAJE_CORREO_OCUPADO[e.estado_cuenta] || 'Ya existe una cuenta con ese correo' });
            }
            const r = await client.query(
                'UPDATE usuarios SET nombre = $1, rol = $2 WHERE id = $3 RETURNING id, nombre, email, rol, estado_cuenta',
                [nombre, rol, e.id]
            );
            usuario = r.rows[0];
            reinvitada = true;
        } else {
            const solicitud = await client.query(
                `SELECT 1 FROM solicitudes_cliente WHERE lower(email) = $1 AND estado = 'pendiente'`,
                [email]
            );
            if (solicitud.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Ese correo tiene una solicitud de cuenta de cliente en revisión' });
            }
            // clave aleatoria que se descarta: la cuenta existe (reserva el correo y aparece en la lista)
            // pero nadie puede iniciar sesion con ella hasta canjear el codigo
            const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
            const r = await client.query(
                `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
                 VALUES ($1, $2, $3, $4, 'pendiente')
                 RETURNING id, nombre, email, rol, estado_cuenta`,
                [nombre, email, hash, rol]
            );
            usuario = r.rows[0];
        }
        codigo = await crearCodigo(client, { proposito: 'invitacion', usuarioId: usuario.id, email, canal, creadoPor: req.user.id });
        await client.query('COMMIT');
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
        console.error(err);
        return res.status(500).json({ error: 'Error al crear la invitación' });
    } finally {
        if (client) client.release();
    }

    console.log(`Cuenta ${usuario.id} (${usuario.rol}) ${reinvitada ? 'reinvitada' : 'invitada'} por el usuario ${req.user.id} (${canal})`);
    res.set('Cache-Control', 'no-store');
    const invitacion = await entregarCodigo(req, { canal, proposito: 'invitacion', email, nombre: usuario.nombre, codigo });
    res.status(reinvitada ? 200 : 201).json({ usuario, invitacion });
});

/**
 * Bloquea la cuenta interna :id dentro de la transaccion y valida su estado. Devuelve la fila o
 * responde el error (y entonces devuelve null).
 */
async function cuentaInternaParaCodigo(client, req, res, estadoEsperado, mensajeOtroEstado) {
    const r = await client.query(
        `SELECT id, nombre, email, rol, estado_cuenta FROM usuarios
         WHERE id = $1 AND rol = ANY($2::rol_usuario[]) FOR UPDATE`,
        [req.params.id, ROLES_INTERNOS]
    );
    if (r.rows.length === 0) {
        res.status(404).json({ error: 'Usuario interno no encontrado' });
        return null;
    }
    if (r.rows[0].estado_cuenta !== estadoEsperado) {
        res.status(409).json({ error: mensajeOtroEstado });
        return null;
    }
    return r.rows[0];
}

/** Genera y entrega un codigo para la cuenta :id (invitacion nueva o restablecer). */
async function nuevoCodigoParaCuenta(req, res, { proposito, estadoEsperado, mensajeOtroEstado }) {
    const v = validarCanal(req.body && req.body.canal);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const errCanal = errorCanalCorreo(v.canal);
    if (errCanal) return res.status(400).json({ error: errCanal });

    let client;
    let cuenta;
    let codigo;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        cuenta = await cuentaInternaParaCodigo(client, req, res, estadoEsperado, mensajeOtroEstado);
        if (!cuenta) {
            await client.query('ROLLBACK');
            return undefined;
        }
        codigo = await crearCodigo(client, {
            proposito, usuarioId: cuenta.id, email: normalizarCorreo(cuenta.email), canal: v.canal, creadoPor: req.user.id,
        });
        await client.query('COMMIT');
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: 'Error al generar el código' });
    } finally {
        if (client) client.release();
    }
    console.log(`Código de ${proposito} para la cuenta ${cuenta.id} generado por el usuario ${req.user.id} (${v.canal})`);
    res.set('Cache-Control', 'no-store');
    const entrega = await entregarCodigo(req, {
        canal: v.canal, proposito, email: normalizarCorreo(cuenta.email), nombre: cuenta.nombre, codigo,
    });
    return res.json({ ok: true, ...entrega });
}

// POST /api/usuarios/:id/invitacion {canal} - nuevo codigo de invitacion (reenviar o copiar otro mensaje)
router.post('/:id/invitacion', verifyToken, requireRole('administrativo', 'gerente'), (req, res) =>
    nuevoCodigoParaCuenta(req, res, {
        proposito: 'invitacion',
        estadoEsperado: 'pendiente',
        mensajeOtroEstado: 'Esta cuenta ya aceptó su invitación o está desactivada: no necesita una nueva',
    }));

// POST /api/usuarios/:id/codigo-restablecer {canal} - codigo para que la persona elija una clave nueva.
// Su clave actual sigue valiendo hasta que canjee el codigo; para cortar el acceso ya, desactivar.
router.post('/:id/codigo-restablecer', verifyToken, requireRole('administrativo', 'gerente'), (req, res) => {
    if (Number(req.params.id) === Number(req.user.id)) {
        return res.status(409).json({ error: 'Para tu propia cuenta usa "Cambiar mi contraseña"' });
    }
    return nuevoCodigoParaCuenta(req, res, {
        proposito: 'recuperar_password',
        estadoEsperado: 'activo',
        mensajeOtroEstado: 'Solo se restablece la contraseña de una cuenta activa. Si está pendiente, genera una invitación nueva',
    });
});

// POST /api/usuarios/:id/invitacion/revocar - revoca una invitacion no aceptada. La cuenta nunca pudo entrar,
// asi que se borra; si algo ya la referencia (por ejemplo un vehiculo asignado), queda desactivada.
router.post('/:id/invitacion/revocar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const cuenta = await cuentaInternaParaCodigo(client, req, res, 'pendiente', 'Esta cuenta ya aceptó su invitación: desactívala en vez de revocar');
        if (!cuenta) {
            await client.query('ROLLBACK');
            return undefined;
        }
        let eliminada = true;
        await client.query('SAVEPOINT antes_de_borrar');
        try {
            await client.query('DELETE FROM usuarios WHERE id = $1', [cuenta.id]);
        } catch (err) {
            if (err.code !== '23503') throw err;
            await client.query('ROLLBACK TO SAVEPOINT antes_de_borrar');
            await client.query(
                `UPDATE codigos_cuenta SET revocado_at = now()
                 WHERE usuario_id = $1 AND usado_at IS NULL AND revocado_at IS NULL`,
                [cuenta.id]
            );
            await client.query(`UPDATE usuarios SET estado_cuenta = 'rechazado' WHERE id = $1`, [cuenta.id]);
            eliminada = false;
        }
        await client.query('COMMIT');
        console.log(`Invitación de la cuenta ${cuenta.id} revocada por el usuario ${req.user.id}`);
        return res.json({ ok: true, eliminada });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: 'Error al revocar la invitación' });
    } finally {
        if (client) client.release();
    }
});

// PATCH /api/usuarios/:id/estado - desactiva o reactiva una cuenta interna. Una cuenta desactivada
// no puede iniciar sesion y su sesion vigente deja de valer en la siguiente peticion (verifyToken
// la revisa en la base). No se puede desactivar la propia cuenta. Una cuenta invitada que aun no
// acepta no se activa por aqui (no tiene clave): se le reenvia o revoca la invitacion.
router.patch('/:id/estado', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarCambioDeEstado(req.body, req.params.id, req.user.id);
    if (!v.ok) return res.status(v.codigo).json({ error: v.error });
    try {
        const result = await pool.query(
            `UPDATE usuarios SET estado_cuenta = $1
             WHERE id = $2 AND rol = ANY($3::rol_usuario[]) AND estado_cuenta <> 'pendiente'
             RETURNING id, nombre, email, rol, estado_cuenta`,
            [v.estado, req.params.id, ROLES_INTERNOS]
        );
        if (result.rows.length === 0) {
            const pendiente = await pool.query(
                `SELECT 1 FROM usuarios WHERE id = $1 AND rol = ANY($2::rol_usuario[]) AND estado_cuenta = 'pendiente'`,
                [req.params.id, ROLES_INTERNOS]
            );
            if (pendiente.rows.length > 0) {
                return res.status(409).json({ error: 'La cuenta aún no acepta su invitación: reenvíala o revócala' });
            }
            return res.status(404).json({ error: 'Usuario interno no encontrado' });
        }
        console.log(`Cuenta ${result.rows[0].id} pasó a ${v.estado} por el usuario ${req.user.id}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al cambiar el estado de la cuenta' });
    }
});

// POST /api/usuarios/:id/password - restablece la contrasena de una cuenta interna (quien la olvido, o
// una cuenta comprometida). No hay proveedor de correo: la escribe quien restablece y se la entrega a
// la persona. Las sesiones que la cuenta ya tenia abiertas dejan de valer (password_cambiada_at). La
// clave se guarda solo como hash y no vuelve en ninguna respuesta. Las cuentas de cliente quedan fuera.
router.post('/:id/password', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarCambioDePassword(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
        const hash = await bcrypt.hash(v.password, 10);
        const result = await pool.query(
            `UPDATE usuarios SET password_hash = $1, password_cambiada_at = now()
             WHERE id = $2 AND rol = ANY($3::rol_usuario[])
             RETURNING id, nombre, email, rol`,
            [hash, req.params.id, ROLES_INTERNOS]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario interno no encontrado' });
        }
        console.log(`Contraseña de la cuenta ${result.rows[0].id} restablecida por el usuario ${req.user.id}`);
        res.json({ ok: true, id: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al restablecer la contraseña' });
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

        // el UNIQUE de usuarios.email es exacto: una cuenta con el mismo correo en otra capitalizacion
        // no lo dispara, y el login (que no distingue mayusculas) dejaria dos cuentas ambiguas
        const duplicada = await client.query('SELECT id FROM usuarios WHERE lower(email) = lower($1)', [s.email]);
        if (duplicada.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Ya existe una cuenta con ese correo. Rechaza la solicitud o pide al cliente que use otro correo' });
        }

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
