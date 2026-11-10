const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { verificarDuenoOrden, MENSAJE_OT_CERRADA } = require('../utils/ordenes');
const { supabase, BUCKET } = require('../config/supabase');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../utils/idempotencia');
const { rutaArchivo, rutaPerteneceAOrden } = require('../utils/rutaArchivo');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

// POST /api/ordenes-trabajo/:id/evidencia/solicitar-upload
// Genera una URL prefirmada de Supabase Storage para que el celular suba la foto directo
// Ademas de evidencias, la app sube la firma de recepcion al cerrar la OT (carpeta 'firmas');
// esa NO pasa por /confirmar: su path viaja en el PATCH /finalizar y queda en firmas_recepcion.
const CARPETAS_PERMITIDAS = ['firmas'];
const MENSAJE_ALMACENAMIENTO_NO_DISPONIBLE =
    'El servidor de fotos no está disponible en este momento. Se reintentará más tarde.';

router.post('/:id/evidencia/solicitar-upload', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { id } = req.params;
    const { nombre_archivo, carpeta } = req.body;
    if (!nombre_archivo) {
        return res.status(400).json({ error: 'nombre_archivo es requerido' });
    }
    if (carpeta !== undefined && !CARPETAS_PERMITIDAS.includes(carpeta)) {
        return res.status(400).json({ error: 'carpeta invalida' });
    }
    try {
        const check = await verificarDuenoOrden(id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });

        // la ruta la arma el servidor; del nombre que manda el telefono solo queda la extension
        const carpetas = carpeta ? [carpeta, `ot-${Number(id)}`] : [`ot-${Number(id)}`];
        const path = rutaArchivo(carpetas, nombre_archivo);

        // Si falla el almacenamiento (Supabase caido o pausado) se responde 503 y no 500: es un
        // problema pasajero del lado del servidor, y la app del mecanico lo reintenta sola sin
        // gastar intentos. El mensaje lo puede leer el mecanico.
        let firmada;
        try {
            const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
            if (error) throw error;
            firmada = data;
        } catch (errAlmacenamiento) {
            console.error(errAlmacenamiento);
            return res.status(503).json({ error: MENSAJE_ALMACENAMIENTO_NO_DISPONIBLE });
        }

        res.json({ path: firmada.path, token: firmada.token, signedUrl: firmada.signedUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al generar URL de subida' });
    }
});

// POST /api/ordenes-trabajo/:id/evidencia/confirmar
// Registra la evidencia una vez que el archivo ya fue subido directo a Supabase
router.post('/:id/evidencia/confirmar', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { id } = req.params;
    const { path, tipo } = req.body;
    if (!path) {
        return res.status(400).json({ error: 'path es requerido' });
    }
    // Solo se registran fotos subidas a la carpeta de ESTA orden. Antes se aceptaba cualquier
    // path: un mecanico podia registrar en su OT la ruta de una foto de otra orden (o una firma)
    // y el GET le devolvia una URL firmada para verla.
    if (!rutaPerteneceAOrden(path, `ot-${Number(id)}/`)) {
        return res.status(400).json({ error: 'La foto no corresponde a esta orden de trabajo' });
    }
    // tipo opcional: los APK anteriores al rediseño no lo envian (default 'antes')
    if (tipo !== undefined && !['antes', 'despues'].includes(tipo)) {
        return res.status(400).json({ error: "tipo debe ser 'antes' o 'despues'" });
    }
    const { valido: uuidValido, uuid } = leerUuidCliente(req.body);
    if (!uuidValido) {
        return res.status(400).json({ error: 'uuid_cliente no es un UUID valido' });
    }
    try {
        const check = await verificarDuenoOrden(id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });

        const yaRegistrada = await buscarPorUuid(pool, 'evidencias_fotograficas', uuid);
        if (yaRegistrada) return res.status(200).json(yaRegistrada);

        const result = await pool.query(
            'INSERT INTO evidencias_fotograficas (orden_trabajo_id, path, tipo, uuid_cliente) VALUES ($1, $2, $3, $4) RETURNING *',
            [id, path, tipo || 'antes', uuid]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (esUuidDuplicado(err)) {
            const existente = await buscarPorUuid(pool, 'evidencias_fotograficas', uuid);
            if (existente) return res.status(200).json(existente);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al confirmar evidencia' });
    }
});

// GET /api/ordenes-trabajo/:id/evidencia
// Bucket privado: se genera una URL firmada temporal (1h) por cada foto, en vez de una URL publica permanente
const URL_EXPIRACION_SEGUNDOS = 3600;

router.get('/:id/evidencia', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { id } = req.params;
    try {
        if (req.user.rol === 'mecanico') {
            const check = await verificarDuenoOrden(id, req.user.id);
            if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        }
        const result = await pool.query(
            'SELECT * FROM evidencias_fotograficas WHERE orden_trabajo_id = $1 ORDER BY created_at DESC',
            [id]
        );

        const conUrlFirmada = await Promise.all(result.rows.map(async (fila) => {
            const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(fila.path, URL_EXPIRACION_SEGUNDOS);
            return { ...fila, url: error ? null : data.signedUrl };
        }));

        res.json(conUrlFirmada);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar evidencia' });
    }
});

module.exports = router;
