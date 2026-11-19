// Fotos del antes y el despues en el correo de factura, sin base de datos ni Supabase: la base y el almacenamiento
// se reemplazan por falsos. Las consultas reales las valida el CI con Postgres (escritura.test.js).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/db');
const { validarFotosDelEnvio, encolarCorreoFactura } = require('../src/utils/correoFactura');
const { adjuntarFotosFactura, plazoDeEnvio, procesarUna, usarEnvio } = require('../src/workers/notificaciones');

const FACTURA = {
    id: 40, folio: 'F-40', monto: 1000, orden_trabajo_id: 7, maquinaria_id: 3, ot_maquinaria_id: 3,
    cliente_nombre: 'Acsa', cliente_email: 'a@b.cl', maquinaria_codigo: 'EXC-04',
};
const FOTOS_OT = [
    { id: 11, tipo: 'antes', path: 'antes/ot-7/a.jpg' },
    { id: 12, tipo: 'despues', path: 'despues/ot-7/b.jpg' },
];

/** db falso: responde segun la sentencia. `fotos` son las filas de evidencias de la orden. */
function dbFalso({ factura = FACTURA, fotos = FOTOS_OT, previo = null } = {}) {
    const llamadas = [];
    const query = async (sql, params) => {
        llamadas.push({ sql, params });
        if (/foto_ids/.test(sql)) return { rows: previo ? [{ foto_ids: previo }] : [] };
        if (/FROM evidencias_fotograficas/.test(sql)) {
            const soloId = /SELECT id FROM/.test(sql);
            return { rows: fotos.filter((f) => params[1].includes(f.id)).map((f) => (soloId ? { id: f.id } : f)) };
        }
        if (/FOR NO KEY UPDATE/.test(sql)) return { rows: [{ id: 40 }] };
        if (/FROM facturas f/.test(sql)) return { rows: factura ? [factura] : [] };
        if (/SELECT 1/.test(sql)) return { rows: [] };
        return { rows: [], rowCount: 0 };
    };
    return { query, llamadas, connect: async () => ({ query, release() {} }) };
}

const bytes = (n) => Buffer.alloc(n, 1);
const reducirA = (n) => async () => bytes(n);
const MB = 1024 * 1024;

describe('validarFotosDelEnvio', () => {
    test('una lista vacia es "sin fotos": no toca la base ni el almacenamiento', async () => {
        const db = dbFalso({ previo: [11] }); // aunque el ultimo correo llevara fotos
        assert.deepEqual(await validarFotosDelEnvio(db, null, 'b', { facturaId: 40, fotoIds: [] }), { ids: [] });
        assert.equal(db.llamadas.length, 0);
    });

    test('sin lista (un reenvio) y sin correo anterior con fotos: sin fotos', async () => {
        assert.deepEqual(await validarFotosDelEnvio(dbFalso(), null, 'b', { facturaId: 40, fotoIds: undefined }), { ids: [] });
        assert.deepEqual(await validarFotosDelEnvio(dbFalso(), null, 'b', { facturaId: 40, fotoIds: null }), { ids: [] });
    });

    test('sin lista repite la seleccion del ultimo correo, y la vuelve a medir', async () => {
        const r = await validarFotosDelEnvio(dbFalso({ previo: [12, 11] }), null, 'b', {
            facturaId: 40, fotoIds: undefined, descargar: async () => bytes(5), reducir: reducirA(1000),
        });
        assert.deepEqual(r, { ids: [12, 11] });
        const pesado = await validarFotosDelEnvio(dbFalso({ previo: [11, 12] }), null, 'b', {
            facturaId: 40, fotoIds: undefined, descargar: async () => bytes(5), reducir: reducirA(6 * MB),
        });
        assert.equal(pesado.status, 400);
    });

    test('al repetir la seleccion se omiten las fotos que ya no existen en la orden', async () => {
        const r = await validarFotosDelEnvio(dbFalso({ previo: [11, 99] }), null, 'b', {
            facturaId: 40, fotoIds: undefined, descargar: async () => bytes(5), reducir: reducirA(10),
        });
        assert.deepEqual(r, { ids: [11] });
    });

    test('un reenvio de una factura sin orden (arriendo) no lleva fotos', async () => {
        const db = dbFalso({ factura: { ...FACTURA, orden_trabajo_id: null }, previo: [11] });
        assert.deepEqual(await validarFotosDelEnvio(db, null, 'b', { facturaId: 40, fotoIds: undefined }), { ids: [] });
    });

    test('ids que no son de fotos: 400', async () => {
        const r = await validarFotosDelEnvio(dbFalso(), null, 'b', { facturaId: 40, fotoIds: ['x'] });
        assert.equal(r.status, 400);
    });

    test('una factura sin orden de trabajo (arriendo) no admite fotos', async () => {
        const db = dbFalso({ factura: { ...FACTURA, orden_trabajo_id: null } });
        const r = await validarFotosDelEnvio(db, null, 'b', { facturaId: 40, fotoIds: [11] });
        assert.equal(r.status, 400);
        assert.match(r.error, /no tiene orden de trabajo/);
    });

    test('factura inexistente: 404', async () => {
        const r = await validarFotosDelEnvio(dbFalso({ factura: null }), null, 'b', { facturaId: 40, fotoIds: [11] });
        assert.equal(r.status, 404);
    });

    test('una foto de otra orden se rechaza: la consulta se limita a la orden de la factura', async () => {
        const db = dbFalso();
        const r = await validarFotosDelEnvio(db, null, 'b', {
            facturaId: 40, fotoIds: [11, 99], descargar: async () => bytes(5), reducir: reducirA(10),
        });
        assert.equal(r.status, 400);
        assert.match(r.error, /no pertenece a esta orden/);
        const consulta = db.llamadas.find((l) => /FROM evidencias_fotograficas/.test(l.sql));
        assert.deepEqual(consulta.params, [7, [11, 99]]);
    });

    test('una foto cuyo archivo ya no existe: 409', async () => {
        const r = await validarFotosDelEnvio(dbFalso(), null, 'b', {
            facturaId: 40, fotoIds: [11, 12], descargar: async (p) => (p.includes('a.jpg') ? null : bytes(5)), reducir: reducirA(10),
        });
        assert.equal(r.status, 409);
    });

    test('si no caben en 10 MB ya reducidas: 400 con el peso y el maximo', async () => {
        const r = await validarFotosDelEnvio(dbFalso(), null, 'b', {
            facturaId: 40, fotoIds: [11, 12], descargar: async () => bytes(5), reducir: reducirA(6 * MB),
        });
        assert.equal(r.status, 400);
        assert.match(r.error, /pesan 12 MB/);
        assert.match(r.error, /máximo es 10 MB/);
    });

    test('un fallo del almacenamiento es 503 (reintentable), no 500', async () => {
        const r = await validarFotosDelEnvio(dbFalso(), null, 'b', {
            facturaId: 40, fotoIds: [11], descargar: async () => { throw new Error('Storage caido'); }, reducir: reducirA(1),
        });
        assert.equal(r.status, 503);
    });

    test('si caben, devuelve los ids en el orden pedido', async () => {
        const r = await validarFotosDelEnvio(dbFalso(), null, 'b', {
            facturaId: 40, fotoIds: [12, 11], descargar: async () => bytes(5), reducir: reducirA(1000),
        });
        assert.deepEqual(r, { ids: [12, 11] });
    });
});

describe('encolarCorreoFactura con fotos', () => {
    const insertados = (db) => db.llamadas.filter((l) => /INSERT INTO notificaciones_pendientes/.test(l.sql));

    test('guarda foto_ids en el payload', async () => {
        const db = dbFalso();
        const r = await encolarCorreoFactura(db, { facturaId: 40, fotoIds: [11, 12] });
        assert.equal(r.status, 200);
        const payload = JSON.parse(insertados(db)[0].params[2]);
        assert.deepEqual(payload.foto_ids, [11, 12]);
        assert.equal(payload.tipo, 'factura_emitida');
        assert.equal(payload.orden_trabajo_id, 7);
    });

    test('sin fotos el payload no lleva foto_ids (el correo sale como siempre)', async () => {
        const db = dbFalso();
        await encolarCorreoFactura(db, { facturaId: 40 });
        assert.equal('foto_ids' in JSON.parse(insertados(db)[0].params[2]), false);
    });

    test('con la factura bloqueada se confirma otra vez que las fotos son de su orden', async () => {
        const db = dbFalso({ fotos: [FOTOS_OT[0]] });
        const r = await encolarCorreoFactura(db, { facturaId: 40, fotoIds: [11, 12] });
        assert.equal(r.status, 400);
        assert.equal(insertados(db).length, 0);
    });

    test('una factura sin orden no encola fotos', async () => {
        const db = dbFalso({ factura: { ...FACTURA, orden_trabajo_id: null } });
        const r = await encolarCorreoFactura(db, { facturaId: 40, fotoIds: [11] });
        assert.equal(r.status, 400);
        assert.equal(insertados(db).length, 0);
    });
});

describe('worker: adjuntarFotosFactura', () => {
    function conPool(responder) {
        const original = pool.query;
        const llamadas = [];
        pool.query = async (sql, params) => { llamadas.push({ sql, params }); return responder(sql, params); };
        return { llamadas, restaurar: () => { pool.query = original; usarEnvio(null); } };
    }
    const payload = { tipo: 'factura_emitida', factura_id: 40, orden_trabajo_id: 7, foto_ids: [11, 12] };

    test('sin foto_ids no consulta nada', async () => {
        const f = conPool(() => { throw new Error('no debio consultar'); });
        try {
            assert.deepEqual(await adjuntarFotosFactura({ tipo: 'factura_emitida' }, undefined), { adjuntos: [], faltantes: [] });
        } finally { f.restaurar(); }
    });

    test('lee solo fotos de la orden del correo y adjunta antes-N y despues-N sin el campo bytes', async () => {
        const f = conPool(() => ({ rows: FOTOS_OT }));
        try {
            const r = await adjuntarFotosFactura(payload, undefined, { descargar: async () => bytes(5), reducir: reducirA(20) });
            assert.deepEqual(r.adjuntos.map((a) => a.filename), ['antes-1.jpg', 'despues-1.jpg']);
            assert.deepEqual(Object.keys(r.adjuntos[0]).sort(), ['content', 'filename']);
            assert.deepEqual(f.llamadas[0].params, [7, [11, 12]]);
            assert.deepEqual(r.faltantes, []);
        } finally { f.restaurar(); }
    });

    test('una foto cuya fila ya no existe se omite y se informa', async () => {
        const f = conPool(() => ({ rows: [FOTOS_OT[1]] })); // la 11 ya no esta en la base
        try {
            const r = await adjuntarFotosFactura(payload, undefined, { descargar: async () => bytes(5), reducir: reducirA(20) });
            assert.deepEqual(r.adjuntos.map((a) => a.filename), ['despues-1.jpg']);
            assert.deepEqual(r.faltantes, [11]);
        } finally { f.restaurar(); }
    });

    test('una foto cuyo archivo ya no existe se omite y se informa', async () => {
        const f = conPool(() => ({ rows: FOTOS_OT }));
        try {
            const r = await adjuntarFotosFactura(payload, undefined, {
                descargar: async (p) => (p.includes('a.jpg') ? null : bytes(5)), reducir: reducirA(20),
            });
            assert.deepEqual(r.adjuntos.map((a) => a.filename), ['despues-1.jpg']);
            assert.deepEqual(r.faltantes, [11]);
        } finally { f.restaurar(); }
    });

    test('si no caben en el tope es un error permanente', async () => {
        const f = conPool(() => ({ rows: FOTOS_OT }));
        try {
            await assert.rejects(
                adjuntarFotosFactura(payload, undefined, { descargar: async () => bytes(5), reducir: reducirA(8 * MB) }),
                (e) => e.permanente === true && /pesan 16 MB/.test(e.message)
            );
        } finally { f.restaurar(); }
    });

    test('foto_ids sin orden de trabajo es un error permanente', async () => {
        await assert.rejects(adjuntarFotosFactura({ ...payload, orden_trabajo_id: null }), (e) => e.permanente === true);
    });
});

describe('worker: plazo y nota', () => {
    test('un correo con fotos tiene mas plazo que el resto', () => {
        const base = plazoDeEnvio({ canal: 'email', payload: { tipo: 'factura_emitida' } });
        const conFotos = plazoDeEnvio({ canal: 'email', payload: { tipo: 'factura_emitida', foto_ids: [1] } });
        assert.ok(conFotos > base);
        assert.equal(plazoDeEnvio({ canal: 'push', payload: { foto_ids: [1] } }), base);
    });

    test('un envio que devuelve { nota } deja la nota en ultimo_error al marcarlo enviado', async () => {
        const original = pool.query;
        const llamadas = [];
        pool.query = async (sql, params) => {
            llamadas.push({ sql, params });
            if (/^\s*SELECT/i.test(sql)) return { rows: [{ estado: 'pendiente' }] };
            return { rows: [], rowCount: 1 };
        };
        usarEnvio(async () => ({ nota: 'Enviado sin 1 foto(s)' }));
        try {
            await procesarUna({
                id: 5, canal: 'email', destinatario: 'a@b.cl', intentos: 0,
                payload: { tipo: 'factura_emitida', factura_id: 40 }, created_at: new Date(),
            });
        } finally { pool.query = original; usarEnvio(null); }
        const marcado = llamadas.find((l) => /SET estado = 'enviado'/.test(l.sql));
        assert.ok(marcado, 'debio marcar la notificacion como enviada');
        assert.deepEqual(marcado.params, [5, 'Enviado sin 1 foto(s)']);
    });
});
