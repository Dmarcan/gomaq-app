const express = require('express');
require('../utils/asyncErrores');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const { limiteRegistro } = require('../middleware/limites');

const router = express.Router();

const textoONulo = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// POST /api/registro-cliente - publico (sin verifyToken): el cliente postula su cuenta,
// queda "pendiente" hasta que Administrativo/Gerente la revisen en Usuarios y la activen.
// Nunca crea filas en usuarios ni clientes directamente.
router.post('/', limiteRegistro, async (req, res) => {
    const {
        nombre_contacto, nombre_empresa, email, password,
        rut_empresa, telefono_whatsapp, horario_trabajo, horario_colacion, direccion,
    } = req.body;

    if (!nombre_contacto || !email || !password) {
        return res.status(400).json({ error: 'nombre_contacto, email y password son requeridos' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    try {
        const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existente.rows.length > 0) {
            return res.status(400).json({ error: 'Ese correo ya tiene una cuenta' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // un rechazo no es permanente: si existe una solicitud rechazada con este
        // correo, la nueva postulacion la reemplaza (datos frescos, vuelve a pendiente)
        const rechazada = await pool.query(
            `SELECT id FROM solicitudes_cliente WHERE email = $1 AND estado = 'rechazada'`,
            [email]
        );
        if (rechazada.rows.length > 0) {
            const actualizada = await pool.query(
                `UPDATE solicitudes_cliente SET
                    nombre_contacto = $1, password_hash = $2, rut_empresa = $3, telefono_whatsapp = $4,
                    horario_trabajo = $5, horario_colacion = $6, direccion = $7, nombre_empresa = $8,
                    estado = 'pendiente', created_at = now()
                 WHERE id = $9
                 RETURNING id, nombre_contacto, nombre_empresa, email, estado, created_at`,
                [nombre_contacto, passwordHash, rut_empresa || null, telefono_whatsapp || null, horario_trabajo || null, horario_colacion || null, direccion || null, textoONulo(nombre_empresa), rechazada.rows[0].id]
            );
            return res.status(201).json(actualizada.rows[0]);
        }

        const result = await pool.query(
            `INSERT INTO solicitudes_cliente
                (nombre_contacto, email, password_hash, rut_empresa, telefono_whatsapp, horario_trabajo, horario_colacion, direccion, nombre_empresa)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, nombre_contacto, nombre_empresa, email, estado, created_at`,
            [nombre_contacto, email, passwordHash, rut_empresa || null, telefono_whatsapp || null, horario_trabajo || null, horario_colacion || null, direccion || null, textoONulo(nombre_empresa)]
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
