const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaImagen } = require('../middleware/upload');
const { supabase, BUCKET_EQUIPOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');
const { calcularEstadoMantencion } = require('../utils/mantencion');
const { ordenSql } = require('../utils/ordenFlota');

const router = express.Router();

const URL_EXPIRACION_SEGUNDOS = 3600;

async function conFotoFirmada(fila) {
    if (!fila.foto_url) return fila;
    const { data, error } = await supabase.storage.from(BUCKET_EQUIPOS).createSignedUrl(fila.foto_url, URL_EXPIRACION_SEGUNDOS);
    return { ...fila, foto_url: error ? null : data.signedUrl };
}

// GET /api/maquinarias - listado con estado (HU-02)
// Permisos (Tabla 6.1): Gerente=Lectura, Administrativo=Lectura/Escritura, Mecanico=Lectura, Cliente=Denegado
// Acepta busqueda (`q`) y los mismos filtros que ofrece Flota, ademas de limit/offset. Los
// filtros se resolvian en el panel sobre los ~500 equipos ya descargados; ahora los resuelve
// Postgres y solo viajan los que se van a mostrar.
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
    // "disponible" = sin cliente asignado, que es como lo entiende el resto del sistema
    if (disponibilidad === 'disponibles') condiciones.push('m.cliente_id IS NULL');
    if (disponibilidad === 'arrendados') condiciones.push('m.cliente_id IS NOT NULL');

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    try {
        const total = await pool.query(`SELECT COUNT(*)::int AS n FROM maquinarias m ${where}`, params);

        // marca, modelo, capacidad, altura y combustible son lo que la tabla de Flota muestra
        // para distinguir un equipo de otro sin abrirlo
        let sql = `SELECT m.id, m.codigo, m.tipo, m.estado, m.ubicacion, m.foto_url, m.categoria_equipo,
                          m.marca, m.modelo, m.capacidad_carga, m.altura_trabajo, m.tipo_combustible,
                          m.cliente_id, c.nombre AS cliente
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar maquinarias' });
    }
});

// GET /api/maquinarias/mias - portal cliente: solo su propia flota
router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    try {
        const result = await pool.query(
            'SELECT id, codigo, tipo, estado, ubicacion, foto_url FROM maquinarias WHERE cliente_id = $1 ORDER BY codigo',
            [req.user.cliente_id]
        );
        res.json(await Promise.all(result.rows.map(conFotoFirmada)));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar tu flota' });
    }
});

// GET /api/maquinarias/resumen - totales de la flota para el encabezado de Flota y sus pestanas.
// Es de toda la flota y no cambia con los filtros: son los numeros que uno mira antes de filtrar.
// "Disponibles" y "arrendados" se cuentan igual que en el Dashboard (segun tenga cliente o no).
router.get('/resumen', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const totales = await pool.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE cliente_id IS NULL)::int AS disponibles,
                    COUNT(*) FILTER (WHERE cliente_id IS NOT NULL)::int AS arrendados,
                    COUNT(*) FILTER (WHERE estado = 'en_mantencion')::int AS en_mantencion,
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el resumen de la flota' });
    }
});

// GET /api/maquinarias/:id - perfil completo del equipo (ficha tecnica)
router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar la maquinaria' });
    }
});

// GET /api/maquinarias/:id/ordenes-trabajo - historial simple de OTs del equipo
router.get('/:id/ordenes-trabajo', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, estado, motivo, diagnostico, fecha_creacion, fecha_cierre
             FROM ordenes_trabajo WHERE maquinaria_id = $1 ORDER BY fecha_creacion DESC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el historial de la maquinaria' });
    }
});

// POST /api/maquinarias - crear maquinaria (con ficha tecnica y foto opcional)
// Permisos: Administrativo tiene Lectura/Escritura sobre Control de Flota
router.post('/', verifyToken, requireRole('administrativo'), subidaImagen.single('archivo'), async (req, res) => {
    const {
        codigo, tipo, cliente_id, ubicacion,
        categoria_equipo, marca, modelo, anio, descripcion,
        numero_serie, numero_motor, numero_chasis, numero_mastil,
        capacidad_carga, altura_trabajo, tipo_combustible,
    } = req.body;
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
        console.error(err);
        res.status(500).json({ error: 'Error al crear maquinaria' });
    }
});

// PATCH /api/maquinarias/:id - editar ficha tecnica (todo opcional, no toca la foto)
router.patch('/:id', verifyToken, requireRole('administrativo'), async (req, res) => {
    const {
        tipo, ubicacion,
        categoria_equipo, marca, modelo, anio, descripcion,
        numero_serie, numero_motor, numero_chasis, numero_mastil,
        capacidad_carga, altura_trabajo, tipo_combustible,
    } = req.body;
    try {
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la maquinaria' });
    }
});

// PATCH /api/maquinarias/:id/foto - reemplazar solo la foto de la ficha tecnica
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

// PATCH /api/maquinarias/:id/estado - actualizar estado (mecanico reporta)
// Permisos: Mecanico y Administrativo pueden escribir; Gerente solo lectura, Cliente denegado
router.patch('/:id/estado', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    const validos = ['operativa', 'en_mantencion', 'fuera_de_servicio'];
    if (!validos.includes(estado)) {
        return res.status(400).json({ error: 'Estado inválido' });
    }
    try {
        const result = await pool.query(
            'UPDATE maquinarias SET estado = $1 WHERE id = $2 RETURNING *',
            [estado, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

module.exports = router;
