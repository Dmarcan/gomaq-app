const express = require('express');
require('../utils/asyncErrores');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const { limiteLogin } = require('../middleware/limites');

const router = express.Router();

router.post('/login', limiteLogin, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'email y password son requeridos' });
    }

    try {
        const result = await pool.query(
            'SELECT id, nombre, email, password_hash, rol, cliente_id, estado_cuenta FROM usuarios WHERE email = $1',
            [email]
        );
        const usuario = result.rows[0];
        if (!usuario) {
            // Si no existe en usuarios puede ser un cliente que se registro y aun no lo aprueban.
            // Se le da ese mensaje mas claro, pero SOLO tras validar su contrasena: antes se
            // devolvia sin comprobarla, lo que permitia a cualquiera averiguar que correos
            // estaban registrados probando uno por uno (enumeracion de usuarios).
            const solicitud = await pool.query(
                `SELECT password_hash FROM solicitudes_cliente WHERE email = $1 AND estado = 'pendiente'`,
                [email]
            );
            const pendiente = solicitud.rows[0];
            if (pendiente && await bcrypt.compare(password, pendiente.password_hash)) {
                return res.status(403).json({ error: 'Tu cuenta está en revisión. GOMAQ la aprueba en horario hábil; podrás entrar con este correo apenas quede lista' });
            }
            return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
        }

        const passwordOk = await bcrypt.compare(password, usuario.password_hash);
        if (!passwordOk) {
            return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
        }

        // defensa en profundidad: hoy los usuarios solo se crean ya activos, pero si
        // alguna vez queda uno pendiente/rechazado en la tabla, no debe poder entrar
        if (usuario.estado_cuenta === 'pendiente') {
            return res.status(403).json({ error: 'Tu cuenta está en revisión. GOMAQ la aprueba en horario hábil; podrás entrar con este correo apenas quede lista' });
        }
        if (usuario.estado_cuenta === 'rechazado') {
            return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a GOMAQ' });
        }

        const token = jwt.sign(
            { id: usuario.id, rol: usuario.rol, cliente_id: usuario.cliente_id },
            process.env.JWT_SECRET,
            { expiresIn: '12h' }
        );

        res.json({
            token,
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                rol: usuario.rol,
                cliente_id: usuario.cliente_id,
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al iniciar sesión' });
    }
});

module.exports = router;
