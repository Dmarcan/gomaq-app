const express = require('express');
require('../utils/asyncErrores');
const { recalcularClienteEquipo, clienteAlMomento } = require('../utils/clienteEquipo');
const { validarIdsEnRuta, fechaHoraInvalida } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { urlFirmadaONull } = require('../utils/urlsFirmadas');
const { borrarArchivoSubido } = require('../utils/archivosStorage');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { leerTextoPdf } = require('../utils/leerTextoPdf');
const { detectarCliente } = require('../utils/detectarCliente');
const { detectarEquipo } = require('../utils/detectarEquipo');
const { parsearGuia } = require('../utils/parsearDocumento');
const { calcularEstadoMantencion, requiereAviso } = require('../utils/mantencion');
const { encolarAvisoMantencion } = require('./horometro');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../utils/idempotencia');
const { validarCoordenadasFormulario } = require('../utils/geo');

const { sqlGuiasSinDocumento } = require('../utils/pendientes');

const router = express.Router();
validarIdsEnRuta(router, ['id', 'guiaId']);

// lee el texto del PDF (si lo tiene) y prellena el
// formulario con lo que reconozca (ver utils/parsearDocumento). Mejor esfuerzo: nunca falla
// el flujo, si no encuentra nada devuelve todo en null y el usuario llena a mano.
router.post('/guias/detectar', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido' });
    }
    const texto = await leerTextoPdf(req.file.buffer);
    const { fecha_detectada, hora_detectada, tipo_detectado, rut_detectado, horometro_detectado, numero_interno_detectado } = parsearGuia(texto);

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
        equipo_detectado: await detectarEquipo(numero_interno_detectado),
        texto_legible: texto.trim().length > 0,
    });
});

// las ultimas guias subidas, con su PDF.
// Con ?sin_documento=1 lista solo las guias que aun no tienen PDF (sin tope de 20: no pueden
// quedar olvidadas), de la mas antigua a la mas nueva.
router.get('/guias/recientes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
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
             ${soloSinDocumento ? `WHERE ${sqlGuiasSinDocumento('g')} ORDER BY g.created_at ASC` : 'ORDER BY g.created_at DESC LIMIT 20'}`
    );
    const conUrl = await Promise.all(result.rows.map(async ({ archivo_url: ruta, ...fila }) => {
        if (!ruta) return { ...fila, url: null };
        return { ...fila, url: await urlFirmadaONull(supabase, BUCKET_DOCUMENTOS, ruta) };
    }));
    res.json(conUrl);
});

// subir guia de despacho o recepcion (PDF va a Supabase Storage)
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
    // la guia mas reciente por fecha decide el cliente del equipo: una fecha futura o absurda lo
    // dejaria pegado a ese cliente (no hay forma de editar una guia)
    if (fecha_hora !== undefined && fecha_hora !== null && fecha_hora !== '') {
        const t = typeof fecha_hora === 'string' ? new Date(fecha_hora).getTime() : NaN;
        if (fechaHoraInvalida(fecha_hora) || t < Date.UTC(2000, 0, 1) || t > Date.now() + 24 * 3600 * 1000) {
            return res.status(400).json({ error: 'fecha_hora no es válida (no puede ser futura ni anterior al año 2000)' });
        }
    }
    const esFallido = fallido === 'true' || fallido === true;
    if (tipo === 'despacho' && !esFallido && !cliente_id) {
        return res.status(400).json({ error: 'Elige el cliente al que se despacha el equipo' });
    }
    // donde queda el equipo (opcional): solo un despacho la guarda. Sin ella el destino y el mapa usan la
    // ubicacion del cliente. Llega como texto (multipart), se valida y se redondea igual que en el resto.
    const coords = validarCoordenadasFormulario(req.body.latitud, req.body.longitud);
    if (!coords.ok) return res.status(400).json({ error: coords.error });
    const guardarCoords = tipo === 'despacho' && coords.presente;

    // reintentos sin duplicados (migracion 026): el panel manda un uuid_cliente que se conserva
    // mientras se reintenta el mismo envio. Se revisa ANTES de subir el PDF a Supabase.
    const leido = leerUuidCliente(req.body);
    if (!leido.valido) {
        return res.status(400).json({ error: 'uuid_cliente no es un UUID válido' });
    }
    const uuidCliente = leido.uuid;
    // La guia ya registrada con ese uuid. 200 si es el mismo envio: mismo equipo y tipo y, ademas, el
    // mismo cliente (despacho), el mismo estado de fallida y la misma fecha cuando viene explicita
    // (la fecha se compara en SQL con el mismo cast que el INSERT; sin fecha_hora el INSERT usa
    // now() y no hay nada que comparar). Si difiere en algo, 409: es otro envio con la llave repetida.
    const respuestaGuiaExistente = async (db, guia) => {
        let igual = Number(guia.maquinaria_id) === Number(id) && guia.tipo === tipo
            && Boolean(guia.fallido) === esFallido;
        if (igual && tipo === 'despacho' && cliente_id) {
            igual = Number(guia.cliente_id) === Number(cliente_id);
        }
        if (igual && fecha_hora) {
            const r = await db.query('SELECT (fecha = $2::timestamptz) AS misma FROM guias WHERE id = $1', [guia.id, fecha_hora]);
            igual = Boolean(r.rows[0] && r.rows[0].misma);
        }
        if (igual) {
            return { status: 200, cuerpo: { ...guia, falta_documento: guia.archivo_url === null, ya_registrada: true } };
        }
        return { status: 409, cuerpo: { error: 'Ese identificador de envío ya se usó para otra guía distinta' } };
    };
    if (uuidCliente) {
        try {
            const previa = await buscarPorUuid(pool, 'guias', uuidCliente);
            if (previa) {
                const r = await respuestaGuiaExistente(pool, previa);
                return res.status(r.status).json(r.cuerpo);
            }
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: 'Error al revisar la guía' });
        }
    }

    let client;
    let rutaStorage = null;
    const descartarPdfSubido = async () => {
        if (rutaStorage) {
            await borrarArchivoSubido(BUCKET_DOCUMENTOS, rutaStorage);
            rutaStorage = null;
        }
    };
    try {
        // Las revisiones previas y la subida del PDF van con el pool, sin retener una conexion: una
        // subida lenta a Supabase no debe dejar una conexion de la base tomada ni agotar el pool.
        if (cliente_id) {
            const clienteExiste = await pool.query('SELECT id FROM clientes WHERE id = $1', [cliente_id]);
            if (clienteExiste.rows.length === 0) {
                return res.status(400).json({ error: 'El cliente elegido no existe' });
            }
        }

        // el equipo debe existir; se revisa antes de subir el PDF para no dejar un archivo huerfano.
        // El estado real del equipo se lee mas abajo, ya con su fila bloqueada.
        const equipoExiste = await pool.query('SELECT 1 FROM maquinarias WHERE id = $1', [id]);
        if (equipoExiste.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        if (req.file) {
            rutaStorage = rutaArchivo(['guias', Number(id)], req.file.originalname);
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) throw errorSubida;
        }

        client = await pool.connect();
        await client.query('BEGIN');

        // Se bloquea la fila del equipo ANTES de leer su estado o escribir la guia: dos guias del
        // mismo equipo se ejecutan una tras otra y la segunda ve lo que dejo la primera. Es
        // FOR NO KEY UPDATE y no FOR UPDATE porque el INSERT de la guia (y el de la lectura de
        // horometro) toma KEY SHARE sobre el equipo por la clave foranea. La guia no toca la OT,
        // asi que respeta el orden de bloqueo OT -> equipo.
        const equipo = await client.query('SELECT cliente_id FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [id]);
        if (equipo.rows.length === 0) {
            await client.query('ROLLBACK');
            await descartarPdfSubido();
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        // la guia guarda su propio cliente (snapshot del momento del evento): en un despacho
        // es el cliente elegido; en una recepcion, el que tenia la maquina en la fecha de la guia
        // (el del despacho vigente entonces), no el de hoy: una recepcion atrasada no debe quedar
        // con el cliente de un despacho posterior. Nunca derivarlo despues desde
        // maquinarias.cliente_id - la recepcion lo pone en NULL y facturacion lo necesita.
        const clienteGuia = tipo === 'despacho'
            ? (cliente_id || null)
            : await clienteAlMomento(client, id, fecha_hora, equipo.rows[0].cliente_id);

        const result = await client.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id, registrada_por, uuid_cliente, latitud, longitud)
             VALUES ($1, $2::tipo_guia, $3, COALESCE($4, now()), COALESCE($5, false), $6, $7, $8, $9, $10)
             RETURNING *, archivo_url IS NULL AS falta_documento`,
            [id, tipo, rutaStorage, fecha_hora || null, esFallido, clienteGuia, req.user.id, uuidCliente,
             guardarCoords ? coords.latitud : null, guardarCoords ? coords.longitud : null]
        );

        // el cliente del equipo sale de la guia MAS RECIENTE por fecha, no de la ultima en llegar:
        // un despacho o una recepcion atrasados no pisan un estado mas nuevo
        if (!esFallido) {
            await recalcularClienteEquipo(client, id);
        }

        // la guia de entrega trae impreso "HOROMETRO: 1156": si el administrativo lo confirmo
        // en el formulario se guarda como una lectura mas del equipo, con origen 'guia'.
        // Misma transaccion que la guia, y mismo patron Outbox para el aviso de mantencion.
        const horometroLectura = horometro === undefined || horometro === null || horometro === ''
            ? null
            : Number(horometro);
        if (horometroLectura !== null && !isNaN(horometroLectura) && horometroLectura >= 0 && horometroLectura <= 9999999 && !esFallido) {
            const maq = await client.query(
                `SELECT id, codigo, intervalo_mantencion_horas, horometro_ultima_mantencion,
                        alerta_mantencion_enviada
                 FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE`,
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
        if (client) await client.query('ROLLBACK').catch(() => {});
        // compensacion best-effort: si el PDF ya subio pero la BD fallo, no dejar el archivo huerfano
        if (rutaStorage) {
            await borrarArchivoSubido(BUCKET_DOCUMENTOS, rutaStorage);
        }
        // dos envios simultaneos con el mismo uuid: el segundo choca con el UNIQUE, que tambien
        // significa "ya estaba hecho"; se relee la fila del primero
        if (esUuidDuplicado(err) && uuidCliente) {
            try {
                const previa = await buscarPorUuid(pool, 'guias', uuidCliente);
                if (previa) {
                    const r = await respuestaGuiaExistente(pool, previa);
                    return res.status(r.status).json(r.cuerpo);
                }
            } catch (_) { /* cae al 500 de abajo */ }
        }
        console.error(err);
        res.status(500).json({ error: 'Error al subir guía' });
    } finally {
        if (client) client.release();
    }
});

// adjunta el PDF a una guia que se registro sin
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
            await borrarArchivoSubido(BUCKET_DOCUMENTOS, rutaStorage);
            return res.status(409).json({ error: 'La guía ya tiene un documento adjunto' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        if (rutaStorage) {
            await borrarArchivoSubido(BUCKET_DOCUMENTOS, rutaStorage);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al adjuntar el documento de la guía' });
    }
});

module.exports = router;
