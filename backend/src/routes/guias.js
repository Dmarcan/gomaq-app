const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { calcularInicioCobro, calcularDiasTranscurridos } = require('../utils/diasArriendo');
const { leerTextoPdf } = require('../utils/leerTextoPdf');
const { detectarCliente } = require('../utils/detectarCliente');
const { parsearGuia } = require('../utils/parsearDocumento');
const { calcularEstadoMantencion, requiereAviso } = require('../utils/mantencion');
const { encolarAvisoMantencion } = require('./horometro');

const router = express.Router();

// POST /api/maquinarias/guias/detectar - lee el texto del PDF (si lo tiene) y prellena el
// formulario con lo que reconozca (ver utils/parsearDocumento). Mejor esfuerzo: nunca falla
// el flujo, si no encuentra nada devuelve todo en null y el usuario llena a mano.
router.post('/guias/detectar', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido' });
    }
    try {
        const texto = await leerTextoPdf(req.file.buffer);
        const { fecha_detectada, hora_detectada, tipo_detectado, rut_detectado, horometro_detectado } = parsearGuia(texto);

        // el panel maneja un instante completo, asi que si el PDF no trae hora se compone
        // con 00:00 - pero se informa aparte en hora_detectada para que la UI no la de por
        // buena: con HORA_CORTE (utils/diasArriendo) un 00:00 inventado cobraria el dia del
        // despacho. Las guias de GOMAQ no traen hora, se pone siempre a mano.
        let fechaHoraDetectada = null;
        if (fecha_detectada) {
            const fecha = new Date(`${fecha_detectada}T${hora_detectada || '00:00'}:00`);
            if (!isNaN(fecha.getTime())) fechaHoraDetectada = fecha.toISOString();
        }

        res.json({
            fecha_hora_detectada: fechaHoraDetectada,
            hora_detectada: hora_detectada !== null,
            tipo_detectado,
            horometro_detectado,
            cliente_detectado: await detectarCliente(texto, rut_detectado),
            texto_legible: texto.trim().length > 0,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al leer el PDF' });
    }
});

// GET /api/maquinarias/guias/recientes - las ultimas guias subidas, con su PDF.
// La pantalla de Guias era solo un formulario: una vez subida, la guia no se podia volver a ver
// desde ahi para confirmar que quedo bien.
// Con ?sin_documento=1 lista solo las guias que aun no tienen PDF (sin tope de 20: no pueden
// quedar olvidadas), de la mas antigua a la mas nueva.
router.get('/guias/recientes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const soloSinDocumento = req.query.sin_documento === '1';
        const result = await pool.query(
            `SELECT g.id, g.tipo, g.fecha, g.fallido, g.archivo_url, g.created_at,
                    g.archivo_url IS NULL AS falta_documento,
                    m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre,
                    u.nombre AS registrada_por_nombre
             FROM guias g
             JOIN maquinarias m ON m.id = g.maquinaria_id
             LEFT JOIN clientes c ON c.id = g.cliente_id
             LEFT JOIN usuarios u ON u.id = g.registrada_por
             ${soloSinDocumento ? 'WHERE g.archivo_url IS NULL ORDER BY g.created_at ASC' : 'ORDER BY g.created_at DESC LIMIT 20'}`
        );
        const conUrl = await Promise.all(result.rows.map(async ({ archivo_url: ruta, ...fila }) => {
            if (!ruta) return { ...fila, url: null };
            const { data, error } = await supabase.storage.from(BUCKET_DOCUMENTOS).createSignedUrl(ruta, 3600);
            return { ...fila, url: error ? null : data.signedUrl };
        }));
        res.json(conUrl);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar las guías recientes' });
    }
});

// POST /api/maquinarias/:id/guias - subir guia de despacho o recepcion (PDF va a Supabase Storage)
// El PDF es obligatorio salvo que se pida explicitamente `sin_documento` (el equipo salio antes de
// tener la guia escaneada): la guia se crea igual, con quien la registro, y queda marcada como
// "falta el documento" hasta adjuntarlo con POST /guias/:guiaId/archivo. Hay que pedirlo a
// proposito para que olvidar el archivo no deje guias sin documento por accidente.
// Ademas, si la guia no es fallida, refleja el arriendo en la ficha del equipo: un despacho
// lo marca arrendado al cliente indicado, una recepcion lo libera - mismo cliente_id que ya
// usan Dashboard/Flota para calcular disponibles vs arrendados, no hace falta un estado nuevo.
router.post('/:id/guias', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    const { id } = req.params;
    const { tipo, fecha_hora, fallido, cliente_id, horometro } = req.body;
    const sinDocumento = req.body.sin_documento === 'true' || req.body.sin_documento === true;
    const validos = ['despacho', 'recepcion'];
    if (!validos.includes(tipo)) {
        return res.status(400).json({ error: `tipo debe ser uno de: ${validos.join(', ')}` });
    }
    if (!req.file && !sinDocumento) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido, o indica que se despacha sin documento' });
    }
    const esFallido = fallido === 'true' || fallido === true;
    if (tipo === 'despacho' && !esFallido && !cliente_id) {
        return res.status(400).json({ error: 'Elige el cliente al que se despacha el equipo' });
    }

    const client = await pool.connect();
    let rutaStorage = null;
    try {
        if (cliente_id) {
            const clienteExiste = await client.query('SELECT id FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteExiste.rows.length === 0) {
                return res.status(400).json({ error: 'El cliente elegido no existe' });
            }
        }

        // la guia guarda su propio cliente (snapshot del momento del evento): en un despacho
        // es el cliente elegido; en una recepcion, el que tenia la maquina antes de liberarse.
        // Nunca derivarlo despues desde maquinarias.cliente_id - la recepcion lo pone en NULL
        // y facturacion lo necesita (bug corregido en auditoria).
        let clienteGuia = null;
        if (tipo === 'despacho') {
            clienteGuia = cliente_id || null;
        } else {
            const maq = await client.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [id]);
            if (maq.rows.length === 0) {
                return res.status(404).json({ error: 'Maquinaria no encontrada' });
            }
            clienteGuia = maq.rows[0].cliente_id;
        }

        if (req.file) {
            rutaStorage = rutaArchivo(['guias', Number(id)], req.file.originalname);
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) throw errorSubida;
        }

        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id, registrada_por)
             VALUES ($1, $2::tipo_guia, $3, COALESCE($4, now()), COALESCE($5, false), $6, $7)
             RETURNING *, archivo_url IS NULL AS falta_documento`,
            [id, tipo, rutaStorage, fecha_hora || null, esFallido, clienteGuia, req.user.id]
        );

        if (!esFallido) {
            if (tipo === 'despacho') {
                await client.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [cliente_id, id]);
            } else {
                await client.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = $1', [id]);
            }
        }

        // la guia de entrega trae impreso "HOROMETRO: 1156": si el administrativo lo confirmo
        // en el formulario se guarda como una lectura mas del equipo, con origen 'guia'.
        // Misma transaccion que la guia, y mismo patron Outbox para el aviso de mantencion.
        const horometroLectura = horometro === undefined || horometro === null || horometro === ''
            ? null
            : Number(horometro);
        if (horometroLectura !== null && !isNaN(horometroLectura) && horometroLectura >= 0 && !esFallido) {
            const maq = await client.query(
                `SELECT id, codigo, intervalo_mantencion_horas, horometro_ultima_mantencion,
                        alerta_mantencion_enviada
                 FROM maquinarias WHERE id = $1 FOR UPDATE`,
                [id]
            );
            if (maq.rows[0]) {
                await client.query(
                    `INSERT INTO lecturas_horometro
                        (maquinaria_id, valor, origen, cliente_id, guia_id, usuario_id, observacion)
                     VALUES ($1, $2, 'guia', $3, $4, $5, $6)`,
                    [id, horometroLectura, clienteGuia, result.rows[0].id, req.user.id,
                     `Detectado en la guia de ${tipo}`]
                );

                const estado = calcularEstadoMantencion({
                    ultimaLectura: horometroLectura,
                    horometroUltimaMantencion: maq.rows[0].horometro_ultima_mantencion === null
                        ? null
                        : Number(maq.rows[0].horometro_ultima_mantencion),
                    intervaloHoras: Number(maq.rows[0].intervalo_mantencion_horas),
                });
                if (requiereAviso(estado) && !maq.rows[0].alerta_mantencion_enviada) {
                    await encolarAvisoMantencion(client, maq.rows[0], estado);
                }
            }
        }

        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        // compensacion best-effort: si el PDF ya subio pero la BD fallo, no dejar el archivo huerfano
        if (rutaStorage) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
        }
        console.error(err);
        res.status(500).json({ error: 'Error al subir guía' });
    } finally {
        client.release();
    }
});

// POST /api/maquinarias/guias/:guiaId/archivo - adjunta el PDF a una guia que se registro sin
// documento. Solo si todavia no lo tiene: reemplazar un documento ya cargado cambiaria la
// evidencia de un despacho, y eso no se hace en silencio.
router.post('/guias/:guiaId/archivo', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido' });
    }
    let rutaStorage = null;
    try {
        const guia = await pool.query('SELECT id, maquinaria_id, archivo_url FROM guias WHERE id = $1', [req.params.guiaId]);
        if (guia.rows.length === 0) return res.status(404).json({ error: 'Guía no encontrada' });
        if (guia.rows[0].archivo_url) return res.status(409).json({ error: 'La guía ya tiene un documento adjunto' });

        rutaStorage = rutaArchivo(['guias', guia.rows[0].maquinaria_id], req.file.originalname);
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_DOCUMENTOS)
            .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        // la condicion cubre dos adjuntos simultaneos: solo el primero se queda
        const result = await pool.query(
            `UPDATE guias SET archivo_url = $1, documento_adjuntado_at = now()
             WHERE id = $2 AND archivo_url IS NULL RETURNING *, archivo_url IS NULL AS falta_documento`,
            [rutaStorage, req.params.guiaId]
        );
        if (result.rows.length === 0) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
            return res.status(409).json({ error: 'La guía ya tiene un documento adjunto' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        if (rutaStorage) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
        }
        console.error(err);
        res.status(500).json({ error: 'Error al adjuntar el documento de la guía' });
    }
});

// GET /api/maquinarias/:id/dias-arriendo - calculo automatico (HU-01)
router.get('/:id/dias-arriendo', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { id } = req.params;
    try {
        const despachoResult = await pool.query(
            `SELECT * FROM guias WHERE maquinaria_id = $1 AND tipo = 'despacho' AND fallido = false ORDER BY fecha DESC LIMIT 1`,
            [id]
        );
        const despacho = despachoResult.rows[0];
        if (!despacho) {
            return res.json({ dias_transcurridos: 0, facturacion_bloqueada: false, mensaje: 'No hay guia de despacho registrada' });
        }

        const recepcionResult = await pool.query(
            `SELECT * FROM guias WHERE maquinaria_id = $1 AND tipo = 'recepcion' AND fallido = false AND fecha >= $2 ORDER BY fecha ASC LIMIT 1`,
            [id, despacho.fecha]
        );
        const recepcion = recepcionResult.rows[0];

        const inicioCobro = calcularInicioCobro(despacho.fecha);
        const diasTranscurridos = calcularDiasTranscurridos(despacho.fecha, recepcion ? recepcion.fecha : null);

        let facturacionBloqueada = false;
        if (!recepcion) {
            const limite = new Date(inicioCobro.getFullYear(), inicioCobro.getMonth() + 1, 5);
            facturacionBloqueada = new Date() > limite;
        }

        res.json({
            maquinaria_id: Number(id),
            fecha_despacho: despacho.fecha,
            fecha_recepcion: recepcion ? recepcion.fecha : null,
            dias_transcurridos: diasTranscurridos,
            facturacion_bloqueada: facturacionBloqueada,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular dias de arriendo' });
    }
});

module.exports = router;
