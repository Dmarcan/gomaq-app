const test = require('node:test');
const assert = require('node:assert/strict');
const {
    planificarReintento, plazoTomaSegundos, conTimeout, ESPERA_MAXIMA_SEGUNDOS,
} = require('../src/utils/reintentosNotificacion');

test('un fallo comun suma un intento y espera con backoff exponencial', () => {
    const r1 = planificarReintento({ intentos: 0, maxIntentos: 5, error: new Error('x') });
    assert.deepEqual(r1, { intentos: 1, estado: 'pendiente', esperaSegundos: 30 });
    const r3 = planificarReintento({ intentos: 2, maxIntentos: 5, error: new Error('x') });
    assert.deepEqual(r3, { intentos: 3, estado: 'pendiente', esperaSegundos: 120 });
});

test('al llegar al maximo de intentos queda en error', () => {
    const r = planificarReintento({ intentos: 4, maxIntentos: 5, error: new Error('x') });
    assert.equal(r.estado, 'error');
    assert.equal(r.intentos, 5);
});

test('un limite del proveedor reprograma sin sumar intento', () => {
    const error = Object.assign(new Error('429'), { reintentarEnSegundos: 90 });
    const r = planificarReintento({ intentos: 4, maxIntentos: 5, error });
    assert.deepEqual(r, { intentos: 4, estado: 'pendiente', esperaSegundos: 90 });
});

test('un Retry-After exagerado se acota', () => {
    const error = Object.assign(new Error('429'), { reintentarEnSegundos: 999999 });
    const r = planificarReintento({ intentos: 0, maxIntentos: 5, error });
    assert.equal(r.esperaSegundos, ESPERA_MAXIMA_SEGUNDOS);
});

test('un Retry-After invalido se trata como fallo comun', () => {
    const error = Object.assign(new Error('429'), { reintentarEnSegundos: 'abc' });
    const r = planificarReintento({ intentos: 0, maxIntentos: 5, error });
    assert.equal(r.intentos, 1);
});

test('el plazo de toma cubre el peor caso del lote', () => {
    assert.equal(plazoTomaSegundos({ lote: 5, timeoutMs: 15000 }), 120);
    assert.equal(plazoTomaSegundos({ lote: 20, timeoutMs: 15000 }), 330);
});

test('conTimeout devuelve el resultado si el envio termina a tiempo', async () => {
    assert.equal(await conTimeout(async () => 'ok', 200), 'ok');
});

test('conTimeout rechaza y aborta si el envio tarda demasiado', async () => {
    let senal;
    await assert.rejects(
        conTimeout((signal) => { senal = signal; return new Promise(() => {}); }, 20),
        /limite/
    );
    assert.equal(senal.aborted, true);
});
