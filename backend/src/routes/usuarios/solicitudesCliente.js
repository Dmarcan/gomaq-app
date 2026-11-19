// Solicitudes de cuenta de clientes: listar, aprobar y rechazar.
const express = require('express');
require('../../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../../utils/validacion');
const pool = require('../../config/db');
const { correoDisponible, urlPanel } = require('../../utils/codigosCuenta');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { SQL_CUENTAS_POR_APROBAR } = require('../../utils/pendientes');
const { encolarNotificacion } = require('../../utils/avisos');
const { conTransaccion } = require('../../utils/transaccion');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

router.get('/solicitudes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const result = await pool.query(
        `SELECT id, nombre_contacto, nombre_empresa, email, rut_empresa, telefono_whatsapp, horario_trabajo,
                    horario_colacion, direccion, latitud, longitud, estado, created_at,
                    (correo_verificado_at IS NOT NULL) AS correo_verificado
             FROM solicitudes_cliente WHERE ${SQL_CUENTAS_POR_APROBAR} ORDER BY created_at ASC`
    );
    // el panel solo pide confirmar "sin verificar" cuando el envio de correos esta configurado
    const disponible = correoDisponible().disponible;
    res.json(result.rows.map((f) => ({ ...f, correo_verificacion_disponible: disponible })));
});

router.post('/solicitudes/:id/aprobar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { cliente_id } = req.body;
    const errCuerpo = validarCuerpo(req.body, { ids: ['cliente_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {

            // FOR UPDATE dentro de la transaccion: dos aprobaciones concurrentes de la misma
            // solicitud serializan aqui - la segunda ve estado != 'pendiente' y recibe 404
            // en vez de un 500 por email duplicado (mismo patron que /convertir en solicitudes.js)
            const solicitudResult = await client.query(
                `SELECT * FROM solicitudes_cliente WHERE id = $1 AND estado = 'pendiente' FOR UPDATE`,
                [req.params.id]
            );
            if (solicitudResult.rows.length === 0) {
                await deshacer();
                return res.status(404).json({ error: 'Solicitud de cuenta no encontrada o ya procesada' });
            }
            const s = solicitudResult.rows[0];

            // si el envio de correos esta configurado, aprobar sin que el cliente haya confirmado su correo
            // pide una confirmacion explicita (puede ser un correo ajeno o mal escrito)
            if (!s.correo_verificado_at && correoDisponible().disponible && req.body.confirmar_sin_verificar !== true) {
                await deshacer();
                return res.status(409).json({
                    codigo: 'correo_sin_verificar',
                    error: 'El cliente aún no confirmó su correo. Confirma que quieres aprobar la cuenta sin verificarlo.',
                });
            }

            // el UNIQUE de usuarios.email es exacto: una cuenta con el mismo correo en otra capitalizacion
            // no lo dispara, y el login (que no distingue mayusculas) dejaria dos cuentas ambiguas
            const duplicada = await client.query('SELECT id FROM usuarios WHERE lower(email) = lower($1)', [s.email]);
            if (duplicada.rows.length > 0) {
                await deshacer();
                return res.status(409).json({ error: 'Ya existe una cuenta con ese correo. Rechaza la solicitud o pide al cliente que use otro correo' });
            }

            let clienteIdFinal = cliente_id || null;
            if (!clienteIdFinal) {
                // el cliente es la empresa; las solicitudes antiguas no traen su nombre y usan el de la persona de contacto
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
                `UPDATE solicitudes_cliente SET estado = 'aprobada', cliente_id = $1, usuario_id = $2, password_hash = NULL WHERE id = $3`,
                [clienteIdFinal, nuevoUsuario.rows[0].id, req.params.id]
            );

            // Aviso de cuenta aprobada por el Outbox, en la misma transaccion (si se revierte, no sale). El worker no
            // conoce la URL del panel, asi que va en el aviso. Solo la configurada en el servidor (PANEL_URL o el dominio
            // publico de Railway): nunca el host de la peticion, que quien aprueba (o un proxy) podria alterar para que
            // el correo apunte a otro sitio. Sin URL, el correo sale sin boton.
            const url = urlPanel();
            await encolarNotificacion(client, {
                canal: 'email', destinatario: s.email,
                payload: { tipo: 'cuenta_aprobada', nombre_contacto: s.nombre_contacto, ...(url ? { url } : {}) },
            });

            await confirmar();
            res.json({ ok: true, usuario: nuevoUsuario.rows[0] });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar la solicitud' });
    }
});

router.post('/solicitudes/:id/rechazar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const result = await pool.query(
        `UPDATE solicitudes_cliente SET estado = 'rechazada', password_hash = NULL WHERE id = $1 AND estado = 'pendiente' RETURNING id`,
        [req.params.id]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Solicitud de cuenta no encontrada o ya procesada' });
    }
    res.json({ ok: true });
});

module.exports = router;
