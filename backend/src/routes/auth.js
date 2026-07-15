const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const router = express.Router();

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'email y password son requeridos' });
    }

    try {
        const result = await pool.query(
            'SELECT id, nombre, email, password_hash, rol, cliente_id FROM usuarios WHERE email = $1',
            [email]
        );
        const usuario = result.rows[0];
        if (!usuario) {
            return res.status(401).json({ error: 'Credenciales invalidas' });
        }

        const passwordOk = await bcrypt.compare(password, usuario.password_hash);
        if (!passwordOk) {
            return res.status(401).json({ error: 'Credenciales invalidas' });
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
        res.status(500).json({ error: 'Error al iniciar sesion' });
    }
});

module.exports = router;
