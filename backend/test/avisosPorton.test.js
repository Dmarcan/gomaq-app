const test = require('node:test');
const assert = require('node:assert/strict');
const { tieneProveedor, encolarNotificacion, TIPOS_CON_ENVIO, TIPOS_INTERNOS, TIPOS_AVISO } = require('../src/utils/avisos');

function clienteFalso() {
    const llamadas = [];
    return { llamadas, query: async (sql, params) => { llamadas.push({ sql, params }); return { rows: [] }; } };
}

test('solo el correo de factura y el de cuenta aprobada tienen proveedor', () => {
    assert.deepEqual([...TIPOS_CON_ENVIO], ['factura_emitida', 'cuenta_aprobada']);
    assert.equal(tieneProveedor('email', 'factura_emitida'), true);
    assert.equal(tieneProveedor('email', 'cuenta_aprobada'), true);
    // la cuenta aprobada no es un tipo interno ni un push: un fallo debe contar en "Avisos con problemas"
    assert.equal(TIPOS_INTERNOS.includes('cuenta_aprobada'), false);
    assert.equal(Object.values(TIPOS_AVISO).includes('cuenta_aprobada'), false);
    for (const tipo of ['ot_finalizada', 'mecanico_asignado', 'ot_asignada', 'mantencion_proxima', undefined]) {
        assert.equal(tieneProveedor('email', tipo), false, tipo);
    }
    assert.equal(tieneProveedor('whatsapp', 'factura_emitida'), false);
    assert.equal(tieneProveedor('whatsapp', 'cuenta_aprobada'), false);
});

test('encolarNotificacion inserta el correo de cuenta aprobada con su payload', async () => {
    const c = clienteFalso();
    const payload = { tipo: 'cuenta_aprobada', nombre_contacto: 'Ana', url: 'https://panel.gomaq.test' };
    assert.equal(await encolarNotificacion(c, { canal: 'email', destinatario: 'ana@x.cl', payload }), 1);
    assert.equal(c.llamadas.length, 1);
    assert.deepEqual(c.llamadas[0].params, ['email', 'ana@x.cl', JSON.stringify(payload)]);
});

test('encolarNotificacion no inserta un aviso sin proveedor', async () => {
    const c = clienteFalso();
    const n = await encolarNotificacion(c, { canal: 'whatsapp', destinatario: '+56911111111', payload: { tipo: 'ot_finalizada' } });
    assert.equal(n, 0);
    assert.equal(c.llamadas.length, 0);
    assert.equal(await encolarNotificacion(c, { canal: 'email', destinatario: 'a@b.cl', payload: { tipo: 'mantencion_proxima' } }), 0);
    assert.equal(await encolarNotificacion(c, { canal: 'email', destinatario: 'a@b.cl', payload: null }), 0);
    assert.equal(c.llamadas.length, 0);
});

test('encolarNotificacion inserta el correo de factura', async () => {
    const c = clienteFalso();
    const n = await encolarNotificacion(c, { canal: 'email', destinatario: 'a@b.cl', payload: { tipo: 'factura_emitida', folio: '1' } });
    assert.equal(n, 1);
    assert.equal(c.llamadas.length, 1);
    assert.deepEqual(c.llamadas[0].params, ['email', 'a@b.cl', JSON.stringify({ tipo: 'factura_emitida', folio: '1' })]);
});
