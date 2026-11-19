// Cuentas internas: listado, alta, invitaciones, codigos, estado y clave.
const express = require('express');
require('../../utils/asyncErrores');
const { validarIdsEnRuta } = require('../../utils/validacion');
const pool = require('../../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { validarNuevaCuenta, validarNuevaInvitacion, validarCambioDeEstado, validarCambioDePassword, ROLES_INTERNOS, MENSAJE_SOLO_GERENTE, rolesGestionablesPor } = require('../../utils/cuentasInternas');
const { correoDisponible, estadoInvitacion, textoCodigo, urlPanel, validarCanal } = require('../../utils/codigosCuenta');
const { normalizarCorreo } = require('../../utils/correo');
const { crearCodigo, enviarCodigoPorCorreo } = require('../../services/codigosCuenta');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { conTransaccion } = require('../../utils/transaccion');
const { ROLES_VALIDOS, esGerenteVedado } = require('./comun');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

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
    const result = rol
        ? await pool.query(`${selectConOtAbiertas} WHERE u.rol = $1 ORDER BY u.nombre`, [rol])
        : await pool.query(`${selectConOtAbiertas} ORDER BY u.nombre`);
    res.json(result.rows.map(conInvitacion));
});

// crea una cuenta interna activa con una contrasena que escribe quien la crea.
// Respaldo: lo normal es invitar (POST /api/usuarios/invitaciones) y que la persona elija su clave.
// Se mantiene para los APK antiguos del panel.
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

router.get('/invitaciones/config', verifyToken, requireRole('administrativo', 'gerente'), (req, res) => {
    const c = correoDisponible();
    res.json({ correo_disponible: c.disponible, motivo: c.motivo });
});

// invita una cuenta interna. Si el correo ya es de una cuenta que no
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

    let usuario;
    let codigo;
    let reinvitada = false;
    try {
        const respondida = await conTransaccion(pool, async (client, { deshacer }) => {
            const existe = await client.query(
                'SELECT id, rol, estado_cuenta FROM usuarios WHERE lower(email) = $1 FOR UPDATE',
                [email]
            );
            if (existe.rows.length > 0) {
                const e = existe.rows[0];
                if (e.rol === 'gerente' && req.user.rol !== 'gerente') {
                    await deshacer();
                    return res.status(403).json({ error: 'Solo un gerente puede reinvitar a una cuenta de gerente' });
                }
                if (e.rol === 'cliente') {
                    await deshacer();
                    return res.status(409).json({ error: 'Ese correo es de una cuenta de cliente' });
                }
                if (e.estado_cuenta !== 'pendiente') {
                    await deshacer();
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
                    await deshacer();
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
        });
        if (respondida) return;
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
        console.error(err);
        return res.status(500).json({ error: 'Error al crear la invitación' });
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
    if (r.rows[0].rol === 'gerente' && req.user.rol !== 'gerente') {
        res.status(403).json({ error: MENSAJE_SOLO_GERENTE });
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

    let cuenta;
    let codigo;
    try {
        // cuentaInternaParaCodigo ya respondio cuando la cuenta no sirve: true corta el manejador
        const respondida = await conTransaccion(pool, async (client, { deshacer }) => {
            cuenta = await cuentaInternaParaCodigo(client, req, res, estadoEsperado, mensajeOtroEstado);
            if (!cuenta) {
                await deshacer();
                return true;
            }
            codigo = await crearCodigo(client, {
                proposito, usuarioId: cuenta.id, email: normalizarCorreo(cuenta.email), canal: v.canal, creadoPor: req.user.id,
            });
            return false;
        });
        if (respondida) return undefined;
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error al generar el código' });
    }
    console.log(`Código de ${proposito} para la cuenta ${cuenta.id} generado por el usuario ${req.user.id} (${v.canal})`);
    res.set('Cache-Control', 'no-store');
    const entrega = await entregarCodigo(req, {
        canal: v.canal, proposito, email: normalizarCorreo(cuenta.email), nombre: cuenta.nombre, codigo,
    });
    return res.json({ ok: true, ...entrega });
}

router.post('/:id/invitacion', verifyToken, requireRole('administrativo', 'gerente'), (req, res) =>
    nuevoCodigoParaCuenta(req, res, {
        proposito: 'invitacion',
        estadoEsperado: 'pendiente',
        mensajeOtroEstado: 'Esta cuenta ya aceptó su invitación o está desactivada: no necesita una nueva',
    }));

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

// revoca una invitacion no aceptada. La cuenta nunca pudo entrar,
// asi que se borra; si algo ya la referencia (por ejemplo un vehiculo asignado), queda desactivada.
router.post('/:id/invitacion/revocar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const cuenta = await cuentaInternaParaCodigo(client, req, res, 'pendiente', 'Esta cuenta ya aceptó su invitación: desactívala en vez de revocar');
            if (!cuenta) {
                await deshacer();
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
            await confirmar();
            console.log(`Invitación de la cuenta ${cuenta.id} revocada por el usuario ${req.user.id}`);
            return res.json({ ok: true, eliminada });
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error al revocar la invitación' });
    }
});

// desactiva o reactiva una cuenta interna. Una cuenta desactivada
// no puede iniciar sesion y su sesion vigente deja de valer en la siguiente peticion (verifyToken
// la revisa en la base). No se puede desactivar la propia cuenta. Una cuenta invitada que aun no
// acepta no se activa por aqui (no tiene clave): se le reenvia o revoca la invitacion.
router.patch('/:id/estado', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarCambioDeEstado(req.body, req.params.id, req.user.id);
    if (!v.ok) return res.status(v.codigo).json({ error: v.error });
    if (await esGerenteVedado(req)) return res.status(403).json({ error: MENSAJE_SOLO_GERENTE });
    // cambiar el estado cierra sus sesiones en la misma sentencia: reactivar una cuenta no revive las que
    // tenia abiertas, ni siquiera si algo falla a medias
    const result = await pool.query(
        `WITH cambio AS (
                 UPDATE usuarios SET estado_cuenta = $1
                 WHERE id = $2 AND rol = ANY($3::rol_usuario[]) AND estado_cuenta <> 'pendiente'
                 RETURNING id, nombre, email, rol, estado_cuenta
             ), cerradas AS (
                 UPDATE sesiones SET revocada_at = now(), motivo = 'estado'
                 WHERE usuario_id IN (SELECT id FROM cambio) AND revocada_at IS NULL
                 RETURNING id
             )
             SELECT * FROM cambio`,
        [v.estado, req.params.id, rolesGestionablesPor(req.user.rol)]
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
});

// restablece la contrasena de una cuenta interna (quien la olvido, o
// una cuenta comprometida). No hay proveedor de correo: la escribe quien restablece y se la entrega a
// la persona. Las sesiones que la cuenta ya tenia abiertas dejan de valer (password_cambiada_at). La
// clave se guarda solo como hash y no vuelve en ninguna respuesta. Las cuentas de cliente quedan fuera.
router.post('/:id/password', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const v = validarCambioDePassword(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (await esGerenteVedado(req)) return res.status(403).json({ error: MENSAJE_SOLO_GERENTE });
    const hash = await bcrypt.hash(v.password, 10);
    // la clave nueva y el cierre de las sesiones de esa cuenta van en una sola sentencia
    const result = await pool.query(
        `WITH cambio AS (
                 UPDATE usuarios SET password_hash = $1, password_cambiada_at = now()
                 WHERE id = $2 AND rol = ANY($3::rol_usuario[])
                 RETURNING id, nombre, email, rol
             ), cerradas AS (
                 UPDATE sesiones SET revocada_at = now(), motivo = 'clave'
                 WHERE usuario_id IN (SELECT id FROM cambio) AND revocada_at IS NULL
                 RETURNING id
             )
             SELECT * FROM cambio`,
        [hash, req.params.id, rolesGestionablesPor(req.user.rol)]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuario interno no encontrado' });
    }
    console.log(`Contraseña de la cuenta ${result.rows[0].id} restablecida por el usuario ${req.user.id}`);
    res.json({ ok: true, id: result.rows[0].id });
});

module.exports = router;
