// Transferencias, ajustes, ingresos, descuadres y movimientos de stock.
const express = require('express');
require('../../utils/asyncErrores');
const pool = require('../../config/db');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { avisarAjusteInventario } = require('../../utils/avisos');
const { validarIdsEnRuta } = require('../../utils/validacion');
const { esIdPositivo, cantidadValidaONulo } = require('../../utils/auditoriaLinea');
const { validarTransferencia, validarMotivoAjuste, calcularAjuste, reconstruirDescuadre, MOTIVOS_CONTEO } = require('../../utils/stock');
const { diaSantiago, diasEntre } = require('../../utils/diasArriendo');
const { parsearPaginacion, envolver } = require('../../utils/paginacion');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../../utils/idempotencia');
const { conTransaccion } = require('../../utils/transaccion');
const { num } = require('../../utils/valores');
const { idDeCuerpoValido, bodegaCentral, furgonDe, moverStock } = require('./comun');

const router = express.Router();
validarIdsEnRuta(router, ['id', 'ordenId', 'lineaId']);

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
    // la transferencia ya hecha con ese uuid, como respuesta de un reintento
    const respuestaPrevia = async (db) => {
        const previo = await buscarPorUuid(db, 'movimientos_insumo', uuid);
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
        const previa = uuid ? await respuestaPrevia(pool) : null;
        if (previa) return res.status(previa.status).json(previa.body);
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const bodega = await bodegaCentral(client);
            // un mecanico siempre carga a SU furgon: aceptar un destino del cuerpo le permitiria
            // cargarle stock al furgon de otro. Solo el administrativo puede indicar destino.
            if (req.user.rol === 'administrativo' && req.body.ubicacion_destino_id !== undefined && req.body.ubicacion_destino_id !== null
                && !idDeCuerpoValido(req.body.ubicacion_destino_id)) {
                await deshacer();
                return res.status(400).json({ error: 'ubicacion_destino_id debe ser un número válido' });
            }
            const destino = req.user.rol === 'administrativo' && req.body.ubicacion_destino_id
                ? req.body.ubicacion_destino_id
                : await furgonDe(client, req.user.id);
            if (!destino) {
                await deshacer();
                return res.status(400).json({ error: 'No tienes un furgón asignado' });
            }

            // el destino debe ser un furgon activo: una clave foranea invalida daria 500
            if (req.user.rol === 'administrativo' && req.body.ubicacion_destino_id) {
                const ubi = await client.query(
                    'SELECT tipo, activa FROM ubicaciones_stock WHERE id = $1', [destino]);
                if (ubi.rows.length === 0 || ubi.rows[0].activa !== true || ubi.rows[0].tipo !== 'furgon') {
                    await deshacer();
                    return res.status(400).json({ error: 'El destino debe ser un furgón activo' });
                }
            }
            // motivo opcional: el panel lo manda al traspasar para cuadrar un descuadre
            const motivo = req.body.motivo_codigo === undefined || req.body.motivo_codigo === null || req.body.motivo_codigo === ''
                ? null : req.body.motivo_codigo;
            if (motivo !== null && !validarMotivoAjuste(motivo).valido) {
                await deshacer();
                return res.status(400).json({ error: 'Elige un motivo de la lista' });
            }

            // el insumo se bloquea antes que su stock (mismo orden que moverStock)
            await client.query('SELECT 1 FROM insumos WHERE id = $1 FOR NO KEY UPDATE', [insumo_id]);
            // reintento simultaneo con el mismo uuid: el segundo esperaba este candado mientras el primero
            // guardaba; con el candado tomado vuelve a mirar si el uuid existe, antes de validar contra
            // una bodega que ya cambio (daria 400 por "no hay stock" a una carga que si se hizo)
            if (uuid) {
                const repetida = await respuestaPrevia(client);
                if (repetida) {
                    await deshacer();
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
                await deshacer();
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

            await confirmar();
            res.status(201).json({ ok: true, ubicacion_destino_id: destino, cantidad: Number(cantidad) });
        });
    } catch (err) {
        // dos reintentos simultaneos: el segundo choca con el UNIQUE, y eso significa "ya estaba hecho"
        if (esUuidDuplicado(err)) {
            const previa = await respuestaPrevia(pool);
            if (previa) return res.status(previa.status).json(previa.body);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al cargar el furgón' });
    }
});

// existencias negativas por ubicacion, para que bodega las cuadre.
// Aparecen cuando un mecanico registro el consumo de un repuesto que el sistema no tenia en su
// furgon; el dato del trabajo se conserva y la diferencia queda a la vista. Cada fila dice desde
// cuando esta negativo, reconstruido con los movimientos (utils/stock.js reconstruirDescuadre).
router.get('/descuadres', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    // una sola instantanea: los negativos y sus movimientos se leen en la misma transaccion de solo
    // lectura, asi un movimiento que se confirma entre las dos consultas no deja un caso a medias
    try {
        return await conTransaccion(pool, async (client, { confirmar }) => {
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
            await confirmar();
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
        }, { inicio: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar los descuadres de stock' });
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

    const respuestaPrevia = async (db) => {
        const previo = await buscarPorUuid(db, 'movimientos_insumo', uuid);
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
        // el reintento se resuelve ANTES de comparar la cantidad esperada: la repeticion de un
        // conteo ya hecho vera un stock distinto y recibiria un 409 que no corresponde
        const previa = await respuestaPrevia(pool);
        if (previa) return res.status(previa.status).json(previa.body);
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const ubi = await client.query('SELECT id, activa FROM ubicaciones_stock WHERE id = $1', [ubicacion_id]);
            if (ubi.rows.length === 0 || ubi.rows[0].activa !== true) {
                await deshacer();
                return res.status(400).json({ error: 'La ubicación no existe o está inactiva' });
            }
            const insumo = await client.query('SELECT id FROM insumos WHERE id = $1 FOR NO KEY UPDATE', [insumo_id]);
            if (insumo.rows.length === 0) {
                await deshacer();
                return res.status(404).json({ error: 'Insumo no encontrado' });
            }
            await client.query(
                `INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, 0)
                 ON CONFLICT (ubicacion_id, insumo_id) DO NOTHING`, [ubicacion_id, insumo_id]);
            const existencia = await client.query(
                'SELECT cantidad FROM stock_ubicacion WHERE ubicacion_id = $1 AND insumo_id = $2 FOR UPDATE', [ubicacion_id, insumo_id]);
            // dos reintentos simultaneos: el segundo esperaba el candado mientras el primero guardaba; con el
            // candado ya tomado vuelve a mirar si el uuid existe, antes de comparar con un stock que ya cambio
            const repetida = await respuestaPrevia(client);
            if (repetida) {
                await deshacer();
                return res.status(repetida.status).json(repetida.body);
            }
            const calculo = calcularAjuste({
                contada: cantidad_contada, sistema: existencia.rows[0].cantidad, esperada: cantidad_esperada,
            });
            if (!calculo.ok) {
                await deshacer();
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
            await confirmar();
            if (calculo.delta === 0) return res.json({ ok: true, sin_cambios: true, delta: 0, movimiento_id: mov.rows[0].id });
            res.status(201).json({ ok: true, delta: calculo.delta, movimiento_id: mov.rows[0].id });
        });
    } catch (err) {
        if (esUuidDuplicado(err)) {
            const previa = await respuestaPrevia(pool);
            if (previa) return res.status(previa.status).json(previa.body);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar el conteo' });
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
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const existe = await client.query('SELECT id FROM insumos WHERE id = $1', [req.params.id]);
            if (existe.rows.length === 0) {
                await deshacer();
                return res.status(404).json({ error: 'Insumo no encontrado' });
            }
            // una compra entra siempre a la bodega central; de ahi se reparte a los furgones
            const bodega = await bodegaCentral(client);
            if (!bodega) {
                await deshacer();
                return res.status(500).json({ error: 'No hay una bodega central configurada' });
            }
            await moverStock(client, { ubicacionId: bodega, insumoId: req.params.id, delta: cantidad });
            await client.query(
                `INSERT INTO movimientos_insumo (insumo_id, cantidad, tipo, usuario_id, ubicacion_destino_id)
                 VALUES ($1, $2, 'ingreso', $3, $4)`,
                [req.params.id, cantidad, req.user.id, bodega]
            );
            const result = await client.query('SELECT * FROM insumos WHERE id = $1', [req.params.id]);
            await confirmar();
            res.json(result.rows[0]);
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al registrar ingreso de stock' });
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

module.exports = router;
