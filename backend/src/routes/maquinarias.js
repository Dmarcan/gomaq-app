const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaImagen } = require('../middleware/upload');
const { supabase, BUCKET_EQUIPOS, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { urlFirmadaONull } = require('../utils/urlsFirmadas');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');
const { calcularEstadoMantencion } = require('../utils/mantencion');
const { ordenSql } = require('../utils/ordenFlota');
const { leerLineaTiempo } = require('../utils/lineaTiempoEquipo');
const { visiblePara, construirSqlDocumentos, construirSqlEquiposDelCliente, filaPublica } = require('../utils/documentosEquipo');

const { ESTADOS_EQUIPO } = require('../utils/estadoEquipo');
const { SQL_ASISTENCIA_ABIERTA } = require('../utils/asistenciaCliente');
const { columnaOtAbierta } = require('../utils/otAbiertaEquipo');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

async function conFotoFirmada(fila) {
    if (!fila.foto_url) return fila;
    return { ...fila, foto_url: await urlFirmadaONull(supabase, BUCKET_EQUIPOS, fila.foto_url) };
}

// Permisos (Tabla 6.1): Gerente=Lectura, Administrativo=Lectura/Escritura, Mecanico=Lectura, Cliente=Denegado
// Acepta busqueda (`q`) y los mismos filtros que ofrece Flota, ademas de limit/offset: los resuelve
// Postgres y solo viajan los equipos que se van a mostrar.
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { limit, offset } = parsearPaginacion(req.query);
    const q = parsearBusqueda(req.query);
    const { estado, categoria, cliente_id, disponibilidad } = req.query;

    const condiciones = [];
    const params = [];
    if (q) {
        params.push(`%${q}%`);
        condiciones.push(`(m.codigo ILIKE $${params.length} OR m.tipo ILIKE $${params.length}
                           OR m.marca ILIKE $${params.length} OR m.modelo ILIKE $${params.length})`);
    }
    if (estado) {
        params.push(estado);
        condiciones.push(`m.estado = $${params.length}::estado_maquinaria`);
    }
    if (categoria) {
        params.push(categoria);
        condiciones.push(`m.categoria_equipo = $${params.length}::categoria_equipo`);
    }
    if (cliente_id) {
        params.push(cliente_id);
        condiciones.push(`m.cliente_id = $${params.length}`);
    }
    // "disponible" = se lo puede arrendar hoy: sin cliente y operativo. Igual que el Dashboard
    if (disponibilidad === 'disponibles') condiciones.push("(m.cliente_id IS NULL AND m.estado = 'operativa')");
    if (disponibilidad === 'arrendados') condiciones.push('m.cliente_id IS NOT NULL');

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM maquinarias m ${where}`, params);

    // marca, modelo, capacidad, altura y combustible son lo que la tabla de Flota muestra
    // para distinguir un equipo de otro sin abrirlo
    let sql = `SELECT m.id, m.codigo, m.tipo, m.estado, m.ubicacion, m.foto_url, m.categoria_equipo,
                          m.marca, m.modelo, m.capacidad_carga, m.altura_trabajo, m.tipo_combustible,
                          m.cliente_id, c.nombre AS cliente${columnaOtAbierta(req.user.rol)}
                   FROM maquinarias m
                   LEFT JOIN clientes c ON c.id = m.cliente_id
                   ${where}
                   ORDER BY ${ordenSql(req.query.orden, req.query.dir)}`;
    const paramsPagina = [...params];
    if (limit !== null) {
        paramsPagina.push(limit, offset);
        sql += ` LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}`;
    }
    const result = await pool.query(sql, paramsPagina);

    res.json(envolver(
        await Promise.all(result.rows.map(conFotoFirmada)),
        total.rows[0].n,
        { limit, offset }
    ));
});

router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    const result = await pool.query(
        // asistencia_abierta: la solicitud de asistencia que sigue en curso (pendiente u orden sin terminar) con lo que el
        // cliente ya envio, para que el portal lo muestre y deje agregar un detalle (solo mientras esta pendiente)
        `SELECT m.id, m.codigo, m.tipo, m.estado, m.ubicacion, m.foto_url,
                (SELECT json_build_object(
                            'id', s.id, 'estado', s.estado, 'ot_estado', ot.estado, 'descripcion', s.descripcion, 'gravedad', s.gravedad,
                            'detalles', (SELECT COALESCE(json_agg(json_build_object('texto', d.texto, 'gravedad', d.gravedad) ORDER BY d.created_at), '[]'::json)
                                         FROM solicitudes_detalle d WHERE d.solicitud_id = s.id))
                 FROM solicitudes s LEFT JOIN ordenes_trabajo ot ON ot.id = s.orden_trabajo_id
                 WHERE s.maquinaria_id = m.id AND s.cliente_id = m.cliente_id AND ${SQL_ASISTENCIA_ABIERTA}
                 ORDER BY s.created_at DESC LIMIT 1) AS asistencia_abierta
         FROM maquinarias m WHERE m.cliente_id = $1 ORDER BY m.codigo`,
        [req.user.cliente_id]
    );
    res.json(await Promise.all(result.rows.map(conFotoFirmada)));
});

// portal cliente: los equipos con documentos propios, los
// que tiene hoy (actual = true) y los que tuvo antes. Sale SOLO de los documentos que llevan su
// cliente_id (guias, OT y facturas, con las mismas reglas que /:id/documentos), nunca del cliente
// actual del equipo; el cliente sale del token y no se acepta por parametro. /mias no cambia.
router.get('/mias/historicos', verifyToken, requireRole('cliente'), async (req, res) => {
    const clienteId = Number(req.user.cliente_id);
    if (!Number.isSafeInteger(clienteId) || clienteId < 1 || clienteId > 2147483647) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    // sin registro de la 010 no se puede confiar en ninguna guia anterior
    const m = await pool.query("SELECT aplicada_at FROM schema_migraciones WHERE nombre LIKE '010%' LIMIT 1");
    const r = await pool.query(construirSqlEquiposDelCliente(), [clienteId, m.rows[0] ? m.rows[0].aplicada_at : 'infinity']);
    res.set('Cache-Control', 'no-store');
    res.json(r.rows);
});

// totales de la flota para el encabezado de Flota y sus pestanas.
// Es de toda la flota y no cambia con los filtros: son los numeros que uno mira antes de filtrar.
// "Disponibles" y "arrendados" se cuentan igual que en el Dashboard: disponible es sin cliente y
// operativo; arrendado es tener cliente. Un equipo en mantencion sin cliente no es ninguno de los dos.
router.get('/resumen', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const totales = await pool.query(
        `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE cliente_id IS NULL AND estado = 'operativa')::int AS disponibles,
                    COUNT(*) FILTER (WHERE cliente_id IS NOT NULL)::int AS arrendados,
                    COUNT(*) FILTER (WHERE estado = 'en_mantencion')::int AS en_mantencion,
                    COUNT(*) FILTER (WHERE estado = 'parcialmente_operativa')::int AS parcialmente_operativa,
                    COUNT(*) FILTER (WHERE estado = 'fuera_de_servicio')::int AS fuera_de_servicio
             FROM maquinarias`
    );
    const porCategoria = await pool.query(
        `SELECT categoria_equipo, COUNT(*)::int AS n FROM maquinarias
             WHERE categoria_equipo IS NOT NULL GROUP BY categoria_equipo`
    );
    res.json({
        ...totales.rows[0],
        por_categoria: Object.fromEntries(porCategoria.rows.map((r) => [r.categoria_equipo, r.n])),
    });
});

// guias, ordenes de trabajo y facturas del equipo.
// Administrativo y gerente ven todo (tambien lo que no tiene cliente) y pueden filtrar con
// ?cliente_id. Un cliente ve SOLO los documentos que llevan su cliente_id (el que el documento
// guardo en su momento, no el de hoy del equipo), ignora ?cliente_id y no ve valorizaciones.
// Las guias creadas antes de la migracion 010 no se muestran al cliente: esa migracion les copio el
// cliente de hoy del equipo y no se sabe si era el de entonces. El mecanico no entra.
// Nunca se devuelve archivo_url: solo URLs firmadas de 1 hora.
const ID_MAXIMO = 2147483647; // integer de Postgres: un id mayor daria 500 en vez de 400
const idValido = (n) => Number.isSafeInteger(n) && n >= 1 && n <= ID_MAXIMO;

router.get('/:id/documentos', verifyToken, requireRole('gerente', 'administrativo', 'cliente'), async (req, res) => {
    const equipoId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!idValido(equipoId)) return res.status(400).json({ error: 'Id de equipo inválido' });
    const rol = req.user.rol;
    const esCliente = rol === 'cliente';
    if (esCliente && !idValido(Number(req.user.cliente_id))) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    let params;
    if (esCliente) {
        // sin registro de la 010 (base armada a mano) no se puede confiar en ninguna guia anterior
        const m = await pool.query("SELECT aplicada_at FROM schema_migraciones WHERE nombre LIKE '010%' LIMIT 1");
        params = [equipoId, Number(req.user.cliente_id), m.rows[0] ? m.rows[0].aplicada_at : 'infinity'];
    } else {
        // el filtro es opcional, pero si viene tiene que ser un id: uno repetido o invalido es 400
        const filtro = req.query.cliente_id;
        let clienteFiltro = null;
        if (filtro !== undefined && filtro !== '') {
            clienteFiltro = typeof filtro === 'string' && /^\d+$/.test(filtro) ? Number(filtro) : NaN;
            if (!idValido(clienteFiltro)) return res.status(400).json({ error: 'cliente_id inválido' });
        }
        const equipo = await pool.query('SELECT 1 FROM maquinarias WHERE id = $1', [equipoId]);
        if (equipo.rows.length === 0) return res.status(404).json({ error: 'Equipo no encontrado' });
        params = [equipoId, clienteFiltro];
    }
    const r = await pool.query(construirSqlDocumentos({ rol }), params);
    const filas = r.rows.filter((d) => visiblePara(d, req.user) || (!esCliente && d.cliente_id === null));
    // el cliente recibe el MISMO 404 exista o no el equipo y tenga otros clientes documentos o no:
    // asi no puede descubrir que ids de equipo existen
    if (esCliente && filas.length === 0) return res.status(404).json({ error: 'No hay documentos de este equipo' });

    const equipo = await pool.query('SELECT id, codigo, tipo FROM maquinarias WHERE id = $1', [equipoId]);
    const ids = [...new Set(filas.map((d) => d.cliente_id).filter((x) => x !== null))];
    const nombres = ids.length
        ? Object.fromEntries((await pool.query('SELECT id, nombre FROM clientes WHERE id = ANY($1)', [ids])).rows.map((c) => [c.id, c.nombre]))
        : {};
    const documentos = await Promise.all(filas.map(async (d) => {
        let urlFirmada = null;
        if (d.archivo_url) {
            // un archivo que no se pueda firmar deja ese documento sin enlace, no tumba la lista
            try {
                urlFirmada = await urlFirmadaONull(supabase, BUCKET_DOCUMENTOS, d.archivo_url);
            } catch (errFirma) {
                console.error('No se pudo firmar un documento del equipo:', errFirma.message);
            }
        }
        return { ...filaPublica(d, { rol, urlFirmada }), cliente_nombre: d.cliente_id === null ? null : (nombres[d.cliente_id] || null) };
    }));
    res.json({ maquinaria: equipo.rows[0], documentos });
});

// guias, ordenes de trabajo, facturas y lecturas de horometro del
// equipo, del evento mas reciente al mas antiguo, agrupados en tramos de un mismo cliente (el que guardo
// cada registro en su momento). Lleva montos por evento, por eso solo gerente y administrativo; no entrega
// archivos ni URLs firmadas (el documento se abre en la pestana Documentos). Maximo 500 eventos (`hay_mas`).
// Los totales de costos siguen saliendo de /api/rentabilidad/maquinaria/:id.
router.get('/:id/linea-tiempo', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const equipoId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!idValido(equipoId)) return res.status(400).json({ error: 'Id de equipo inválido' });
    const equipo = await pool.query('SELECT id, codigo, tipo FROM maquinarias WHERE id = $1', [equipoId]);
    if (equipo.rows.length === 0) return res.status(404).json({ error: 'Equipo no encontrado' });
    res.json({ maquinaria: equipo.rows[0], ...(await leerLineaTiempo(pool, equipoId)) });
});

router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const result = await pool.query(
        `SELECT m.*, c.nombre AS cliente
             FROM maquinarias m
             LEFT JOIN clientes c ON c.id = m.cliente_id
             WHERE m.id = $1`,
        [req.params.id]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Maquinaria no encontrada' });
    }
    const equipo = result.rows[0];
    // cuanto falta para la preventiva, para mostrarlo en la cabecera del perfil
    const lectura = await pool.query(
        'SELECT valor FROM lecturas_horometro WHERE maquinaria_id = $1 ORDER BY fecha DESC LIMIT 1',
        [req.params.id]
    );
    const ultima = lectura.rows[0] ? Number(lectura.rows[0].valor) : null;
    const mantencion = {
        ultima_lectura: ultima,
        intervalo_horas: Number(equipo.intervalo_mantencion_horas),
        ...calcularEstadoMantencion({
            ultimaLectura: ultima,
            horometroUltimaMantencion: equipo.horometro_ultima_mantencion === null ? null : Number(equipo.horometro_ultima_mantencion),
            intervaloHoras: Number(equipo.intervalo_mantencion_horas),
        }),
    };
    res.json({ ...(await conFotoFirmada(equipo)), mantencion });
});

router.get('/:id/ordenes-trabajo', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const result = await pool.query(
        `SELECT id, estado, motivo, diagnostico, fecha_creacion, fecha_cierre
             FROM ordenes_trabajo WHERE maquinaria_id = $1 ORDER BY fecha_creacion DESC`,
        [req.params.id]
    );
    res.json(result.rows);
});

// Permisos: Administrativo tiene Lectura/Escritura sobre Control de Flota
router.post('/', verifyToken, requireRole('administrativo'), subidaImagen.single('archivo'), async (req, res) => {
    const {
        codigo, tipo, cliente_id, ubicacion,
        categoria_equipo, marca, modelo, anio, descripcion,
        numero_serie, numero_motor, numero_chasis, numero_mastil,
        capacidad_carga, altura_trabajo, tipo_combustible,
    } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { codigo: 20, tipo: 100, ubicacion: 150, marca: 100, modelo: 100, descripcion: 2000, numero_serie: 100, numero_motor: 100, numero_chasis: 100, numero_mastil: 100 }, ids: ['cliente_id'], numeros: { anio: [1900, 2200], capacidad_carga: [0, 99999999], altura_trabajo: [0, 99999999] } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!codigo || !tipo) {
        return res.status(400).json({ error: 'codigo y tipo son requeridos' });
    }
    let fotoPath = null;
    try {
        if (req.file) {
            fotoPath = rutaArchivo(['equipos', codigo], req.file.originalname);
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_EQUIPOS)
                .upload(fotoPath, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) throw errorSubida;
        }

        const result = await pool.query(
            `INSERT INTO maquinarias (
                codigo, tipo, cliente_id, ubicacion, foto_url,
                categoria_equipo, marca, modelo, anio, descripcion,
                numero_serie, numero_motor, numero_chasis, numero_mastil,
                capacidad_carga, altura_trabajo, tipo_combustible
             ) VALUES ($1, $2, $3, $4, $5, $6::categoria_equipo, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::tipo_combustible_maquinaria)
             RETURNING *`,
            [
                codigo, tipo, cliente_id || null, ubicacion || null, fotoPath,
                categoria_equipo || null, marca || null, modelo || null, anio || null, descripcion || null,
                numero_serie || null, numero_motor || null, numero_chasis || null, numero_mastil || null,
                capacidad_carga || null, altura_trabajo || null, tipo_combustible || null,
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (fotoPath) {
            await supabase.storage.from(BUCKET_EQUIPOS).remove([fotoPath]).catch(() => {});
        }
        // codigo es unico: repetirlo es un error de quien escribe, no del servidor, y tiene que
        // poder corregirlo sin adivinar
        if (err.code === '23505') {
            return res.status(409).json({ error: `Ya existe un equipo con el código ${codigo}.` });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al crear maquinaria' });
    }
});

router.patch('/:id', verifyToken, requireRole('administrativo'), async (req, res) => {
    const {
        tipo, ubicacion,
        categoria_equipo, marca, modelo, anio, descripcion,
        numero_serie, numero_motor, numero_chasis, numero_mastil,
        capacidad_carga, altura_trabajo, tipo_combustible,
    } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { codigo: 20, tipo: 100, ubicacion: 150, marca: 100, modelo: 100, descripcion: 2000, numero_serie: 100, numero_motor: 100, numero_chasis: 100, numero_mastil: 100 }, ids: ['cliente_id'], numeros: { anio: [1900, 2200], capacidad_carga: [0, 99999999], altura_trabajo: [0, 99999999] } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    const result = await pool.query(
        `UPDATE maquinarias SET
                tipo = COALESCE($1, tipo),
                ubicacion = COALESCE($2, ubicacion),
                categoria_equipo = COALESCE($3::categoria_equipo, categoria_equipo),
                marca = COALESCE($4, marca),
                modelo = COALESCE($5, modelo),
                anio = COALESCE($6, anio),
                descripcion = COALESCE($7, descripcion),
                numero_serie = COALESCE($8, numero_serie),
                numero_motor = COALESCE($9, numero_motor),
                numero_chasis = COALESCE($10, numero_chasis),
                numero_mastil = COALESCE($11, numero_mastil),
                capacidad_carga = COALESCE($12, capacidad_carga),
                altura_trabajo = COALESCE($13, altura_trabajo),
                tipo_combustible = COALESCE($14::tipo_combustible_maquinaria, tipo_combustible)
             WHERE id = $15 RETURNING *`,
        [
            tipo || null, ubicacion || null, categoria_equipo || null, marca || null, modelo || null,
            anio || null, descripcion || null, numero_serie || null, numero_motor || null,
            numero_chasis || null, numero_mastil || null, capacidad_carga || null, altura_trabajo || null,
            tipo_combustible || null, req.params.id,
        ]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Maquinaria no encontrada' });
    }
    res.json(await conFotoFirmada(result.rows[0]));
});

router.patch('/:id/foto', verifyToken, requireRole('administrativo'), subidaImagen.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (imagen) es requerido' });
    }
    let fotoPath = null;
    try {
        const actual = await pool.query('SELECT codigo FROM maquinarias WHERE id = $1', [req.params.id]);
        if (actual.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        fotoPath = rutaArchivo(['equipos', actual.rows[0].codigo], req.file.originalname);
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_EQUIPOS)
            .upload(fotoPath, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        const result = await pool.query('UPDATE maquinarias SET foto_url = $1 WHERE id = $2 RETURNING *', [fotoPath, req.params.id]);
        res.json(await conFotoFirmada(result.rows[0]));
    } catch (err) {
        if (fotoPath) {
            await supabase.storage.from(BUCKET_EQUIPOS).remove([fotoPath]).catch(() => {});
        }
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la foto' });
    }
});

// Permisos: Mecanico y Administrativo pueden escribir; Gerente solo lectura, Cliente denegado
router.patch('/:id/estado', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    if (!ESTADOS_EQUIPO.includes(estado)) {
        return res.status(400).json({ error: 'Estado inválido' });
    }
    const result = await pool.query(
        // quien lo fijo: el cierre de una orden no pisa un estado puesto a mano desde el panel
        'UPDATE maquinarias SET estado = $1, estado_origen = $3 WHERE id = $2 RETURNING *',
        [estado, id, req.user.rol === 'mecanico' ? 'mecanico' : 'panel']
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Maquinaria no encontrada' });
    }
    res.json(result.rows[0]);
});

module.exports = router;
