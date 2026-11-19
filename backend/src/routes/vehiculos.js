const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { urlFirmadaONull } = require('../utils/urlsFirmadas');
const { borrarArchivoSubido } = require('../utils/archivosStorage');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { subidaDocumento } = require('../middleware/upload');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

const TIPOS_DOCUMENTO = ['permiso_circulacion', 'revision_tecnica', 'seguro', 'padron', 'otro'];

// El documento de un vehiculo puede ser un PDF (permiso de circulacion) o una foto del papel,
// asi que se aceptan ambos (middleware/upload.js, que ademas comprueba el contenido real).

async function documentosConUrl(vehiculoId) {
    const result = await pool.query(
        'SELECT id, tipo, nombre, archivo_path, created_at FROM documentos_vehiculo WHERE vehiculo_id = $1 ORDER BY created_at DESC',
        [vehiculoId]
    );
    // el bucket es privado: se entrega una URL firmada temporal, igual que guias y facturas
    return Promise.all(result.rows.map(async (doc) => {
        return { ...doc, url: await urlFirmadaONull(supabase, BUCKET_DOCUMENTOS, doc.archivo_path) };
    }));
}

router.get('/mio', verifyToken, requireRole('mecanico'), async (req, res) => {
    const result = await pool.query('SELECT * FROM vehiculos WHERE usuario_id = $1 AND activo = true', [req.user.id]);
    if (result.rows.length === 0) {
        // no es un error: puede que todavia no le hayan asignado furgon
        return res.json({ vehiculo: null, documentos: [] });
    }
    const vehiculo = result.rows[0];
    res.json({ vehiculo, documentos: await documentosConUrl(vehiculo.id) });
});

router.patch('/mio', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { kilometraje } = req.body;
    if (kilometraje === undefined) {
        return res.status(400).json({ error: 'Indica el kilometraje' });
    }
    const km = typeof kilometraje === 'number' || typeof kilometraje === 'string' ? Number(kilometraje) : NaN;
    if (!Number.isFinite(km) || km < 0 || km > 2147483647) {
        return res.status(400).json({ error: 'El kilometraje debe ser un número mayor o igual a 0' });
    }
    const result = await pool.query(
        'UPDATE vehiculos SET kilometraje = $1 WHERE usuario_id = $2 AND activo = true RETURNING *',
        [km, req.user.id]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No tienes un vehículo asignado' });
    }
    res.json(result.rows[0]);
});

router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const result = await pool.query(
        `SELECT v.*, u.nombre AS usuario_nombre
             FROM vehiculos v
             LEFT JOIN usuarios u ON u.id = v.usuario_id
             ORDER BY v.patente`
    );
    res.json(result.rows);
});

// crear un vehiculo y, si corresponde, asignarlo a un mecanico.
// Asignarlo crea ademas su ubicacion de stock: el furgon pasa a tener existencias propias.
// Un vehiculo sin mecanico (el furgon de compras, que no sale a terreno) no lleva stock.
router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { patente, marca, modelo, anio, tipo, kilometraje, usuario_id } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { marca: 100, modelo: 100, tipo: 50 }, ids: ['usuario_id'], numeros: { anio: [1900, 2200], kilometraje: [0, 2147483647] } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!patente || typeof patente !== 'string' || !patente.trim()) {
        return res.status(400).json({ error: 'patente es requerida' });
    }
    if (patente.trim().length > 15) {
        return res.status(400).json({ error: 'patente puede tener hasta 15 caracteres' });
    }
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO vehiculos (patente, marca, modelo, anio, tipo, kilometraje, usuario_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
                patente.trim().toUpperCase(),
                marca || null, modelo || null,
                anio || null, tipo || null,
                kilometraje === undefined || kilometraje === '' ? null : kilometraje,
                usuario_id || null,
            ]
        );
        const vehiculo = result.rows[0];
        if (vehiculo.usuario_id) {
            await client.query(
                `INSERT INTO ubicaciones_stock (nombre, tipo, vehiculo_id) VALUES ($1, 'furgon', $2)`,
                [`Furgon ${vehiculo.patente}`, vehiculo.id]
            );
        }
        await client.query('COMMIT');
        res.status(201).json(vehiculo);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Ya existe un vehículo con esa patente, o ese mecánico ya tiene uno' });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al crear el vehículo' });
    } finally {
        if (client) client.release();
    }
});

router.patch('/:id', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { marca, modelo, anio, tipo, kilometraje, usuario_id, activo } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { marca: 100, modelo: 100, tipo: 50 }, ids: ['usuario_id'], numeros: { anio: [1900, 2200], kilometraje: [0, 2147483647] } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        // `usuario_id` NO puede ir por COALESCE: el panel ofrece "Sin asignar" y mandar null con COALESCE
        // conservaria el valor anterior, asi que desasignar un furgon no haria nada. Se distingue "no mandes
        // el campo" (undefined) de "dejalo vacio" (null), que COALESCE no puede diferenciar.
        const desasignar = usuario_id === null;
        const result = await client.query(
            `UPDATE vehiculos
             SET marca = COALESCE($1, marca), modelo = COALESCE($2, modelo),
                 anio = COALESCE($3, anio), tipo = COALESCE($4, tipo),
                 kilometraje = COALESCE($5, kilometraje),
                 usuario_id = CASE WHEN $6 THEN NULL ELSE COALESCE($7, usuario_id) END,
                 activo = COALESCE($8, activo)
             WHERE id = $9 RETURNING *`,
            [
                marca || null, modelo || null, anio || null, tipo || null,
                kilometraje === undefined || kilometraje === '' ? null : kilometraje,
                desasignar,
                usuario_id || null,
                activo === undefined ? null : Boolean(activo),
                req.params.id,
            ]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Vehículo no encontrado' });
        }
        // si acaba de recibir mecanico y todavia no tenia ubicacion de stock, se le crea
        const vehiculo = result.rows[0];
        if (vehiculo.usuario_id) {
            await client.query(
                `INSERT INTO ubicaciones_stock (nombre, tipo, vehiculo_id)
                 VALUES ($1, 'furgon', $2)
                 ON CONFLICT (vehiculo_id) DO NOTHING`,
                [`Furgon ${vehiculo.patente}`, vehiculo.id]
            );
        }
        await client.query('COMMIT');
        res.json(vehiculo);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Ese mecánico ya tiene un vehículo asignado' });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar el vehículo' });
    } finally {
        if (client) client.release();
    }
});

// permiso de circulacion, revision tecnica, seguro...
// Solo se guardan: no hay control de vencimiento (el calendario chileno de revision tecnica
// depende del tipo de vehiculo y cambia cada año, calcularlo seria mas riesgo que ayuda).
router.post('/:id/documentos', verifyToken, requireRole('mecanico', 'administrativo', 'gerente'),
    subidaDocumento.single('archivo'), async (req, res) => {
        const { tipo, nombre } = req.body;
        if (!req.file) {
            return res.status(400).json({ error: 'archivo es requerido' });
        }
        if (tipo && !TIPOS_DOCUMENTO.includes(tipo)) {
            return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_DOCUMENTO.join(', ')}` });
        }
        let rutaStorage = null;
        try {
            const vehiculo = await pool.query('SELECT id, usuario_id FROM vehiculos WHERE id = $1', [req.params.id]);
            if (vehiculo.rows.length === 0) {
                return res.status(404).json({ error: 'Vehículo no encontrado' });
            }
            // el mecanico solo puede subir documentos de su propio vehiculo
            if (req.user.rol === 'mecanico' && vehiculo.rows[0].usuario_id !== req.user.id) {
                return res.status(403).json({ error: 'Ese vehículo no está asignado a ti' });
            }

            rutaStorage = rutaArchivo(['vehiculos', Number(req.params.id)], req.file.originalname);
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) throw errorSubida;

            const result = await pool.query(
                `INSERT INTO documentos_vehiculo (vehiculo_id, tipo, nombre, archivo_path, usuario_id)
                 VALUES ($1, COALESCE($2::tipo_documento_vehiculo, 'otro'), $3, $4, $5) RETURNING *`,
                [req.params.id, tipo || null, nombre || req.file.originalname, rutaStorage, req.user.id]
            );
            res.status(201).json(result.rows[0]);
        } catch (err) {
            // compensacion: si el archivo subio pero la BD fallo, no dejarlo huerfano
            if (rutaStorage) {
                await borrarArchivoSubido(BUCKET_DOCUMENTOS, rutaStorage);
            }
            console.error(err);
            res.status(500).json({ error: 'Error al subir el documento' });
        }
    });

module.exports = router;
