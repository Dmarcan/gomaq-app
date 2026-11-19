// Correo de la factura editable y su cancelacion segura.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase } = require('./utils/http');
const {
    pool,
    pedir,
    crearOt,
    MOTIVO_VALIDO,
    cerrarOt,
    facturarDirecto,
    agregarLinea,
    subirFactura,
} = require('./utils/entornoEscritura');

describe('correo de la factura editable y cancelacion segura', () => {
    const { sigueVigente } = require('../src/workers/notificaciones');
    const rutaAnularFactura = (ot, factura) => `/api/ordenes-trabajo/${ot}/factura/${factura}/anular`;

    /** OT finalizada con factura cuyo cliente tiene correo. Devuelve { ot, factura, email }. */
    async function otFacturadaConCorreo(folio) {
        const cliente = await pool.query("SELECT id, email FROM clientes WHERE email IS NOT NULL ORDER BY id LIMIT 1");
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, folio);
        const f = (await pool.query(
            'UPDATE facturas SET cliente_id = $2 WHERE orden_trabajo_id = $1 RETURNING id', [ot, cliente.rows[0].id])).rows[0];
        return { ot, factura: f.id, email: cliente.rows[0].email };
    }

    const correosDe = async (facturaId) => (await pool.query(
        `SELECT id, estado, payload, ultimo_error FROM notificaciones_pendientes
         WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1 ORDER BY id`, [String(facturaId)])).rows;

    const limpiar = async (facturaId) => pool.query(
        `DELETE FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1`, [String(facturaId)]);

    test('la vista previa trae el texto por defecto y el periodo', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5001');
        const r = await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'administrativo');
        assert.equal(r.status, 200);
        assert.match(r.body.asunto, /Factura folio T-5001/);
        assert.match(r.body.cuerpo, /orden de trabajo/);
        assert.equal(r.body.envio_pendiente, false);
        assert.equal((await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'gerente')).status, 200);
        assert.equal((await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/99999999/vista-previa', 'administrativo')).status, 404);
        assert.equal((await pedir('GET', '/api/facturacion/abc/vista-previa', 'administrativo')).status, 400);
    });

    test('autorizar el envio guarda texto editado, factura_id y los campos antiguos en el payload', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura, email } = await otFacturadaConCorreo('T-5002');
        try {
            const r = await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo',
                { asunto: '  Asunto propio ', cuerpo: 'Hola,\nadjuntamos su factura.' });
            assert.equal(r.status, 200);
            const filas = await correosDe(factura);
            assert.equal(filas.length, 1);
            assert.equal(filas[0].estado, 'pendiente');
            const p = filas[0].payload;
            assert.equal(p.asunto, 'Asunto propio');
            assert.equal(p.cuerpo, 'Hola,\nadjuntamos su factura.');
            assert.equal(p.factura_id, factura);
            assert.equal(p.orden_trabajo_id, ot);
            assert.equal(p.folio, 'T-5002');
            assert.equal(p.tipo, 'factura_emitida');
            const dest = await pool.query('SELECT destinatario FROM notificaciones_pendientes WHERE id = $1', [filas[0].id]);
            assert.equal(dest.rows[0].destinatario, email);
        } finally {
            await limpiar(factura);
        }
    });

    test('sin texto usa el de por defecto y un asunto con salto de linea da 400', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5003');
        try {
            const mala = await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', { asunto: 'Uno\nBcc: x@y.cl' });
            assert.equal(mala.status, 400);
            assert.equal((await correosDe(factura)).length, 0);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            const p = (await correosDe(factura))[0].payload;
            assert.match(p.asunto, /Factura folio T-5003/);
            assert.ok(p.cuerpo.length > 10);
        } finally {
            await limpiar(factura);
        }
    });

    test('un segundo autorizar con el primero pendiente da 409; con dos clics a la vez sale uno solo', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5004');
        try {
            const resultados = await Promise.all([
                pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {}),
                pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {}),
            ]);
            assert.deepEqual(resultados.map((r) => r.status).sort(), [200, 409]);
            assert.equal((await correosDe(factura)).length, 1);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 409);
            const vista = await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'administrativo');
            assert.equal(vista.body.envio_pendiente, true);
        } finally {
            await limpiar(factura);
        }
    });

    test('corregir folio o monto con un envio pendiente da 409', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5005');
        try {
            assert.equal((await pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: 'T-5005B' })).status, 200);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            assert.equal((await pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: 'T-5005C' })).status, 409);
            const f = await pool.query('SELECT folio FROM facturas WHERE id = $1', [factura]);
            assert.equal(f.rows[0].folio, 'T-5005B');
        } finally {
            await limpiar(factura);
        }
    });

    test('la ruta antigua por orden usa el mismo texto y las mismas reglas', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturadaConCorreo('T-5006');
        try {
            const otra = await crearOt();
            assert.equal((await pedir('POST', `/api/ordenes-trabajo/${otra}/factura/${factura}/autorizar-envio`, 'administrativo', {})).status, 404);
            const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura}/autorizar-envio`, 'administrativo', { asunto: 'Desde la ruta antigua' });
            assert.equal(r.status, 200);
            assert.equal((await correosDe(factura))[0].payload.asunto, 'Desde la ruta antigua');
            assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura}/autorizar-envio`, 'administrativo', {})).status, 409);
        } finally {
            await limpiar(factura);
        }
    });

    test('anular la factura cancela el correo pendiente o en error y autorizar despues da 404', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturadaConCorreo('T-5007');
        try {
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            const filas = await correosDe(factura);
            // un correo que ya agoto sus reintentos tambien se cancela
            await pool.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, estado, payload) VALUES ('email', 'x@y.cl', 'error', $1)`,
                [JSON.stringify({ tipo: 'factura_emitida', factura_id: factura, folio: 'T-5007' })]);
            const anular = await pedir('POST', rutaAnularFactura(ot, factura), 'administrativo', MOTIVO_VALIDO);
            assert.equal(anular.status, 200);
            const despues = await correosDe(factura);
            assert.equal(despues.length, 2);
            assert.ok(despues.every((c) => c.estado === 'cancelado'), JSON.stringify(despues.map((c) => c.estado)));
            assert.equal(despues[0].id, filas[0].id);
            assert.match(despues[0].ultimo_error, /anulada/);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 404);
        } finally {
            await limpiar(factura);
        }
    });

    test('anular cancela tambien los correos antiguos que no llevaban factura_id (por orden y folio)', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturadaConCorreo('T-5008');
        const viejo = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'factura_emitida', orden_trabajo_id: ot, folio: 'T-5008' })]);
        const ajeno = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'factura_emitida', orden_trabajo_id: ot, folio: 'OTRO-FOLIO' })]);
        try {
            assert.equal((await pedir('POST', rutaAnularFactura(ot, factura), 'administrativo', MOTIVO_VALIDO)).status, 200);
            const estados = await pool.query('SELECT id, estado FROM notificaciones_pendientes WHERE id = ANY($1)', [[viejo.rows[0].id, ajeno.rows[0].id]]);
            const por = Object.fromEntries(estados.rows.map((x) => [x.id, x.estado]));
            assert.equal(por[viejo.rows[0].id], 'cancelado');
            assert.equal(por[ajeno.rows[0].id], 'pendiente', 'otro folio no se toca');
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [[viejo.rows[0].id, ajeno.rows[0].id]]);
        }
    });

    test('anular y autorizar a la vez nunca dejan un correo pendiente de una factura que ya no existe', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 6; vuelta++) {
            const { ot, factura } = await otFacturadaConCorreo(`T-51${vuelta}`);
            try {
                const [autorizar, anular] = await Promise.all([
                    pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {}),
                    pedir('POST', rutaAnularFactura(ot, factura), 'administrativo', MOTIVO_VALIDO),
                ]);
                assert.equal(anular.status, 200, JSON.stringify(anular.body));
                assert.ok([200, 404].includes(autorizar.status), `autorizar dio ${autorizar.status}`);
                const existe = (await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length;
                assert.equal(existe, 0);
                const pendientes = (await correosDe(factura)).filter((c) => c.estado === 'pendiente');
                assert.equal(pendientes.length, 0, 'ningun correo pendiente de una factura anulada');
            } finally {
                await limpiar(factura);
            }
        }
    });

    test('el worker no envia ni reintenta el correo de una factura anulada', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5009');
        try {
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            const [correo] = await correosDe(factura);
            // la factura desaparece por una via que no cancela el correo (como la de la version anterior)
            await pool.query('DELETE FROM facturas WHERE id = $1', [factura]);
            const vigente = await sigueVigente({ id: correo.id });
            assert.equal(vigente, false);
            const despues = (await correosDe(factura))[0];
            assert.equal(despues.estado, 'cancelado');
            // ya cancelado: otra revision tampoco lo envia y reintentar no lo revive
            assert.equal(await sigueVigente({ id: correo.id }), false);
            assert.equal((await pedir('POST', `/api/notificaciones/${correo.id}/reintentar`, 'administrativo', {})).status, 404);
        } finally {
            await limpiar(factura);
        }
    });

    test('una notificacion cancelada despues de ser tomada no se envia ni se pisa', async (t) => {
        if (!requiereBase(t)) return;
        const n = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'otro' })]);
        try {
            assert.equal(await sigueVigente({ id: n.rows[0].id }), true);
            await pool.query("UPDATE notificaciones_pendientes SET estado = 'cancelado' WHERE id = $1", [n.rows[0].id]);
            assert.equal(await sigueVigente({ id: n.rows[0].id }), false);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = $1', [n.rows[0].id]);
        }
    });
});

describe('correo de la factura: casos adversos', () => {
    const { procesarUna, usarEnvio } = require('../src/workers/notificaciones');

    async function facturaConCorreo(folio) {
        const cliente = await pool.query("SELECT id, email FROM clientes WHERE email IS NOT NULL ORDER BY id LIMIT 1");
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, folio);
        const f = (await pool.query(
            'UPDATE facturas SET cliente_id = $2 WHERE orden_trabajo_id = $1 RETURNING id', [ot, cliente.rows[0].id])).rows[0];
        return { ot, factura: f.id };
    }
    const correos = async (facturaId) => (await pool.query(
        `SELECT id, estado, intentos, payload, ultimo_error, enviado_at FROM notificaciones_pendientes
         WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1 ORDER BY id`, [String(facturaId)])).rows;
    const limpiar = (facturaId) => pool.query(
        `DELETE FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1`, [String(facturaId)]);
    const ponerEnError = (id) => pool.query(
        "UPDATE notificaciones_pendientes SET estado = 'error', intentos = 5, ultimo_error = 'proveedor no configurado' WHERE id = $1", [id]);
    const autorizar = (factura, cuerpo = {}) => pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', cuerpo);

    test('el asunto rechaza caracteres de control y separadores de linea de Unicode; el cuerpo, los de control salvo salto y tabulacion', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await facturaConCorreo('T-5101');
        try {
            for (const asunto of ['Uno Dos', 'Uno\u0085Dos', 'Uno\u000BDos', 'Uno\u0000Dos', 'Uno Dos', 'Uno\u007FDos', 'Uno\tDos']) {
                const r = await autorizar(factura, { asunto });
                assert.equal(r.status, 400, `asunto ${JSON.stringify(asunto)} dio ${r.status}`);
            }
            for (const cuerpo of ['Hola\u0000mundo', 'Hola\u000Bmundo', 'Hola\u001Bmundo', 'Hola\u007Fmundo']) {
                const r = await autorizar(factura, { cuerpo });
                assert.equal(r.status, 400, `cuerpo ${JSON.stringify(cuerpo)} dio ${r.status}`);
            }
            assert.equal((await correos(factura)).length, 0, 'ningun intento fallido deja un correo');
            const bien = await autorizar(factura, { asunto: 'Asunto normal', cuerpo: 'Linea 1\r\nLinea 2\n\tcon tabulacion' });
            assert.equal(bien.status, 200);
            assert.equal((await correos(factura))[0].payload.cuerpo, 'Linea 1\nLinea 2\n\tcon tabulacion');
        } finally {
            await limpiar(factura);
        }
    });

    test('el folio invalido se rechaza al subir la factura y al corregirla', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        for (const folio of ['F-1\nBcc: x@y.cl', 'F<1>', 'a'.repeat(51), '   ', 'F;1']) {
            const r = await subirFactura(ot, 'administrativo', { folio });
            assert.equal(r.status, 400, `folio ${JSON.stringify(folio)} dio ${r.status}`);
        }
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows.length, 0);
        const ok = await subirFactura(ot, 'administrativo', { folio: ' F-5102/A ' });
        assert.equal(ok.status, 201);
        assert.equal(ok.body.folio, 'F-5102/A', 'el folio se guarda sin espacios sobrantes');
        const id = ok.body.id;
        for (const folio of ['X\nY', 'F<1>', 'a'.repeat(51)]) {
            assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { folio })).status, 400, JSON.stringify(folio));
        }
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { folio: 'F-5102/B' })).status, 200);
    });

    test('el traslado de una factura se corrige sin pasarse del monto', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        const ok = await subirFactura(ot, 'administrativo', { folio: 'T-TRAS-1', monto: '100000' });
        assert.equal(ok.status, 201);
        const id = ok.body.id;
        const traslado = async () => Number((await pool.query('SELECT monto_traslado FROM facturas WHERE id = $1', [id])).rows[0].monto_traslado);
        assert.equal(await traslado(), 0, 'sin indicarlo, el traslado vale 0');
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto_traslado: '20000' })).status, 200);
        assert.equal(await traslado(), 20000);
        for (const malo of ['100001', '-5', '1.5', 'abc']) {
            assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto_traslado: malo })).status, 400, malo);
        }
        // bajar el monto por debajo del traslado ya guardado tambien se rechaza
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto: '10000' })).status, 400);
        assert.equal(await traslado(), 20000, 'un rechazo no cambia nada');
        // otro cambio (folio) no toca el traslado
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { folio: 'T-TRAS-2' })).status, 200);
        assert.equal(await traslado(), 20000);
    });

    test('corregir la factura cancela el correo anterior que quedo en error', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await facturaConCorreo('T-5103');
        try {
            assert.equal((await autorizar(factura)).status, 200);
            const [primero] = await correos(factura);
            await ponerEnError(primero.id);
            const r = await pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: 'T-5103B' });
            assert.equal(r.status, 200);
            const despues = (await correos(factura))[0];
            assert.equal(despues.estado, 'cancelado');
            assert.equal(despues.ultimo_error, 'Factura corregida');
            // reintentar el correo cancelado no lo revive
            assert.equal((await pedir('POST', `/api/notificaciones/${primero.id}/reintentar`, 'administrativo', {})).status, 404);
        } finally {
            await limpiar(factura);
        }
    });

    test('un correo nuevo reemplaza al anterior que estaba en error', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await facturaConCorreo('T-5104');
        try {
            assert.equal((await autorizar(factura)).status, 200);
            const [primero] = await correos(factura);
            await ponerEnError(primero.id);
            assert.equal((await autorizar(factura, { asunto: 'Segundo intento' })).status, 200);
            const filas = await correos(factura);
            assert.equal(filas.length, 2);
            assert.equal(filas[0].estado, 'cancelado');
            assert.equal(filas[0].ultimo_error, 'Reemplazado');
            assert.equal(filas[1].estado, 'pendiente');
            assert.equal(filas[1].payload.asunto, 'Segundo intento');
        } finally {
            await limpiar(factura);
        }
    });

    test('reintentar un correo en error se rechaza si hay otro pendiente, si la factura cambio o si ya no existe', async (t) => {
        if (!requiereBase(t)) return;
        const reintentar = (id) => pedir('POST', `/api/notificaciones/${id}/reintentar`, 'administrativo', {});
        // 1. caso normal: vuelve a la cola
        const a = await facturaConCorreo('T-5105');
        // 2. ya hay otro pendiente de la misma factura
        const b = await facturaConCorreo('T-5106');
        // 3. la factura cambio de folio (por una via que no cancela, como la version anterior)
        const c = await facturaConCorreo('T-5107');
        // 4. la factura ya no existe
        const d = await facturaConCorreo('T-5108');
        try {
            assert.equal((await autorizar(a.factura)).status, 200);
            const [ca] = await correos(a.factura);
            await ponerEnError(ca.id);
            assert.equal((await reintentar(ca.id)).status, 200);
            assert.equal((await correos(a.factura))[0].estado, 'pendiente');

            assert.equal((await autorizar(b.factura)).status, 200);
            const [cb] = await correos(b.factura);
            await ponerEnError(cb.id);
            // otro pendiente de la misma factura, insertado a mano
            await pool.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1)`,
                [JSON.stringify({ tipo: 'factura_emitida', factura_id: b.factura, folio: 'T-5106', monto: 100000 })]);
            const rb = await reintentar(cb.id);
            assert.equal(rb.status, 409);
            assert.match(rb.body.error, /otro envío pendiente/);

            assert.equal((await autorizar(c.factura)).status, 200);
            const [cc] = await correos(c.factura);
            await ponerEnError(cc.id);
            await pool.query("UPDATE facturas SET folio = 'T-5107-CORREGIDO' WHERE id = $1", [c.factura]);
            const rc = await reintentar(cc.id);
            assert.equal(rc.status, 409);
            assert.match(rc.body.error, /cambió/);

            assert.equal((await autorizar(d.factura)).status, 200);
            const [cd] = await correos(d.factura);
            await ponerEnError(cd.id);
            await pool.query('DELETE FROM facturas WHERE id = $1', [d.factura]);
            const rd = await reintentar(cd.id);
            assert.equal(rd.status, 409);
            assert.match(rd.body.error, /ya no existe/);
        } finally {
            for (const x of [a, b, c, d]) await limpiar(x.factura);
        }
    });

    test('corregir y autorizar a la vez: el correo nunca lleva un folio distinto del de la factura', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 6; vuelta++) {
            const { factura } = await facturaConCorreo(`T-52${vuelta}`);
            try {
                const [parche, envio] = await Promise.all([
                    pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: `T-52${vuelta}-B` }),
                    autorizar(factura),
                ]);
                assert.ok([200, 409].includes(parche.status), `PATCH dio ${parche.status}`);
                assert.equal(envio.status, 200);
                const fila = (await pool.query('SELECT folio FROM facturas WHERE id = $1', [factura])).rows[0];
                const pendientes = (await correos(factura)).filter((c) => c.estado === 'pendiente');
                assert.equal(pendientes.length, 1);
                if (parche.status === 200) {
                    assert.equal(fila.folio, `T-52${vuelta}-B`);
                    // el correo salio despues de la correccion: lleva el folio nuevo
                    assert.equal(pendientes[0].payload.folio, fila.folio);
                } else {
                    // el envio gano: el folio de la factura no cambio y el correo lo lleva
                    assert.equal(pendientes[0].payload.folio, fila.folio);
                }
            } finally {
                await limpiar(factura);
            }
        }
    });

    test('si la anulacion llega despues de salir el correo, la fila cancelada deja constancia del envio', async (t) => {
        if (!requiereBase(t)) return;
        const n = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING *`,
            [JSON.stringify({ tipo: 'otro' })])).rows[0];
        try {
            // el proveedor "responde bien", pero mientras tanto otra transaccion cancela la fila
            usarEnvio(async () => {
                await pool.query("UPDATE notificaciones_pendientes SET estado = 'cancelado', ultimo_error = 'Factura anulada' WHERE id = $1", [n.id]);
            });
            await procesarUna(n);
            const fila = (await pool.query('SELECT estado, ultimo_error, enviado_at FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
            assert.equal(fila.estado, 'cancelado', 'no se pisa a enviado');
            assert.equal(fila.ultimo_error, 'Enviado antes de que la anulación lo alcanzara');
            assert.ok(fila.enviado_at, 'queda la hora del envio');
        } finally {
            usarEnvio(null);
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = $1', [n.id]);
        }
    });

    test('el worker marca enviado una notificacion vigente cuando el proveedor responde bien', async (t) => {
        if (!requiereBase(t)) return;
        const n = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING *`,
            [JSON.stringify({ tipo: 'otro' })])).rows[0];
        try {
            usarEnvio(async () => {});
            await procesarUna(n);
            const fila = (await pool.query('SELECT estado, enviado_at FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
            assert.equal(fila.estado, 'enviado');
            assert.ok(fila.enviado_at);
        } finally {
            usarEnvio(null);
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = $1', [n.id]);
        }
    });
});
