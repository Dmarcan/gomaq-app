// Lineas de repuesto de una orden de trabajo: agregar, anular y corregir.
const express = require('express');
require('../../utils/asyncErrores');
const pool = require('../../config/db');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { calcularFacturableOt } = require('../../utils/facturableOt');
const { avisarPorValorizar } = require('../../utils/avisos');
const { textoInvalido, validarIdsEnRuta, UUID } = require('../../utils/validacion');
const { evaluarCompuertas, difLinea, debeAnularValorizacion, validarPrecioUnitario, esIdPositivo, cantidadValidaONulo } = require('../../utils/auditoriaLinea');
const { dejarEvento } = require('../../utils/eventosOt');
const { verificarDuenoOrden, MENSAJE_OT_CERRADA } = require('../../utils/ordenes');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../../utils/idempotencia');
const { conTransaccion } = require('../../utils/transaccion');
const { bodegaCentral, furgonDe, moverStock } = require('./comun');

const router = express.Router();
validarIdsEnRuta(router, ['id', 'ordenId', 'lineaId']);

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

    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const orden = await bloquearOrden(client, req.params.ordenId);
            if (!orden) {
                await deshacer();
                return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            }
            // lo que se reviso arriba sin bloqueo se confirma con la OT bloqueada: entre una cosa y la
            // otra se pudo cerrar o reasignar
            if (req.user.rol === 'mecanico') {
                if (orden.mecanico_id !== req.user.id) {
                    await deshacer();
                    return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
                }
                if (orden.estado === 'finalizada') {
                    await deshacer();
                    return res.status(409).json({ error: MENSAJE_OT_CERRADA });
                }
            }
            // dos reintentos de la misma tarea: el segundo espera el bloqueo y encuentra la linea
            const yaGuardada = await buscarPorUuid(client, 'movimientos_insumo', uuid);
            if (yaGuardada) {
                // con el cliente de la transaccion: el bloqueo de la OT sigue tomado mientras se lee
                const cuerpo = await cuerpoExistente(client, yaGuardada);
                await deshacer();
                return res.status(200).json(cuerpo);
            }
            const compuertas = evaluarCompuertas({
                estado: orden.estado, facturaFolio: orden.factura_folio,
                motivoCodigo: req.body.motivo_codigo, motivo: req.body.motivo,
            });
            if (!compuertas.ok) {
                await deshacer();
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
                    await deshacer();
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
            await confirmar();
            res.status(201).json({ ...linea, orden_facturable: facturableOt });
        });
    } catch (err) {
        if (esUuidDuplicado(err)) {
            // otro reintento de la misma tarea gano la carrera; el ROLLBACK ya devolvio el stock
            const existente = await buscarPorUuid(pool, 'movimientos_insumo', uuid);
            if (existente) return responderExistente(existente, pool);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar la línea de repuesto' });
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
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const orden = await bloquearOrden(client, ordenId);
            if (!orden) {
                await deshacer();
                return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            }
            if (req.user.rol === 'mecanico') {
                if (orden.mecanico_id !== req.user.id) {
                    await deshacer();
                    return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
                }
                if (orden.estado === 'finalizada') {
                    await deshacer();
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
                await deshacer();
                return res.status(404).json({ error: 'Línea no encontrada en esta orden de trabajo' });
            }
            if (linea.anulada_at) {
                await deshacer();
                return res.json(linea);
            }
            const compuertas = evaluarCompuertas({
                estado: orden.estado, facturaFolio: orden.factura_folio,
                motivoCodigo: req.body ? req.body.motivo_codigo : undefined, motivo: req.body ? req.body.motivo : undefined,
            });
            if (!compuertas.ok) {
                await deshacer();
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
            await confirmar();
            res.json({ ...anulada.rows[0], orden_facturable: facturableOt });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al anular la línea' });
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
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const orden = await bloquearOrden(client, req.params.ordenId);
            if (!orden) {
                await deshacer();
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
                        await deshacer();
                        return res.status(409).json({ error: 'Idempotency-Key ya fue usada en otra operación' });
                    }
                    const actual = await client.query(
                        'SELECT * FROM movimientos_insumo WHERE id = $1 AND orden_trabajo_id = $2',
                        [req.params.lineaId, req.params.ordenId]
                    );
                    await deshacer();
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
                await deshacer();
                return res.status(404).json({ error: mensajeNoEncontrada });
            }

            const cambios = difLinea(linea, { facturable, precio_unitario, descripcion });
            const campos = Object.keys(cambios);
            if (campos.length === 0) {
                // nada cambia: ni la linea ni el historial se tocan
                await deshacer();
                return res.json({ ...linea, orden_facturable: orden.facturable });
            }
            const compuertas = evaluarCompuertas({
                estado: orden.estado, facturaFolio: orden.factura_folio,
                motivoCodigo: req.body.motivo_codigo, motivo: req.body.motivo,
            });
            if (!compuertas.ok) {
                await deshacer();
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
                    await deshacer();
                    return res.status(409).json({ error: 'Idempotency-Key ya fue usada en otra operación' });
                }
            }
            await anularValorizacionSiCorresponde(client, req, orden, antes, {
                tipoCambio: 'linea_modificada', lineaId: linea.id, compuertas, facturableOt,
            });
            await avisarSiPasoAPorValorizar(client, req, orden, facturableOt);
            await confirmar();
            res.json({ ...result.rows[0], orden_facturable: facturableOt });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la línea' });
    }
});

module.exports = router;
