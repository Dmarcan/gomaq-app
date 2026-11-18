const express = require('express');
require('../utils/asyncErrores');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { calcularFacturableOt } = require('../utils/facturableOt');
const { avisarPorValorizar, avisarAjusteInventario } = require('../utils/avisos');
const { textoInvalido, validarIdsEnRuta, validarCuerpo, UUID } = require('../utils/validacion');
const { evaluarCompuertas, difLinea, debeAnularValorizacion, validarPrecioUnitario, esIdPositivo, montoEnteroONulo, cantidadValidaONulo } = require('../utils/auditoriaLinea');
const { dejarEvento } = require('../utils/eventosOt');
const { validarTransferencia, validarMotivoAjuste, calcularAjuste, reconstruirDescuadre, MOTIVOS_CONTEO } = require('../utils/stock');
const { diaSantiago, diasEntre } = require('../utils/diasArriendo');
const { verificarDuenoOrden, MENSAJE_OT_CERRADA } = require('../utils/ordenes');
const { parsearPaginacion, envolver } = require('../utils/paginacion');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../utils/idempotencia');

const router = express.Router();
validarIdsEnRuta(router, ['id', 'ordenId', 'lineaId']);

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Id escrito en el cuerpo de una peticion: numero entero positivo o texto de digitos (no arreglos, ni booleanos). */
const idDeCuerpoValido = (v) => (typeof v === 'number'
    ? Number.isInteger(v) && v > 0 && v <= 2147483647
    : typeof v === 'string' && esIdPositivo(v));

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
    // Orden de bloqueo: SIEMPRE el insumo y despues su fila de stock_ubicacion. stock_actual es la
    // suma de todas las ubicaciones del insumo: sin este candado, dos movimientos del mismo insumo
    // en ubicaciones distintas calculaban la suma con datos viejos y uno pisaba al otro (en READ
    // COMMITTED). FOR NO KEY UPDATE y no FOR UPDATE: los INSERT de movimientos_insumo toman KEY SHARE
    // sobre el insumo por la clave foranea y un FOR UPDATE chocaria con ellos (deadlock).
    await client.query('SELECT 1 FROM insumos WHERE id = $1 FOR NO KEY UPDATE', [insumoId]);
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

// catalogo completo (mecanico lo usa para el picker de consumo).
// Ademas de stock_actual (el total) trae cuanto hay en la bodega central y, para un mecanico,
// en su furgon: al cargar repuestos necesita ver "bodega: X / furgon: Y" antes de elegir.
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const bodega = await bodegaCentral(pool);
    const furgon = req.user.rol === 'mecanico' ? await furgonDe(pool, req.user.id) : null;
    const result = await pool.query(
        `SELECT i.*,
                    COALESCE(sb.cantidad, 0) AS stock_bodega,
                    COALESCE(sf.cantidad, 0) AS stock_furgon
             FROM insumos i
             LEFT JOIN stock_ubicacion sb ON sb.insumo_id = i.id AND sb.ubicacion_id = $1
             LEFT JOIN stock_ubicacion sf ON sf.insumo_id = i.id AND sf.ubicacion_id = $2
             ORDER BY i.nombre ASC`,
        [bodega, furgon]
    );
    res.json(result.rows.map((f) => ({ ...f, stock_bodega: num(f.stock_bodega), stock_furgon: num(f.stock_furgon) })));
});

router.post('/', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { nombre: 150, unidad_medida: 20 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!nombre || !unidad_medida) {
        return res.status(400).json({ error: 'nombre y unidad_medida son requeridos' });
    }
    const vacio = costo_unitario === undefined || costo_unitario === null || costo_unitario === '';
    if (!vacio && montoEnteroONulo(costo_unitario) === null) {
        return res.status(400).json({ error: 'El costo debe ser un monto entero en pesos, mayor o igual a 0' });
    }
    const result = await pool.query(
        `INSERT INTO insumos (nombre, unidad_medida, costo_unitario) VALUES ($1, $2, $3) RETURNING *`,
        [nombre, unidad_medida, vacio ? null : montoEnteroONulo(costo_unitario)]
    );
    res.status(201).json(result.rows[0]);
});

router.patch('/:id', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { nombre: 150, unidad_medida: 20 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!esIdPositivo(req.params.id)) return res.status(400).json({ error: 'Id de insumo inválido' });
    const sinCosto = costo_unitario === undefined || costo_unitario === null || costo_unitario === '';
    if (!sinCosto && montoEnteroONulo(costo_unitario) === null) {
        return res.status(400).json({ error: 'El costo debe ser un monto entero en pesos, mayor o igual a 0' });
    }
    const result = await pool.query(
        `UPDATE insumos SET
                nombre = COALESCE($1, nombre),
                unidad_medida = COALESCE($2, unidad_medida),
                costo_unitario = COALESCE($3, costo_unitario)
             WHERE id = $4 RETURNING *`,
        [nombre || null, unidad_medida || null, sinCosto ? null : montoEnteroONulo(costo_unitario), req.params.id]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Insumo no encontrado' });
    }
    res.json(result.rows[0]);
});

router.get('/mi-furgon', verifyToken, requireRole('mecanico'), async (req, res) => {
    let client;
    try {
        client = await pool.connect();
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
        res.status(500).json({ error: 'Error al consultar el stock de tu furgón' });
    } finally {
        if (client) client.release();
    }
});

// el mecanico carga repuestos de la bodega a su furgon.
//
// Solo con señal, a proposito: la carga se hace en el taller y validar contra la bodega en el
// momento evita que dos mecanicos reclamen sin saberlo la misma pieza. Por eso aca SI se
// rechaza sacar mas de lo que hay, a diferencia del consumo en terreno.
//
// Idempotente con `uuid_cliente` (opcional): si la respuesta se pierde y la app reintenta, la
// segunda llamada devuelve la transferencia ya hecha en vez de descontar la bodega otra vez.
router.post('/transferencia', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { insumo_id, cantidad } = req.body;
    if (!insumo_id) {
        return res.status(400).json({ error: 'insumo_id es requerido' });
    }
    const { valido: uuidValido, uuid } = leerUuidCliente(req.body);
    if (!uuidValido) {
        return res.status(400).json({ error: 'uuid_cliente no es un UUID valido' });
    }
    let client;
    // la transferencia ya hecha con ese uuid, como respuesta de un reintento
    const respuestaPrevia = async () => {
        const previo = await buscarPorUuid(client, 'movimientos_insumo', uuid);
        if (!previo) return null;
        if (previo.usuario_id !== req.user.id) {
            return { status: 409, body: { error: 'uuid_cliente ya fue usado por otra operacion' } };
        }
        return {
            status: 200,
            body: { ok: true, ya_registrada: true, ubicacion_destino_id: previo.ubicacion_destino_id, cantidad: Number(previo.cantidad) },
        };
    };
    try {
        client = await pool.connect();
        const previa = uuid ? await respuestaPrevia() : null;
        if (previa) return res.status(previa.status).json(previa.body);

        await client.query('BEGIN');
        const bodega = await bodegaCentral(client);
        // un mecanico siempre carga a SU furgon: aceptar un destino del cuerpo le permitiria
        // cargarle stock al furgon de otro. Solo el administrativo puede indicar destino.
        if (req.user.rol === 'administrativo' && req.body.ubicacion_destino_id !== undefined && req.body.ubicacion_destino_id !== null
            && !idDeCuerpoValido(req.body.ubicacion_destino_id)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ubicacion_destino_id debe ser un número válido' });
        }
        const destino = req.user.rol === 'administrativo' && req.body.ubicacion_destino_id
            ? req.body.ubicacion_destino_id
            : await furgonDe(client, req.user.id);
        if (!destino) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No tienes un furgón asignado' });
        }

        // el destino debe ser un furgon activo: una clave foranea invalida daria 500
        if (req.user.rol === 'administrativo' && req.body.ubicacion_destino_id) {
            const ubi = await client.query(
                'SELECT tipo, activa FROM ubicaciones_stock WHERE id = $1', [destino]);
            if (ubi.rows.length === 0 || ubi.rows[0].activa !== true || ubi.rows[0].tipo !== 'furgon') {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'El destino debe ser un furgón activo' });
            }
        }
        // motivo opcional: el panel lo manda al traspasar para cuadrar un descuadre
        const motivo = req.body.motivo_codigo === undefined || req.body.motivo_codigo === null || req.body.motivo_codigo === ''
            ? null : req.body.motivo_codigo;
        if (motivo !== null && !validarMotivoAjuste(motivo).valido) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Elige un motivo de la lista' });
        }

        // el insumo se bloquea antes que su stock (mismo orden que moverStock)
        await client.query('SELECT 1 FROM insumos WHERE id = $1 FOR NO KEY UPDATE', [insumo_id]);
        // reintento simultaneo con el mismo uuid: el segundo esperaba este candado mientras el primero
        // guardaba; con el candado tomado vuelve a mirar si el uuid existe, antes de validar contra
        // una bodega que ya cambio (daria 400 por "no hay stock" a una carga que si se hizo)
        if (uuid) {
            const repetida = await respuestaPrevia();
            if (repetida) {
                await client.query('ROLLBACK');
                return res.status(repetida.status).json(repetida.body);
            }
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
                (insumo_id, cantidad, tipo, usuario_id, ubicacion_origen_id, ubicacion_destino_id, descripcion, uuid_cliente, motivo_codigo, created_at)
             VALUES ($1, $2, 'salida', $3, $4, $5, 'Carga de furgon desde bodega', $6, $7, clock_timestamp())`,
            [insumo_id, cantidad, req.user.id, bodega, destino, uuid, motivo]
        );

        await client.query('COMMIT');
        res.status(201).json({ ok: true, ubicacion_destino_id: destino, cantidad: Number(cantidad) });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        // dos reintentos simultaneos: el segundo choca con el UNIQUE, y eso significa "ya estaba hecho"
        if (esUuidDuplicado(err)) {
            const previa = await respuestaPrevia();
            if (previa) return res.status(previa.status).json(previa.body);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al cargar el furgón' });
    } finally {
        if (client) client.release();
    }
});

// existencias negativas por ubicacion, para que bodega las cuadre.
// Aparecen cuando un mecanico registro el consumo de un repuesto que el sistema no tenia en su
// furgon; el dato del trabajo se conserva y la diferencia queda a la vista. Cada fila dice desde
// cuando esta negativo, reconstruido con los movimientos (utils/stock.js reconstruirDescuadre).
router.get('/descuadres', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    // una sola instantanea: los negativos y sus movimientos se leen en la misma transaccion de solo
    // lectura, asi un movimiento que se confirma entre las dos consultas no deja un caso a medias
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const negativos = await client.query(
            `SELECT su.ubicacion_id, su.insumo_id, su.cantidad, i.nombre AS insumo_nombre, i.unidad_medida,
                    u.nombre AS ubicacion_nombre, u.tipo AS ubicacion_tipo, v.patente, usr.nombre AS mecanico_nombre,
                    to_char(now() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') AS hoy
             FROM stock_ubicacion su
             JOIN insumos i ON i.id = su.insumo_id
             JOIN ubicaciones_stock u ON u.id = su.ubicacion_id
             LEFT JOIN vehiculos v ON v.id = u.vehiculo_id
             LEFT JOIN usuarios usr ON usr.id = v.usuario_id
             WHERE su.cantidad < 0
             ORDER BY su.cantidad ASC, su.ubicacion_id, su.insumo_id`
        );
        // eventos de los pares negativos: el origen resta al crearse, el destino suma, y una linea
        // anulada devuelve lo que habia restado (mismo criterio que la anulacion de lineas)
        const eventos = negativos.rows.length === 0 ? { rows: [] } : await client.query(
            `WITH neg AS (SELECT ubicacion_id, insumo_id FROM stock_ubicacion WHERE cantidad < 0)
             SELECT n.ubicacion_id, n.insumo_id, mi.created_at AS at, -mi.cantidad AS delta, mi.id
             FROM neg n JOIN movimientos_insumo mi ON mi.insumo_id = n.insumo_id AND mi.ubicacion_origen_id = n.ubicacion_id
             UNION ALL
             SELECT n.ubicacion_id, n.insumo_id, mi.created_at, mi.cantidad, mi.id
             FROM neg n JOIN movimientos_insumo mi ON mi.insumo_id = n.insumo_id AND mi.ubicacion_destino_id = n.ubicacion_id
             UNION ALL
             SELECT n.ubicacion_id, n.insumo_id, mi.anulada_at, mi.cantidad, mi.id
             FROM neg n JOIN movimientos_insumo mi ON mi.insumo_id = n.insumo_id AND mi.ubicacion_origen_id = n.ubicacion_id
             WHERE mi.anulada_at IS NOT NULL
             ORDER BY at, id`
        );
        await client.query('COMMIT');
        const porPar = new Map();
        for (const e of eventos.rows) {
            const clave = `${e.ubicacion_id}:${e.insumo_id}`;
            if (!porPar.has(clave)) porPar.set(clave, []);
            porPar.get(clave).push({ at: e.at, delta: Number(e.delta) });
        }
        res.json(negativos.rows.map(({ hoy, ...f }) => {
            const r = reconstruirDescuadre(f.cantidad, porPar.get(`${f.ubicacion_id}:${f.insumo_id}`) || []);
            return {
                ...f,
                cantidad: num(f.cantidad),
                negativo_desde: r.negativo_desde,
                ultimo_movimiento_at: r.ultimo_movimiento_at,
                sin_origen: r.sin_origen,
                dias: r.negativo_desde ? Math.max(0, diasEntre(diaSantiago(r.negativo_desde), hoy) - 1) : null,
            };
        }));
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al consultar los descuadres de stock' });
    } finally {
        if (client) client.release();
    }
});

// motivos validos para un CONTEO, para el selector del panel.
// 'traspaso_no_registrado' no esta: ese caso se cuadra con un traspaso desde la bodega.
router.get('/motivos-ajuste', verifyToken, requireRole('administrativo', 'gerente'), (req, res) => {
    res.json(Object.entries(MOTIVOS_CONTEO).map(([codigo, nombre]) => ({ codigo, nombre })));
});

// conteo fisico de un insumo en una ubicacion (solo administrativo).
//
// Cuadra la existencia del sistema con lo contado: guarda la diferencia como un movimiento de
// tipo 'ajuste' con su motivo. Idempotente con `uuid_cliente` (obligatorio): si se pierde la
// respuesta y se reintenta, devuelve el ajuste ya hecho y no lo duplica. `cantidad_esperada` es lo
// que vio el administrativo al empezar a contar: si el stock cambio mientras tanto, responde 409.
//
// Un consumo hecho sin senal que se sincroniza DESPUES de este conteo descuenta de nuevo el
// repuesto y el 409 no lo detecta: el furgon solo se cuenta con la cola del mecanico en 0.
router.post('/ajuste', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { ubicacion_id, insumo_id, cantidad_contada, cantidad_esperada, motivo_codigo, nota } = req.body || {};
    const { valido: uuidValido, uuid } = leerUuidCliente(req.body || {});
    if (!uuidValido || !uuid) {
        return res.status(400).json({ error: 'uuid_cliente es requerido y debe ser un UUID válido' });
    }
    if (!idDeCuerpoValido(ubicacion_id) || !idDeCuerpoValido(insumo_id)) {
        return res.status(400).json({ error: 'ubicacion_id e insumo_id son requeridos' });
    }
    const motivo = validarMotivoAjuste(motivo_codigo, MOTIVOS_CONTEO);
    if (!motivo.valido) {
        return res.status(400).json({
            error: motivo_codigo === 'traspaso_no_registrado'
                ? 'Una pieza que salió de bodega se cuadra con un traspaso, no con un conteo'
                : motivo.error,
        });
    }
    if (nota !== undefined && nota !== null && (typeof nota !== 'string' || nota.length > 500)) {
        return res.status(400).json({ error: 'La nota no puede pasar de 500 caracteres' });
    }

    let client;
    const respuestaPrevia = async () => {
        const previo = await buscarPorUuid(client, 'movimientos_insumo', uuid);
        if (!previo) return null;
        // solo es "el mismo conteo" si coincide el usuario, el tipo, el insumo y la ubicacion
        const ubicacionPrevia = previo.ubicacion_destino_id || previo.ubicacion_origen_id;
        if (previo.usuario_id !== req.user.id || previo.tipo !== 'ajuste'
            || String(previo.insumo_id) !== String(insumo_id) || String(ubicacionPrevia) !== String(ubicacion_id)) {
            return { status: 409, body: { error: 'uuid_cliente ya fue usado por otra operacion' } };
        }
        return { status: 200, body: { ok: true, ya_registrada: true, movimiento_id: previo.id } };
    };
    try {
        client = await pool.connect();
        // el reintento se resuelve ANTES de comparar la cantidad esperada: la repeticion de un
        // conteo ya hecho vera un stock distinto y recibiria un 409 que no corresponde
        const previa = await respuestaPrevia();
        if (previa) return res.status(previa.status).json(previa.body);

        await client.query('BEGIN');
        const ubi = await client.query('SELECT id, activa FROM ubicaciones_stock WHERE id = $1', [ubicacion_id]);
        if (ubi.rows.length === 0 || ubi.rows[0].activa !== true) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'La ubicación no existe o está inactiva' });
        }
        const insumo = await client.query('SELECT id FROM insumos WHERE id = $1 FOR NO KEY UPDATE', [insumo_id]);
        if (insumo.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        await client.query(
            `INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, 0)
             ON CONFLICT (ubicacion_id, insumo_id) DO NOTHING`, [ubicacion_id, insumo_id]);
        const existencia = await client.query(
            'SELECT cantidad FROM stock_ubicacion WHERE ubicacion_id = $1 AND insumo_id = $2 FOR UPDATE', [ubicacion_id, insumo_id]);
        // dos reintentos simultaneos: el segundo esperaba el candado mientras el primero guardaba; con el
        // candado ya tomado vuelve a mirar si el uuid existe, antes de comparar con un stock que ya cambio
        const repetida = await respuestaPrevia();
        if (repetida) {
            await client.query('ROLLBACK');
            return res.status(repetida.status).json(repetida.body);
        }
        const calculo = calcularAjuste({
            contada: cantidad_contada, sistema: existencia.rows[0].cantidad, esperada: cantidad_esperada,
        });
        if (!calculo.ok) {
            await client.query('ROLLBACK');
            return res.status(calculo.status).json({ error: calculo.error });
        }
        // contar lo mismo que dice el sistema tambien se registra: queda un movimiento de cantidad 0 (con su
        // motivo y su uuid) que deja constancia del conteo y hace idempotente el reintento. No mueve stock.
        if (calculo.delta !== 0) {
            await moverStock(client, { ubicacionId: ubicacion_id, insumoId: insumo_id, delta: calculo.delta });
        }
        const mov = await client.query(
            `INSERT INTO movimientos_insumo
                (insumo_id, cantidad, tipo, usuario_id, ubicacion_origen_id, ubicacion_destino_id, descripcion, uuid_cliente, motivo_codigo, created_at)
             VALUES ($1, $2, 'ajuste', $3, $4, $5, $6, $7, $8, clock_timestamp()) RETURNING id`,
            [insumo_id, Math.abs(calculo.delta), req.user.id,
                calculo.delta < 0 ? ubicacion_id : null,
                // con delta 0 la ubicacion va como destino: asi el reintento puede comprobar que es el mismo conteo
                calculo.delta >= 0 ? ubicacion_id : null,
                nota || null, uuid, motivo_codigo]
        );
        // perdida o merma (diferencia negativa): el gerente lo revisa. Un conteo normal, uno que suma stock o uno sin
        // diferencia no avisa. El reintento salio antes (respuestaPrevia) y no llega aca
        await avisarAjusteInventario(client, {
            insumoId: insumo_id, ubicacionId: ubicacion_id, delta: calculo.delta,
            motivoCodigo: motivo_codigo, usuarioId: req.user.id,
        });
        await client.query('COMMIT');
        if (calculo.delta === 0) return res.json({ ok: true, sin_cambios: true, delta: 0, movimiento_id: mov.rows[0].id });
        res.status(201).json({ ok: true, delta: calculo.delta, movimiento_id: mov.rows[0].id });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (esUuidDuplicado(err)) {
            const previa = await respuestaPrevia();
            if (previa) return res.status(previa.status).json(previa.body);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar el conteo' });
    } finally {
        if (client) client.release();
    }
});

router.get('/por-ubicacion', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
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
});

router.post('/:id/ingreso', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { cantidad } = req.body;
    if (!esIdPositivo(req.params.id)) return res.status(400).json({ error: 'Id de insumo inválido' });
    if (cantidadValidaONulo(cantidad) === null) {
        return res.status(400).json({ error: 'Indica una cantidad mayor a 0, con hasta 2 decimales' });
    }
    let client;
    try {
        client = await pool.connect();
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
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al registrar ingreso de stock' });
    } finally {
        if (client) client.release();
    }
});

// movimientos recientes, con datos de OT/insumo/usuario para auditoria.
// Filtros opcionales: ?insumo_id= y ?ubicacion_id= (origen o destino), para "ver movimientos" de un
// descuadre. Los ajustes de inventario traen su motivo (motivo_codigo).
router.get('/movimientos', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const { limit, offset } = parsearPaginacion(req.query);
    const filtros = [];
    const valores = [];
    for (const campo of ['insumo_id', 'ubicacion_id']) {
        const valor = req.query[campo];
        if (valor === undefined || valor === '') continue;
        if (!esIdPositivo(valor)) return res.status(400).json({ error: `${campo} debe ser un número válido` });
        valores.push(Number(valor));
        filtros.push(campo === 'insumo_id'
            ? `mi.insumo_id = $${valores.length}`
            : `(mi.ubicacion_origen_id = $${valores.length} OR mi.ubicacion_destino_id = $${valores.length})`);
    }
    const donde = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const base = `FROM movimientos_insumo mi
                      LEFT JOIN insumos i ON i.id = mi.insumo_id
                      LEFT JOIN usuarios u ON u.id = mi.usuario_id
                      LEFT JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
                      LEFT JOIN maquinarias m ON m.id = ot.maquinaria_id
                      ${donde}`;
    const total = await pool.query(`SELECT COUNT(*)::int AS n ${base}`, valores);

    let sql = `SELECT mi.*, i.nombre AS insumo_nombre, i.unidad_medida, u.nombre AS usuario_nombre,
                          m.codigo AS maquinaria_codigo
                   ${base} ORDER BY mi.created_at DESC, mi.id DESC`;
    const params = [...valores];
    if (limit !== null) {
        params.push(limit, offset);
        sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }
    const result = await pool.query(sql, params);
    res.json(envolver(result.rows, total.rows[0].n, { limit, offset }));
});

router.get('/orden/:ordenId', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    // un mecanico solo ve las lineas de sus propias OT, igual que en el resto de su flujo
    if (req.user.rol === 'mecanico') {
        const check = await verificarDuenoOrden(req.params.ordenId, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
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
});

const FACTURABLE_VALIDOS = ['si', 'no', 'pendiente'];

/**
 * Recalcula ordenes_trabajo.facturable a partir de las lineas de la OT.
 * Se llama SIEMPRE dentro de la transaccion que modifico una linea: en el talonario el
 * facturable es por linea, asi que el campo de la orden quedo derivado (ver
 * utils/facturableOt.js) y facturacion.js / dashboard.js lo siguen leyendo sin cambios.
 */
async function recalcularFacturableOt(client, ordenId) {
    // una linea anulada esta tachada en el papel: no cuenta para decidir si se cobra
    const lineas = await client.query(
        `SELECT facturable FROM movimientos_insumo
         WHERE orden_trabajo_id = $1 AND tipo = 'salida' AND anulada_at IS NULL`,
        [ordenId]
    );
    const facturable = calcularFacturableOt(lineas.rows);
    await client.query('UPDATE ordenes_trabajo SET facturable = $1 WHERE id = $2', [facturable, ordenId]);
    return facturable;
}

// Agregar, anular y modificar una linea cambian lo que se cobra, asi que las tres rutas siguen el
// mismo camino, todo dentro de UNA transaccion:
//   1. bloquear la fila de la OT (FOR NO KEY UPDATE). Es obligatorio: el historial se ordena por el id de
//      los eventos y eso solo es el orden real si todo evento se escribe con la OT bloqueada; ademas
//      impide que la factura se suba en medio de un cambio de linea
//   2. leer estado, valorizacion y factura de la OT
//   3. compuertas (utils/auditoriaLinea.js): 409 si ya hay factura, 400 si la OT esta cerrada y el
//      motivo falta o no sirve
//   4. aplicar el cambio y recalcular el facturable de la OT
//   5. si la OT estaba valorizada y el cambio altera lo facturable, anular la valorizacion
//   6. dejar los eventos en el historial (utils/eventosOt.js)

/** terreno si lo hace el mecanico; panel si lo hace administrativo o gerente. */
const origenDelCambio = (req) => (req.user.rol === 'mecanico' ? 'terreno' : 'panel');

/**
 * Bloquea la fila de la OT y lee lo que deciden las compuertas: estado, valorizacion y el folio
 * de su factura (null si no tiene). Null si la OT no existe.
 *
 * La factura se lee en una SEGUNDA consulta, ya con el bloqueo tomado. En READ COMMITTED cada
 * sentencia ve lo confirmado hasta que empieza: si el folio fuera una subconsulta del mismo
 * SELECT ... FOR UPDATE, quien espero el bloqueo mientras otra transaccion subia la factura no la
 * veria (la fila de la OT no cambia, asi que Postgres no la vuelve a evaluar) y el cambio de
 * linea pasaria sobre una OT ya facturada.
 */
async function bloquearOrden(client, ordenId) {
    const r = await client.query(
        `SELECT id, mecanico_id, estado, facturable, valorizacion
         FROM ordenes_trabajo
         WHERE id = $1
         FOR NO KEY UPDATE`,
        [ordenId]
    );
    if (!r.rows[0]) return null;
    const factura = await client.query(
        'SELECT folio FROM facturas WHERE orden_trabajo_id = $1 ORDER BY id LIMIT 1',
        [r.rows[0].id]
    );
    return { ...r.rows[0], factura_folio: factura.rows[0] ? factura.rows[0].folio : null };
}

/** Las lineas que cuentan hoy en la OT (sin las anuladas), para decidir sobre la valorizacion. */
async function lineasVigentes(client, ordenId) {
    const r = await client.query(
        `SELECT id, facturable, cantidad, precio_unitario FROM movimientos_insumo
         WHERE orden_trabajo_id = $1 AND tipo = 'salida' AND anulada_at IS NULL`,
        [ordenId]
    );
    return r.rows;
}

/** Como se llama la linea en el historial: el insumo del catalogo o lo que se escribio a mano. */
async function nombreDeLinea(client, linea) {
    if (linea.insumo_id) {
        const r = await client.query('SELECT nombre FROM insumos WHERE id = $1', [linea.insumo_id]);
        if (r.rows[0]) return r.rows[0].nombre;
    }
    return linea.descripcion || null;
}

/** Detalle del evento de una linea: lo que cambio, el motivo y si la OT ya estaba cerrada. */
function detalleDeLinea({ lineaId, insumo, campo, antes, despues, compuertas }) {
    return {
        linea_id: lineaId,
        insumo,
        campo,
        antes,
        despues,
        motivo_codigo: compuertas.motivoCodigo,
        motivo: compuertas.motivo,
        orden_cerrada: compuertas.ordenCerrada,
    };
}

// Una OT finalizada que no era facturable y no esta valorizada pasa a facturable por un cambio de lineas:
// queda esperando al gerente y se le avisa (no hay valorizacion que anular: nunca existio).
// `orden` trae el facturable ANTERIOR (bloquearOrden); `facturableOt` es el recalculado.
async function avisarSiPasoAPorValorizar(client, req, orden, facturableOt) {
    if (orden.estado === 'finalizada' && (orden.valorizacion === null || orden.valorizacion === undefined)
        && orden.facturable !== true && facturableOt === true) {
        await avisarPorValorizar(client, orden.id, 'Cambio en las líneas facturables', { excluirUsuarioId: req.user.id });
    }
}

/**
 * Si el cambio altero lo facturable y la OT estaba valorizada, la valorizacion se anula (queda en
 * NULL): la OT vuelve a la lista de pendientes del gerente. Deja el evento 'valorizacion'.
 * `antes` son las lineas vigentes ANTES del cambio; las de despues se leen aca.
 */
async function anularValorizacionSiCorresponde(client, req, orden, antes, { tipoCambio, lineaId, compuertas, facturableOt }) {
    if (orden.valorizacion === null || orden.valorizacion === undefined) return false;
    const despues = await lineasVigentes(client, orden.id);
    if (!debeAnularValorizacion({ valorizacion: orden.valorizacion, antes, despues })) return false;
    await client.query(
        'UPDATE ordenes_trabajo SET valorizacion = NULL, valorizacion_aprobada_por = NULL WHERE id = $1',
        [orden.id]
    );
    await dejarEvento(client, {
        ordenId: orden.id, tipo: 'valorizacion', origen: origenDelCambio(req), usuario: req.user,
        detalle: {
            valorizacion_anterior: Number(orden.valorizacion),
            valorizacion_nueva: null,
            anulada: true,
            causa: 'Cambio en las líneas facturables',
            evento_causa: tipoCambio,
            linea_id: lineaId,
            motivo_codigo: compuertas.motivoCodigo,
            motivo: compuertas.motivo,
        },
    });
    // la OT vuelve a los pendientes del gerente SOLO si sigue siendo facturable (si el cambio la dejo sin nada que
    // cobrar, no hay nada que valorizar): se le avisa una sola vez, cuando de verdad se anulo
    if (facturableOt === true) {
        await avisarPorValorizar(client, orden.id, 'Cambio en las líneas facturables', { excluirUsuarioId: req.user.id });
    }
    return true;
}

// agregar una linea de repuesto a la OT.
// Replica la tabla del talonario: cantidad, insumo del catalogo o descripcion escrita a mano,
// precio, y el facturable SI/NO/? de esa linea.
//
// Con la OT cerrada solo la agrega el panel y exige motivo (motivo_codigo y motivo); con la OT
// facturada nadie. El mecanico no manda motivo: solo agrega a OT abiertas.
router.post('/orden/:ordenId', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { insumo_id, cantidad, descripcion, precio_unitario, facturable } = req.body;
    if (!esIdPositivo(req.params.ordenId)) return res.status(400).json({ error: 'Id de orden inválido' });
    if (cantidadValidaONulo(cantidad) === null) {
        return res.status(400).json({ error: 'Indica una cantidad mayor a 0, con hasta 2 decimales' });
    }
    if (textoInvalido(descripcion, 2000)) {
        return res.status(400).json({ error: 'descripcion debe ser un texto de hasta 2000 caracteres' });
    }
    // el stock parte de cero y en el papel el repuesto se escribe a mano: se acepta una linea
    // sin catalogo mientras venga descrita
    if (!insumo_id && !(descripcion && descripcion.trim())) {
        return res.status(400).json({ error: 'Elige un repuesto del catálogo o escribe su descripción' });
    }
    if (facturable !== undefined && !FACTURABLE_VALIDOS.includes(facturable)) {
        return res.status(400).json({ error: `facturable debe ser uno de: ${FACTURABLE_VALIDOS.join(', ')}` });
    }
    const errorPrecio = validarPrecioUnitario(precio_unitario);
    if (errorPrecio) return res.status(400).json({ error: errorPrecio });
    const { valido: uuidValido, uuid } = leerUuidCliente(req.body);
    if (!uuidValido) {
        return res.status(400).json({ error: 'uuid_cliente no es un UUID valido' });
    }
    // un mecanico solo carga repuestos a sus propias OT: sin esto podria agregar lineas a la
    // orden de otro y, de paso, cambiarle el facturable (que se deriva de las lineas)
    if (req.user.rol === 'mecanico') {
        const check = await verificarDuenoOrden(req.params.ordenId, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });
    }

    /** Reintento de una linea ya registrada: se responde lo mismo sin tocar el stock otra vez. */
    const cuerpoExistente = async (db, existente) => {
        const orden = await db.query('SELECT facturable FROM ordenes_trabajo WHERE id = $1', [existente.orden_trabajo_id]);
        return { ...existente, orden_facturable: orden.rows[0] ? orden.rows[0].facturable : null };
    };
    const responderExistente = async (existente, db = pool) => res.status(200).json(await cuerpoExistente(db, existente));
    const yaRegistrada = await buscarPorUuid(pool, 'movimientos_insumo', uuid);
    if (yaRegistrada) return responderExistente(yaRegistrada);

    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const orden = await bloquearOrden(client, req.params.ordenId);
        if (!orden) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        // lo que se reviso arriba sin bloqueo se confirma con la OT bloqueada: entre una cosa y la
        // otra se pudo cerrar o reasignar
        if (req.user.rol === 'mecanico') {
            if (orden.mecanico_id !== req.user.id) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
            }
            if (orden.estado === 'finalizada') {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: MENSAJE_OT_CERRADA });
            }
        }
        // dos reintentos de la misma tarea: el segundo espera el bloqueo y encuentra la linea
        const yaGuardada = await buscarPorUuid(client, 'movimientos_insumo', uuid);
        if (yaGuardada) {
            // con el cliente de la transaccion: el bloqueo de la OT sigue tomado mientras se lee
            const cuerpo = await cuerpoExistente(client, yaGuardada);
            await client.query('ROLLBACK');
            return res.status(200).json(cuerpo);
        }
        const compuertas = evaluarCompuertas({
            estado: orden.estado, facturaFolio: orden.factura_folio,
            motivoCodigo: req.body.motivo_codigo, motivo: req.body.motivo,
        });
        if (!compuertas.ok) {
            await client.query('ROLLBACK');
            return res.status(compuertas.status).json({ error: compuertas.error });
        }

        // El repuesto sale de donde estaba fisicamente: del furgon si lo registra el mecanico,
        // de la bodega si lo registra el administrativo. Se permite dejar el furgon en negativo
        // (ver utils/stock.js): la pieza ya se instalo y el descuadre queda visible para bodega.
        let ubicacionOrigen = null;
        let nombreInsumo = null;
        if (insumo_id) {
            const insumoResult = await client.query('SELECT id, nombre FROM insumos WHERE id = $1', [insumo_id]);
            if (insumoResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Insumo no encontrado' });
            }
            nombreInsumo = insumoResult.rows[0].nombre;
            ubicacionOrigen = req.user.rol === 'mecanico'
                ? await furgonDe(client, req.user.id)
                : await bodegaCentral(client);
            if (ubicacionOrigen) {
                await moverStock(client, { ubicacionId: ubicacionOrigen, insumoId: insumo_id, delta: -cantidad });
            }
            // sin furgon asignado el consumo igual se registra: la OT no puede quedar bloqueada
            // porque a un mecanico todavia no le hayan cargado su vehiculo en el sistema
        }
        const antes = orden.valorizacion === null ? [] : await lineasVigentes(client, orden.id);
        const movimiento = await client.query(
            `INSERT INTO movimientos_insumo
                (insumo_id, orden_trabajo_id, cantidad, tipo, usuario_id, descripcion, precio_unitario, facturable,
                 ubicacion_origen_id, uuid_cliente)
             VALUES ($1, $2, $3, 'salida', $4, $5, $6, COALESCE($7::estado_facturable_linea, 'pendiente'), $8, $9)
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
                uuid,
            ]
        );
        const linea = movimiento.rows[0];
        const facturableOt = await recalcularFacturableOt(client, req.params.ordenId);
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'linea_agregada', origen: origenDelCambio(req), usuario: req.user,
            uuidCliente: uuid,
            detalle: detalleDeLinea({
                lineaId: linea.id,
                insumo: nombreInsumo || linea.descripcion,
                campo: 'linea',
                antes: null,
                despues: {
                    cantidad: Number(linea.cantidad),
                    precio_unitario: linea.precio_unitario === null ? null : Number(linea.precio_unitario),
                    facturable: linea.facturable,
                },
                compuertas,
            }),
        });
        await anularValorizacionSiCorresponde(client, req, orden, antes, {
            tipoCambio: 'linea_agregada', lineaId: linea.id, compuertas, facturableOt,
        });
        await avisarSiPasoAPorValorizar(client, req, orden, facturableOt);
        await client.query('COMMIT');
        res.status(201).json({ ...linea, orden_facturable: facturableOt });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (esUuidDuplicado(err)) {
            // otro reintento de la misma tarea gano la carrera; el ROLLBACK ya devolvio el stock
            const existente = await buscarPorUuid(client, 'movimientos_insumo', uuid);
            if (existente) return responderExistente(existente, client);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar la línea de repuesto' });
    } finally {
        if (client) client.release();
    }
});

// tachar una linea mal ingresada.
//
// Como en el talonario, la linea no se borra: queda tachada, con quien la anulo y cuando. El
// repuesto vuelve a la ubicacion de donde salio (furgon o bodega) y la linea deja de contar como
// gasto del equipo y para el facturable de la OT.
//
// El mecanico anula las suyas mientras la OT sigue abierta; cerrada la OT, solo el panel y con
// motivo (motivo_codigo y motivo). Con la OT facturada nadie: 409.
// Es idempotente: anular una linea ya anulada responde 200 sin volver a mover stock, que es lo
// que necesita la cola offline ante un reintento.
router.post('/orden/:ordenId/linea/:lineaId/anular', verifyToken, requireRole('mecanico', 'administrativo', 'gerente'), async (req, res) => {
    const { ordenId, lineaId } = req.params;
    if (!esIdPositivo(ordenId)) return res.status(400).json({ error: 'Id de orden inválido' });
    if (!esIdPositivo(lineaId)) return res.status(400).json({ error: 'Id de línea inválido' });
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const orden = await bloquearOrden(client, ordenId);
        if (!orden) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        if (req.user.rol === 'mecanico') {
            if (orden.mecanico_id !== req.user.id) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
            }
            if (orden.estado === 'finalizada') {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'La orden ya está cerrada: pide al administrativo que anule la línea' });
            }
        }

        const lineaResult = await client.query(
            `SELECT * FROM movimientos_insumo
             WHERE id = $1 AND orden_trabajo_id = $2 AND tipo = 'salida' FOR UPDATE`,
            [lineaId, ordenId]
        );
        const linea = lineaResult.rows[0];
        if (!linea) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Línea no encontrada en esta orden de trabajo' });
        }
        if (linea.anulada_at) {
            await client.query('ROLLBACK');
            return res.json(linea);
        }
        const compuertas = evaluarCompuertas({
            estado: orden.estado, facturaFolio: orden.factura_folio,
            motivoCodigo: req.body ? req.body.motivo_codigo : undefined, motivo: req.body ? req.body.motivo : undefined,
        });
        if (!compuertas.ok) {
            await client.query('ROLLBACK');
            return res.status(compuertas.status).json({ error: compuertas.error });
        }

        const antes = orden.valorizacion === null ? [] : await lineasVigentes(client, orden.id);
        if (linea.insumo_id && linea.ubicacion_origen_id) {
            await moverStock(client, {
                ubicacionId: linea.ubicacion_origen_id,
                insumoId: linea.insumo_id,
                delta: Number(linea.cantidad),
            });
        }
        const anulada = await client.query(
            `UPDATE movimientos_insumo SET anulada_at = now(), anulada_por = $1 WHERE id = $2 RETURNING *`,
            [req.user.id, lineaId]
        );
        const facturableOt = await recalcularFacturableOt(client, ordenId);
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'linea_anulada', origen: origenDelCambio(req), usuario: req.user,
            detalle: detalleDeLinea({
                lineaId: linea.id,
                insumo: await nombreDeLinea(client, linea),
                campo: 'anulada',
                antes: false,
                despues: true,
                compuertas,
            }),
        });
        await anularValorizacionSiCorresponde(client, req, orden, antes, {
            tipoCambio: 'linea_anulada', lineaId: linea.id, compuertas, facturableOt,
        });
        await avisarSiPasoAPorValorizar(client, req, orden, facturableOt);
        await client.query('COMMIT');
        res.json({ ...anulada.rows[0], orden_facturable: facturableOt });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al anular la línea' });
    } finally {
        if (client) client.release();
    }
});

// resolver el "?" del papel o corregir el precio. Sirve para los clientes antiguos a los
// que se decide despues no cobrarles, aunque el trabajo se haya hecho.
//
// Con la OT cerrada exige motivo (motivo_codigo y motivo); con la OT facturada responde 409.
// Cabecera opcional Idempotency-Key (UUID): si ya hay un evento con ese uuid, el cambio ya se
// hizo y se responde 200 con el estado actual de la linea sin repetirlo. Un PATCH que no cambia
// nada no escribe nada ni deja evento.
router.patch('/orden/:ordenId/linea/:lineaId', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { facturable, precio_unitario, descripcion } = req.body;
    if (!esIdPositivo(req.params.ordenId)) return res.status(400).json({ error: 'Id de orden inválido' });
    if (!esIdPositivo(req.params.lineaId)) return res.status(400).json({ error: 'Id de línea inválido' });
    if (facturable !== undefined && !FACTURABLE_VALIDOS.includes(facturable)) {
        return res.status(400).json({ error: `facturable debe ser uno de: ${FACTURABLE_VALIDOS.join(', ')}` });
    }
    if (textoInvalido(descripcion, 500)) {
        return res.status(400).json({ error: 'descripcion debe ser un texto de hasta 500 caracteres' });
    }
    const errorPrecio = validarPrecioUnitario(precio_unitario);
    if (errorPrecio) return res.status(400).json({ error: errorPrecio });
    const cabecera = req.get('Idempotency-Key');
    if (cabecera !== undefined && !UUID.test(cabecera.trim())) {
        return res.status(400).json({ error: 'Idempotency-Key no es un UUID valido' });
    }
    const llave = cabecera === undefined ? null : cabecera.trim().toLowerCase();
    const mensajeNoEncontrada = 'Línea no encontrada en esta orden de trabajo, o ya anulada';
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const orden = await bloquearOrden(client, req.params.ordenId);
        if (!orden) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: mensajeNoEncontrada });
        }

        // el reintento de un cambio que ya se hizo (la respuesta se perdio): se responde el estado
        // actual. La llave solo vale para esta linea; usada en otra cosa es un error del cliente.
        if (llave) {
            const previo = await client.query(
                `SELECT orden_trabajo_id, detalle->>'linea_id' AS linea_id FROM ordenes_eventos
                 WHERE uuid_cliente = $1 AND tipo = 'linea_modificada'`,
                [llave]
            );
            if (previo.rows[0]) {
                if (previo.rows[0].orden_trabajo_id !== orden.id || previo.rows[0].linea_id !== String(req.params.lineaId)) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ error: 'Idempotency-Key ya fue usada en otra operación' });
                }
                const actual = await client.query(
                    'SELECT * FROM movimientos_insumo WHERE id = $1 AND orden_trabajo_id = $2',
                    [req.params.lineaId, req.params.ordenId]
                );
                await client.query('ROLLBACK');
                if (actual.rows.length === 0) return res.status(404).json({ error: mensajeNoEncontrada });
                return res.json({ ...actual.rows[0], orden_facturable: orden.facturable, ya_registrada: true });
            }
        }

        const lineaResult = await client.query(
            `SELECT * FROM movimientos_insumo
             WHERE id = $1 AND orden_trabajo_id = $2 AND anulada_at IS NULL FOR UPDATE`,
            [req.params.lineaId, req.params.ordenId]
        );
        const linea = lineaResult.rows[0];
        if (!linea) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: mensajeNoEncontrada });
        }

        const cambios = difLinea(linea, { facturable, precio_unitario, descripcion });
        const campos = Object.keys(cambios);
        if (campos.length === 0) {
            // nada cambia: ni la linea ni el historial se tocan
            await client.query('ROLLBACK');
            return res.json({ ...linea, orden_facturable: orden.facturable });
        }
        const compuertas = evaluarCompuertas({
            estado: orden.estado, facturaFolio: orden.factura_folio,
            motivoCodigo: req.body.motivo_codigo, motivo: req.body.motivo,
        });
        if (!compuertas.ok) {
            await client.query('ROLLBACK');
            return res.status(compuertas.status).json({ error: compuertas.error });
        }

        const antes = orden.valorizacion === null ? [] : await lineasVigentes(client, orden.id);
        const result = await client.query(
            `UPDATE movimientos_insumo
             SET facturable = COALESCE($1::estado_facturable_linea, facturable),
                 precio_unitario = COALESCE($2, precio_unitario),
                 descripcion = COALESCE($3, descripcion)
             WHERE id = $4 AND orden_trabajo_id = $5 AND anulada_at IS NULL
             RETURNING *`,
            [
                facturable || null,
                precio_unitario === undefined || precio_unitario === null || precio_unitario === '' ? null : precio_unitario,
                descripcion === undefined ? null : descripcion,
                req.params.lineaId,
                req.params.ordenId,
            ]
        );
        const facturableOt = await recalcularFacturableOt(client, req.params.ordenId);
        // un evento por campo que cambio; la llave de idempotencia va en el primero (el indice
        // unico es por uuid y tipo, asi que no puede repetirse en los demas)
        const insumo = await nombreDeLinea(client, linea);
        // "despues" sale de la fila ya guardada, no de lo pedido: es lo que de verdad quedo
        const guardada = result.rows[0];
        const valorGuardado = (campo) => {
            const v = guardada[campo];
            return (campo === 'precio_unitario' || campo === 'cantidad') && v !== null ? Number(v) : v;
        };
        for (const [i, campo] of campos.entries()) {
            const registrado = await dejarEvento(client, {
                ordenId: orden.id, tipo: 'linea_modificada', origen: origenDelCambio(req), usuario: req.user,
                uuidCliente: i === 0 ? llave : null,
                detalle: detalleDeLinea({
                    lineaId: linea.id, insumo, campo,
                    antes: cambios[campo].antes, despues: valorGuardado(campo), compuertas,
                }),
            });
            if (!registrado) {
                // el evento ya existia (misma llave y tipo): no se deja un cambio sin su rastro,
                // se deshace todo y se avisa
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Idempotency-Key ya fue usada en otra operación' });
            }
        }
        await anularValorizacionSiCorresponde(client, req, orden, antes, {
            tipoCambio: 'linea_modificada', lineaId: linea.id, compuertas, facturableOt,
        });
        await avisarSiPasoAPorValorizar(client, req, orden, facturableOt);
        await client.query('COMMIT');
        res.json({ ...result.rows[0], orden_facturable: facturableOt });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la línea' });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
