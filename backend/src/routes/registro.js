const express = require('express');
require('../utils/asyncErrores');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const { limiteRegistro } = require('../middleware/limites');
const { validarCoordenadas } = require('../utils/geo');
const { rutValido, MENSAJE_RUT_INVALIDO } = require('../utils/rut');
const { normalizarCorreo } = require('../utils/correo');
const { validarPassword } = require('../utils/cuentasInternas');

const router = express.Router();

const textoONulo = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// POST /api/registro-cliente - publico (sin verifyToken): el cliente postula su cuenta,
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
                    estado = 'pendiente', created_at = now()
                 WHERE id = $11
                 RETURNING id, nombre_contacto, nombre_empresa, email, estado, created_at`,
                [nombre_contacto, passwordHash, rut_empresa || null, telefono_whatsapp || null, horario_trabajo || null, horario_colacion || null, direccion || null, textoONulo(nombre_empresa), coords.latitud, coords.longitud, rechazada.rows[0].id]
            );
            return res.status(201).json(actualizada.rows[0]);
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
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Ya hay una solicitud de cuenta con ese correo en revisión' });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar la solicitud' });
    }
});

module.exports = router;
