const test = require('node:test');
const assert = require('node:assert/strict');
const { conLlegadaEstimada, SQL_ETA_LLEGADA_AT } = require('../src/utils/etaLlegada');

const llegada = new Date('2026-01-01T15:00:00Z');
const enCamino = { id: 1, estado: 'en_camino', eta_llegada_at: llegada };

test('administrativo y gerente ven la llegada solo en camino', () => {
    for (const rol of ['administrativo', 'gerente']) {
        assert.equal(conLlegadaEstimada(enCamino, rol).eta_llegada_at, llegada);
        assert.equal('eta_llegada_at' in conLlegadaEstimada({ ...enCamino, estado: 'en_terreno' }, rol), false);
        assert.equal('eta_llegada_at' in conLlegadaEstimada({ ...enCamino, eta_llegada_at: null }, rol), false);
    }
});

test('mecanico y cliente no ganan el campo', () => {
    for (const rol of ['mecanico', 'cliente', undefined]) {
        assert.equal('eta_llegada_at' in conLlegadaEstimada(enCamino, rol), false);
    }
});

test('la expresion SQL exige en camino', () => {
    assert.match(SQL_ETA_LLEGADA_AT, /en_camino/);
});
