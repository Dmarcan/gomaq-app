const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { calcularFacturableOt } = require('../utils/facturableOt');
const { validarTransferencia } = require('../utils/stock');
const { verificarDuenoOrden } = require('../utils/ordenes');

const router = express.Router();

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** La bodega central: destino de las compras y origen de lo que se carga a los furgones. */
async function bodegaCentral(client) {
    const r = await client.query("SELECT id FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1");
    return r.rows[0] ? r.rows[0].id : null;
}

/** Ubicacion de stock del mecanico: el furgon de su vehiculo asignado. */
async function furgonDe(client, usuarioId) {
    const r = await client.query(
        `SELECT u.id FROM ubicaciones_stock u
         JOIN vehiculos v ON v.id = u.vehiculo_id
         WHERE v.usuario_id = $1 AND u.activa = true AND v.activo = true
         LIMIT 1`,
        [usuarioId]
    );
    return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Mueve stock en una ubicacion y deja `insumos.stock_actual` como el total de todas ellas.
 *
 * Mantener `stock_actual` derivado, en vez de borrarlo, deja intacta la pantalla de Insumos
 * del panel y `GET /api/insumos` - mismo criterio que se uso con ordenes_trabajo.facturable.
 *
 * La cantidad puede quedar negativa: si el mecanico instalo un repuesto que el sistema no
 * tenia registrado en su furgon, bloquearlo solo haria que el dato se pierda.
 */
async function moverStock(client, { ubicacionId, insumoId, delta }) {
    await client.query(
        `INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad)
         VALUES ($1, $2, $3)
         ON CONFLICT (ubicacion_id, insumo_id)
         DO UPDATE SET cantidad = stock_ubicacion.cantidad + EXCLUDED.cantidad`,
        [ubicacionId, insumoId, delta]
    );
    await client.query(
        `UPDATE insumos SET stock_actual = COALESCE(
            (SELECT SUM(cantidad) FROM stock_ubicacion WHERE insumo_id = $1), 0
         ) WHERE id = $1`,
        [insumoId]
    );
}

// GET /api/insumos - catalogo completo (mecanico lo usa para el picker de consumo)
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM insumos ORDER BY nombre ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar insumos' });
    }
});

// POST /api/insumos - crear item de catalogo
router.post('/', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    if (!nombre || !unidad_medida) {
        return res.status(400).json({ error: 'nombre y unidad_medida son requeridos' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO insumos (nombre, unidad_medida, costo_unitario) VALUES ($1, $2, $3) RETURNING *`,
            [nombre, unidad_medida, costo_unitario || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear insumo' });
    }
});

// PATCH /api/insumos/:id - editar nombre/unidad/costo
router.patch('/:id', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    try {
        const result = await pool.query(
            `UPDATE insumos SET
                nombre = COALESCE($1, nombre),
                unidad_medida = COALESCE($2, unidad_medida),
                costo_unitario = COALESCE($3, costo_unitario)
             WHERE id = $4 RETURNING *`,
            [nombre || null, unidad_medida || null, costo_unitario || null, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar insumo' });
    }
});

// GET /api/insumos/mi-furgon - lo que lleva el furgon del mecanico autenticado
router.get('/mi-furgon', verifyToken, requireRole('mecanico'), async (req, res) => {
    const client = await pool.connect();
    try {
        const furgon = await furgonDe(client, req.user.id);
        if (!furgon) {
            // no es error: puede que todavia no le hayan asignado vehiculo
            return res.json({ ubicacion_id: null, items: [] });
        }
        const result = await client.query(
            `SELECT su.insumo_id, su.cantidad, i.nombre, i.unidad_medida
             FROM stock_ubicacion su
             JOIN insumos i ON i.id = su.insumo_id
             WHERE su.ubicacion_id = $1 AND su.cantidad <> 0
             ORDER BY i.nombre`,
            [furgon]
        );
        res.json({
            ubicacion_id: furgon,
            items: result.rows.map((f) => ({ ...f, cantidad: num(f.cantidad) })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el stock de su furgon' });
    } finally {
        client.release();
    }
});

// POST /api/insumos/transferencia - el mecanico carga repuestos de la bodega a su furgon.
//
// Solo con señal, a proposito: la carga se hace en el taller y validar contra la bodega en el
// momento evita que dos mecanicos reclamen sin saberlo la misma pieza. Por eso aca SI se
// rechaza sacar mas de lo que hay, a diferencia del consumo en terreno.
router.post('/transferencia', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { insumo_id, cantidad } = req.body;
    if (!insumo_id) {
        return res.status(400).json({ error: 'insumo_id es requerido' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bodega = await bodegaCentral(client);
        // un mecanico siempre carga a SU furgon: aceptar un destino del cuerpo le permitia
        // cargarle stock al furgon de otro. Solo el administrativo puede indicar destino.
        const destino = req.user.rol === 'administrativo' && req.body.ubicacion_destino_id
            ? req.body.ubicacion_destino_id
            : await furgonDe(client, req.user.id);
        if (!destino) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No tiene un furgon asignado' });
        }

        // FOR UPDATE: dos mecanicos cargando el mismo repuesto a la vez no pueden pasarse del stock
        const existencia = await client.query(
            'SELECT cantidad FROM stock_ubicacion WHERE ubicacion_id = $1 AND insumo_id = $2 FOR UPDATE',
            [bodega, insumo_id]
        );
        const disponible = existencia.rows[0] ? Number(existencia.rows[0].cantidad) : 0;

        const validacion = validarTransferencia({
            cantidad,
            disponibleOrigen: disponible,
            origenId: bodega,
            destinoId: destino,
        });
        if (!validacion.valida) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: validacion.error });
        }

        await moverStock(client, { ubicacionId: bodega, insumoId: insumo_id, delta: -cantidad });
        await moverStock(client, { ubicacionId: destino, insumoId: insumo_id, delta: cantidad });
        await client.query(
            `INSERT INTO movimientos_insumo
                (insumo_id, cantidad, tipo, usuario_id, ubicacion_origen_id, ubicacion_destino_id, descripcion)
             VALUES ($1, $2, 'salida', $3, $4, $5, 'Carga de furgon desde bodega')`,
            [insumo_id, cantidad, req.user.id, bodega, destino]
        );

        await client.query('COMMIT');
        res.status(201).json({ ok: true, ubicacion_destino_id: destino, cantidad: Number(cantidad) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al cargar el furgon' });
    } finally {
        client.release();
    }
});

// GET /api/insumos/descuadres - existencias negativas, para que bodega las cuadre.
// Aparecen cuando un mecanico registro el consumo de un repuesto que el sistema no tenia en
// su furgon; el dato del trabajo se conserva y la diferencia queda a la vista.
router.get('/descuadres', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT su.cantidad, i.id AS insumo_id, i.nombre AS insumo_nombre, i.unidad_medida,
                    u.nombre AS ubicacion_nombre, u.tipo AS ubicacion_tipo, v.patente
             FROM stock_ubicacion su
             JOIN insumos i ON i.id = su.insumo_id
             JOIN ubicaciones_stock u ON u.id = su.ubicacion_id
             LEFT JOIN vehiculos v ON v.id = u.vehiculo_id
             WHERE su.cantidad < 0
             ORDER BY su.cantidad ASC`
        );
        res.json(result.rows.map((f) => ({ ...f, cantidad: num(f.cantidad) })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar los descuadres de stock' });
    }
});

// GET /api/insumos/por-ubicacion - existencias de todo el inventario, agrupadas por lugar
router.get('/por-ubicacion', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id AS ubicacion_id, u.nombre AS ubicacion_nombre, u.tipo AS ubicacion_tipo,
                    v.patente, usr.nombre AS mecanico_nombre,
                    i.id AS insumo_id, i.nombre AS insumo_nombre, i.unidad_medida, su.cantidad
             FROM ubicaciones_stock u
             LEFT JOIN vehiculos v ON v.id = u.vehiculo_id
             LEFT JOIN usuarios usr ON usr.id = v.usuario_id
             LEFT JOIN stock_ubicacion su ON su.ubicacion_id = u.id AND su.cantidad <> 0
             LEFT JOIN insumos i ON i.id = su.insumo_id
             WHERE u.activa = true
             ORDER BY u.tipo, u.nombre, i.nombre`
        );
        res.json(result.rows.map((f) => ({ ...f, cantidad: num(f.cantidad) })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el inventario por ubicacion' });
    }
});

// POST /api/insumos/:id/ingreso - suma stock (compra de insumo)
router.post('/:id/ingreso', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { cantidad } = req.body;
    if (!cantidad || isNaN(cantidad) || Number(cantidad) <= 0) {
        return res.status(400).json({ error: 'cantidad (numerica positiva) es requerida' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existe = await client.query('SELECT id FROM insumos WHERE id = $1', [req.params.id]);
        if (existe.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        // una compra entra siempre a la bodega central; de ahi se reparte a los furgones
        const bodega = await bodegaCentral(client);
        if (!bodega) {
            await client.query('ROLLBACK');
            return res.status(500).json({ error: 'No hay una bodega central configurada' });
        }
        await moverStock(client, { ubicacionId: bodega, insumoId: req.params.id, delta: cantidad });
        await client.query(
            `INSERT INTO movimientos_insumo (insumo_id, cantidad, tipo, usuario_id, ubicacion_destino_id)
             VALUES ($1, $2, 'ingreso', $3, $4)`,
            [req.params.id, cantidad, req.user.id, bodega]
        );
        const result = await client.query('SELECT * FROM insumos WHERE id = $1', [req.params.id]);
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al registrar ingreso de stock' });
    } finally {
        client.release();
    }
});

// GET /api/insumos/movimientos - consumos recientes, con datos de OT/insumo/usuario para auditoria
router.get('/movimientos', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT mi.*, i.nombre AS insumo_nombre, i.unidad_medida, u.nombre AS usuario_nombre,
                    m.codigo AS maquinaria_codigo
             FROM movimientos_insumo mi
             JOIN insumos i ON i.id = mi.insumo_id
             LEFT JOIN usuarios u ON u.id = mi.usuario_id
             LEFT JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
             LEFT JOIN maquinarias m ON m.id = ot.maquinaria_id
             ORDER BY mi.created_at DESC
             LIMIT 100`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar movimientos de insumos' });
    }
});

// GET /api/insumos/orden/:ordenId - insumos consumidos por una OT puntual
router.get('/orden/:ordenId', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        // un mecanico solo ve las lineas de sus propias OT, igual que en el resto de su flujo
        if (req.user.rol === 'mecanico') {
            const check = await verificarDuenoOrden(req.params.ordenId, req.user.id);
            if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });
        }
        const result = await pool.query(
            // LEFT JOIN: una linea puede estar escrita a mano, sin insumo del catalogo
            `SELECT mi.*, i.nombre AS insumo_nombre, i.unidad_medida
             FROM movimientos_insumo mi
             LEFT JOIN insumos i ON i.id = mi.insumo_id
             WHERE mi.orden_trabajo_id = $1 AND mi.tipo = 'salida'
             ORDER BY mi.created_at DESC`,
            [req.params.ordenId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar insumos de la orden' });
    }
});

const FACTURABLE_VALIDOS = ['si', 'no', 'pendiente'];

/**
 * Recalcula ordenes_trabajo.facturable a partir de las lineas de la OT.
 * Se llama SIEMPRE dentro de la transaccion que modifico una linea: en el talonario el
 * facturable es por linea, asi que el campo de la orden quedo derivado (ver
 * utils/facturableOt.js) y facturacion.js / dashboard.js lo siguen leyendo sin cambios.
 */
async function recalcularFacturableOt(client, ordenId) {
    const lineas = await client.query(
        `SELECT facturable FROM movimientos_insumo WHERE orden_trabajo_id = $1 AND tipo = 'salida'`,
        [ordenId]
    );
    const facturable = calcularFacturableOt(lineas.rows);
    await client.query('UPDATE ordenes_trabajo SET facturable = $1 WHERE id = $2', [facturable, ordenId]);
    return facturable;
}

// POST /api/insumos/orden/:ordenId - agregar una linea de repuesto a la OT.
// Replica la tabla del talonario: cantidad, insumo del catalogo o descripcion escrita a mano,
// precio, y el facturable SI/NO/? de esa linea.
router.post('/orden/:ordenId', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { insumo_id, cantidad, descripcion, precio_unitario, facturable } = req.body;
    if (!cantidad || isNaN(cantidad) || Number(cantidad) <= 0) {
        return res.status(400).json({ error: 'cantidad (numerica positiva) es requerida' });
    }
    // el stock parte de cero y en el papel el repuesto se escribe a mano: se acepta una linea
    // sin catalogo mientras venga descrita
    if (!insumo_id && !(descripcion && descripcion.trim())) {
        return res.status(400).json({ error: 'Indique un insumo del catalogo o una descripcion' });
    }
    if (facturable !== undefined && !FACTURABLE_VALIDOS.includes(facturable)) {
        return res.status(400).json({ error: `facturable debe ser uno de: ${FACTURABLE_VALIDOS.join(', ')}` });
    }
    // un mecanico solo carga repuestos a sus propias OT: sin esto podia agregar lineas a la
    // orden de otro y, de paso, cambiarle el facturable (que se deriva de las lineas)
    if (req.user.rol === 'mecanico') {
        const check = await verificarDuenoOrden(req.params.ordenId, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // El repuesto sale de donde estaba fisicamente: del furgon si lo registra el mecanico,
        // de la bodega si lo registra el administrativo. Se permite dejar el furgon en negativo
        // (ver utils/stock.js): la pieza ya se instalo y el descuadre queda visible para bodega.
        let ubicacionOrigen = null;
        if (insumo_id) {
            const insumoResult = await client.query('SELECT id FROM insumos WHERE id = $1', [insumo_id]);
            if (insumoResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Insumo no encontrado' });
            }
            ubicacionOrigen = req.user.rol === 'mecanico'
                ? await furgonDe(client, req.user.id)
                : await bodegaCentral(client);
            if (ubicacionOrigen) {
                await moverStock(client, { ubicacionId: ubicacionOrigen, insumoId: insumo_id, delta: -cantidad });
            }
            // sin furgon asignado el consumo igual se registra: la OT no puede quedar bloqueada
            // porque a un mecanico todavia no le hayan cargado su vehiculo en el sistema
        }
        const movimiento = await client.query(
            `INSERT INTO movimientos_insumo
                (insumo_id, orden_trabajo_id, cantidad, tipo, usuario_id, descripcion, precio_unitario, facturable, ubicacion_origen_id)
             VALUES ($1, $2, $3, 'salida', $4, $5, $6, COALESCE($7::estado_facturable_linea, 'pendiente'), $8)
             RETURNING *`,
            [
                insumo_id || null,
                req.params.ordenId,
                cantidad,
                req.user.id,
                descripcion && descripcion.trim() ? descripcion.trim() : null,
                precio_unitario === undefined || precio_unitario === null || precio_unitario === '' ? null : precio_unitario,
                facturable || null,
                ubicacionOrigen,
            ]
        );
        const facturableOt = await recalcularFacturableOt(client, req.params.ordenId);
        await client.query('COMMIT');
        res.status(201).json({ ...movimiento.rows[0], orden_facturable: facturableOt });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al registrar la linea de repuesto' });
    } finally {
        client.release();
    }
});

// PATCH /api/insumos/orden/:ordenId/linea/:lineaId - resolver el "?" del papel o corregir el
// precio. Es la decision que describio el jefe de taller (entrevista, punto 9): clientes antiguos a los
// que se decide despues no cobrarles, aunque el trabajo se haya hecho.
router.patch('/orden/:ordenId/linea/:lineaId', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { facturable, precio_unitario, descripcion } = req.body;
    if (facturable !== undefined && !FACTURABLE_VALIDOS.includes(facturable)) {
        return res.status(400).json({ error: `facturable debe ser uno de: ${FACTURABLE_VALIDOS.join(', ')}` });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE movimientos_insumo
             SET facturable = COALESCE($1::estado_facturable_linea, facturable),
                 precio_unitario = COALESCE($2, precio_unitario),
                 descripcion = COALESCE($3, descripcion)
             WHERE id = $4 AND orden_trabajo_id = $5
             RETURNING *`,
            [
                facturable || null,
                precio_unitario === undefined || precio_unitario === null || precio_unitario === '' ? null : precio_unitario,
                descripcion === undefined ? null : descripcion,
                req.params.lineaId,
                req.params.ordenId,
            ]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Linea no encontrada en esta orden de trabajo' });
        }
        const facturableOt = await recalcularFacturableOt(client, req.params.ordenId);
        await client.query('COMMIT');
        res.json({ ...result.rows[0], orden_facturable: facturableOt });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la linea' });
    } finally {
        client.release();
    }
});

module.exports = router;
