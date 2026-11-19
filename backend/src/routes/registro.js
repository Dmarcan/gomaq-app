const express = require('express');
require('../utils/asyncErrores');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const { limiteRegistro, limiteRecuperar, limiteCodigo } = require('../middleware/limites');
const { crearCodigo, enviarCodigoPorCorreo } = require('../services/codigosCuenta');
const { correoDisponible, normalizarCodigo, hmacCodigo, evaluarCanje } = require('../utils/codigosCuenta');
const { validarCoordenadas } = require('../utils/geo');
const { rutValido, MENSAJE_RUT_INVALIDO } = require('../utils/rut');
const { normalizarCorreo } = require('../utils/correo');
const { validarPassword } = require('../utils/cuentasInternas');
const { conTransaccion } = require('../utils/transaccion');

const router = express.Router();

// Verificacion del correo: un codigo de 6 digitos (codigos_cuenta, 'verificar_correo') que llega al correo
// escrito. Si el envio por correo no esta configurado el registro sigue igual, solo queda "sin verificar".
// El correo sale despues de responder; nunca bloquea ni hace fallar el registro.
async function iniciarVerificacion(solicitud) {
    if (!correoDisponible().disponible) return 'no_disponible';
    try {
        return await conTransaccion(pool, async (client, { confirmar }) => {
            const codigo = await crearCodigo(client, {
                proposito: 'verificar_correo', solicitudClienteId: solicitud.id, email: solicitud.email, canal: 'correo',
            });
            await confirmar();
            enviarCodigoPorCorreo(pool, {
                ...codigo, proposito: 'verificar_correo', email: solicitud.email, nombre: solicitud.nombre_contacto,
            }).catch(() => {});
            return 'enviada';
        });
    } catch (err) {
        console.error('verificacion de correo:', err);
        return 'no_disponible';
    }
}

const textoONulo = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// publico (sin verifyToken): el cliente postula su cuenta,
// queda "pendiente" hasta que Administrativo/Gerente la revisen en Usuarios y la activen.
// Nunca crea filas en usuarios ni clientes directamente.
router.post('/', limiteRegistro, async (req, res) => {
    const {
        nombre_contacto, nombre_empresa, password,
        rut_empresa, telefono_whatsapp, horario_trabajo, horario_colacion, direccion,
    } = req.body;
    // el correo se guarda en minusculas y sin espacios: asi no se duplica por la capitalizacion
    const email = normalizarCorreo(req.body.email);

    if (!nombre_contacto || !email || !password) {
        return res.status(400).json({ error: 'Nombre de contacto, correo y contraseña son obligatorios' });
    }
    // mismas reglas que las cuentas internas: minimo 8 caracteres y maximo 72 bytes (bcrypt trunca en silencio)
    const clave = validarPassword(password);
    if (!clave.ok) return res.status(400).json({ error: clave.error });
    if (typeof rut_empresa === 'string' && rut_empresa.trim() && !rutValido(rut_empresa)) {
        return res.status(400).json({ error: MENSAJE_RUT_INVALIDO });
    }

    // ubicacion de la empresa (opcional): un panel o APK anterior no la manda y todo sigue igual
    const coords = validarCoordenadas(req.body.latitud, req.body.longitud);
    if (!coords.ok) return res.status(400).json({ error: coords.error });

    try {
        const existente = await pool.query('SELECT id FROM usuarios WHERE lower(email) = $1', [email]);
        if (existente.rows.length > 0) {
            return res.status(400).json({ error: 'Ese correo ya tiene una cuenta' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // un rechazo no es permanente: si existe una solicitud rechazada con este
        // correo, la nueva postulacion la reemplaza (datos frescos, vuelve a pendiente)
        const rechazada = await pool.query(
            `SELECT id FROM solicitudes_cliente WHERE lower(email) = $1 AND estado = 'rechazada'`,
            [email]
        );
        if (rechazada.rows.length > 0) {
            const actualizada = await pool.query(
                `UPDATE solicitudes_cliente SET
                    nombre_contacto = $1, password_hash = $2, rut_empresa = $3, telefono_whatsapp = $4,
                    horario_trabajo = $5, horario_colacion = $6, direccion = $7, nombre_empresa = $8,
                    latitud = $9, longitud = $10,
                    estado = 'pendiente', created_at = now(), correo_verificado_at = NULL
                 WHERE id = $11
                 RETURNING id, nombre_contacto, nombre_empresa, email, estado, created_at`,
                [nombre_contacto, passwordHash, rut_empresa || null, telefono_whatsapp || null, horario_trabajo || null, horario_colacion || null, direccion || null, textoONulo(nombre_empresa), coords.latitud, coords.longitud, rechazada.rows[0].id]
            );
            // los codigos de la postulacion anterior no sirven para esta, aunque ahora no se pueda enviar uno nuevo
            await pool.query(
                `UPDATE codigos_cuenta SET revocado_at = now()
                 WHERE solicitud_cliente_id = $1 AND usado_at IS NULL AND revocado_at IS NULL`,
                [rechazada.rows[0].id]
            );
            const verificacion = await iniciarVerificacion(actualizada.rows[0]);
            return res.status(201).json({ ...actualizada.rows[0], verificacion });
        }

        // el indice unico es exacto: una solicitud antigua con otra capitalizacion no lo dispararia
        const enRevision = await pool.query(
            `SELECT id FROM solicitudes_cliente WHERE lower(email) = $1 AND estado = 'pendiente'`,
            [email]
        );
        if (enRevision.rows.length > 0) {
            return res.status(400).json({ error: 'Ya hay una solicitud de cuenta con ese correo en revisión' });
        }

        const result = await pool.query(
            `INSERT INTO solicitudes_cliente
                (nombre_contacto, email, password_hash, rut_empresa, telefono_whatsapp, horario_trabajo, horario_colacion, direccion, nombre_empresa, latitud, longitud)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, nombre_contacto, nombre_empresa, email, estado, created_at`,
            [nombre_contacto, email, passwordHash, rut_empresa || null, telefono_whatsapp || null, horario_trabajo || null, horario_colacion || null, direccion || null, textoONulo(nombre_empresa), coords.latitud, coords.longitud]
        );
        const verificacion = await iniciarVerificacion(result.rows[0]);
        res.status(201).json({ ...result.rows[0], verificacion });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Ya hay una solicitud de cuenta con ese correo en revisión' });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar la solicitud' });
    }
});

const ERROR_VERIFICACION = 'El código no es válido o ya venció. Revisa el correo y el código, o pide uno nuevo';
const RESPUESTA_REENVIO = {
    ok: true,
    mensaje: 'Si hay una solicitud pendiente con ese correo, te llegará un código nuevo en unos minutos (revisa también el spam).',
};

// el cliente escribe el codigo que le llego al correo. Marca la
// solicitud como "correo verificado". Mismo error para cualquier falla: no revela si el correo existe.
router.post('/verificar', limiteCodigo, async (req, res) => {
    const email = normalizarCorreo(req.body && req.body.email);
    const codigo = normalizarCodigo(req.body && req.body.codigo);
    if (!email || !codigo) return res.status(400).json({ error: 'Escribe tu correo y el código de 6 dígitos' });

    try {
        return await conTransaccion(pool, async (client, { confirmar }) => {
            const r = await client.query(
                `SELECT c.id, c.proposito, c.codigo_hmac, c.intentos, c.expira_at, c.usado_at, c.revocado_at, c.solicitud_cliente_id
                 FROM codigos_cuenta c
                 JOIN solicitudes_cliente s ON s.id = c.solicitud_cliente_id
                 WHERE lower(c.email) = $1 AND lower(s.email) = $1 AND s.estado = 'pendiente'
                   AND c.proposito = 'verificar_correo'
                   AND c.usado_at IS NULL AND c.revocado_at IS NULL AND c.expira_at > now()
                 ORDER BY c.created_at DESC
                 LIMIT 5
                 FOR UPDATE OF c`,
                [email]
            );
            const valido = r.rows.find((f) => evaluarCanje(f, {
                hmacIngresado: hmacCodigo({ secreto: process.env.JWT_SECRET, proposito: 'verificar_correo', email, codigo }),
            }) === 'ok');
            if (!valido) {
                if (r.rows.length > 0) {
                    await client.query('UPDATE codigos_cuenta SET intentos = intentos + 1 WHERE id = ANY($1::int[])', [r.rows.map((f) => f.id)]);
                }
                await confirmar();
                return res.status(400).json({ error: ERROR_VERIFICACION });
            }
            await client.query('UPDATE solicitudes_cliente SET correo_verificado_at = now() WHERE id = $1', [valido.solicitud_cliente_id]);
            await client.query('UPDATE codigos_cuenta SET usado_at = now() WHERE id = $1', [valido.id]);
            await client.query(
                `UPDATE codigos_cuenta SET revocado_at = now()
                 WHERE solicitud_cliente_id = $1 AND id <> $2 AND usado_at IS NULL AND revocado_at IS NULL`,
                [valido.solicitud_cliente_id, valido.id]
            );
            await confirmar();
            res.json({ ok: true });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'No se pudo verificar el correo' });
    }
});

// un codigo nuevo para una solicitud pendiente sin verificar.
// Responde lo mismo exista o no la solicitud; el trabajo ocurre despues de responder. Tope por solicitud:
// 1 por minuto y 5 por hora.
router.post('/reenviar-codigo', limiteRecuperar, async (req, res) => {
    const email = normalizarCorreo(req.body && req.body.email);
    if (!email || email.length > 150) return res.status(400).json({ error: 'Escribe tu correo' });
    res.json(RESPUESTA_REENVIO);
    reenviarCodigo(email).catch((err) => console.error('reenviar codigo de verificacion:', err));
});

async function reenviarCodigo(email) {
    if (!correoDisponible().disponible) return;
    let envio = null;
    await conTransaccion(pool, async (client) => {
        const r = await client.query(
            `SELECT id, nombre_contacto FROM solicitudes_cliente
             WHERE lower(email) = $1 AND estado = 'pendiente' AND correo_verificado_at IS NULL FOR UPDATE`,
            [email]
        );
        const s = r.rows[0];
        if (s) {
            const recientes = await client.query(
                `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hora,
                        count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS minuto
                 FROM codigos_cuenta WHERE solicitud_cliente_id = $1 AND proposito = 'verificar_correo'`,
                [s.id]
            );
            const { hora, minuto } = recientes.rows[0];
            if (hora < 5 && minuto === 0) {
                const codigo = await crearCodigo(client, {
                    proposito: 'verificar_correo', solicitudClienteId: s.id, email, canal: 'correo',
                });
                envio = { ...codigo, proposito: 'verificar_correo', email, nombre: s.nombre_contacto };
            }
        }
    });
    if (envio) enviarCodigoPorCorreo(pool, envio).catch(() => {});
}

module.exports = router;
