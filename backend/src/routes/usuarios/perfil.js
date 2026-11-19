// Perfil propio y alertas de cada cuenta.
const express = require('express');
require('../../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../../utils/validacion');
const pool = require('../../config/db');
const { MENSAJE_SOLO_GERENTE, rolesGestionablesPor } = require('../../utils/cuentasInternas');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { rutValido, MENSAJE_RUT_INVALIDO } = require('../../utils/rut');
const { armarAvisos, validarCambioAvisos, aplicarCambioAvisos } = require('../../utils/avisosPerfil');
const { conTransaccion } = require('../../utils/transaccion');
const { esGerenteVedado } = require('./comun');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

// los datos propios del usuario autenticado.
// Incluye lo que se le muestra al cliente en el aviso previo a la visita (HU-07), para que
// el mecanico sepa exactamente que de su ficha sale de la empresa.
const COLUMNAS_PERFIL = 'id, nombre, email, rol, rut, telefono_whatsapp, recibe_alertas_mantencion, avisos_silenciados';
/** La respuesta del perfil: los datos propios y, aparte, la lista de avisos que su rol puede configurar. */
function perfilParaRespuesta(fila) {
    const { recibe_alertas_mantencion: _mantencion, avisos_silenciados: _silenciados, ...datos } = fila;
    return { ...datos, avisos: armarAvisos(fila.rol, fila) };
}

router.get('/mi-perfil', verifyToken, async (req, res) => {
    const result = await pool.query(`SELECT ${COLUMNAS_PERFIL} FROM usuarios WHERE id = $1`, [req.user.id]);
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json(perfilParaRespuesta(result.rows[0]));
});

// el usuario completa o corrige sus datos de contacto y elige que avisos push recibe (RF-05 y RF-06).
// El RUT lo pide el bloque de firmas del talonario y se le muestra al cliente en el aviso. El correo no se cambia
// aqui: es el inicio de sesion. `avisos` es { tipo: true|false } solo con los avisos de su rol (utils/avisosPerfil.js).
router.patch('/mi-perfil', verifyToken, async (req, res) => {
    const { rut, telefono_whatsapp, nombre, avisos } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { rut: 20, telefono_whatsapp: 30, nombre: 150 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if ([rut, telefono_whatsapp, nombre, avisos].every((v) => v === undefined)) {
        return res.status(400).json({ error: 'Indique rut, telefono_whatsapp, nombre y/o avisos' });
    }
    // un RUT con el digito verificador mal escrito se rechaza (vacio sigue valiendo: no cambia nada)
    if (typeof rut === 'string' && rut.trim() !== '' && !rutValido(rut)) {
        return res.status(400).json({ error: MENSAJE_RUT_INVALIDO });
    }
    if (nombre !== undefined && String(nombre).trim() === '') {
        return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    }
    let cambioAvisos = null;
    if (avisos !== undefined) {
        const valido = validarCambioAvisos(req.user.rol, avisos);
        if (valido.error) return res.status(400).json({ error: valido.error });
        cambioAvisos = valido.cambios;
    }
    return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
        // se bloquea la fila: dos cambios de avisos a la vez no deben pisarse
        const actual = await client.query('SELECT avisos_silenciados FROM usuarios WHERE id = $1 FOR UPDATE', [req.user.id]);
        if (actual.rows.length === 0) {
            await deshacer();
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        const nuevos = cambioAvisos ? aplicarCambioAvisos(actual.rows[0].avisos_silenciados, cambioAvisos) : null;
        const result = await client.query(
            `UPDATE usuarios
                 SET rut = COALESCE($1, rut),
                     telefono_whatsapp = COALESCE($2, telefono_whatsapp),
                     nombre = COALESCE($3, nombre),
                     avisos_silenciados = COALESCE($4::text[], avisos_silenciados),
                     recibe_alertas_mantencion = COALESCE($5::boolean, recibe_alertas_mantencion)
                 WHERE id = $6
                 RETURNING ${COLUMNAS_PERFIL}`,
            [
                rut === undefined ? null : (String(rut).trim() || null),
                telefono_whatsapp === undefined ? null : (String(telefono_whatsapp).trim() || null),
                nombre === undefined ? null : String(nombre).trim(),
                nuevos ? nuevos.avisosSilenciados : null,
                nuevos && nuevos.recibeMantencion !== undefined ? nuevos.recibeMantencion : null,
                req.user.id,
            ]
        );
        await confirmar();
        res.json(perfilParaRespuesta(result.rows[0]));
    });
});

// quien recibe el aviso de mantencion proxima y por donde.
// Se configura desde el panel a proposito: cambiar el destinatario no deberia exigir entrar
// por SSH a editar el .env del servidor.
router.patch('/:id/alertas', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { recibe_alertas_mantencion, telefono_whatsapp } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { telefono_whatsapp: 30 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (recibe_alertas_mantencion === undefined && telefono_whatsapp === undefined) {
        return res.status(400).json({ error: 'Indique recibe_alertas_mantencion y/o telefono_whatsapp' });
    }
    if (await esGerenteVedado(req)) return res.status(403).json({ error: MENSAJE_SOLO_GERENTE });
    const result = await pool.query(
        `UPDATE usuarios
             SET recibe_alertas_mantencion = COALESCE($1, recibe_alertas_mantencion),
                 telefono_whatsapp = COALESCE($2, telefono_whatsapp)
             WHERE id = $3 AND rol = ANY($4::rol_usuario[])
             RETURNING id, nombre, email, rol, recibe_alertas_mantencion, telefono_whatsapp`,
        [
            recibe_alertas_mantencion === undefined ? null : recibe_alertas_mantencion === true || recibe_alertas_mantencion === 'true',
            telefono_whatsapp === undefined ? null : (String(telefono_whatsapp).trim() || null),
            req.params.id,
            rolesGestionablesPor(req.user.rol),
        ]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuario interno no encontrado' });
    }
    res.json(result.rows[0]);
});

module.exports = router;
