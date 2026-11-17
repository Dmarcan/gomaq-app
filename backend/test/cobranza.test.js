// Reglas puras de cobranza (utils/cobranza.js): estado, dias de mora, vencimiento propuesto y validaciones.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    estadoCobranza, diasMora, diasParaVencer, vencimientoPropuesto, textoAvisoPlazo,
    validarFechasFactura, validarFechaPago, validarFolioNotaCredito, hoySantiago,
    FILTROS_ESTADO, SQL_FACTURAS_VENCIDAS, SQL_FACTURAS_PROXIMAS, ESTADOS,
} = require('../src/utils/cobranza');

const HOY = '2026-11-17';
const f = (campos) => ({ fecha_vencimiento: null, fecha_pago: null, anulada_nc: null, ...campos });

describe('estadoCobranza en los bordes', () => {
    test('vence hoy es proxima (faltan 0 dias), no vencida', () => {
        assert.equal(estadoCobranza(f({ fecha_vencimiento: '2026-11-17' }), HOY), 'proxima');
        assert.equal(diasParaVencer(f({ fecha_vencimiento: '2026-11-17' }), HOY), 0);
    });
    test('vencio ayer es vencida, con 1 dia de mora', () => {
        const x = f({ fecha_vencimiento: '2026-11-16' });
        assert.equal(estadoCobranza(x, HOY), 'vencida');
        assert.equal(diasMora(x, HOY), 1);
        assert.equal(diasParaVencer(x, HOY), null);
    });
    test('en 7 dias es proxima; en 8 esta al dia', () => {
        assert.equal(estadoCobranza(f({ fecha_vencimiento: '2026-11-24' }), HOY), 'proxima');
        assert.equal(diasParaVencer(f({ fecha_vencimiento: '2026-11-24' }), HOY), 7);
        assert.equal(estadoCobranza(f({ fecha_vencimiento: '2026-11-25' }), HOY), 'al_dia');
        assert.equal(diasParaVencer(f({ fecha_vencimiento: '2026-11-25' }), HOY), 8);
    });
    test('sin vencimiento: las facturas ya cargadas no inventan una fecha', () => {
        assert.equal(estadoCobranza(f({}), HOY), 'sin_vencimiento');
        assert.equal(diasMora(f({}), HOY), 0);
        assert.equal(diasParaVencer(f({}), HOY), null);
    });
    test('pagada gana sobre vencida y anulada gana sobre todo', () => {
        assert.equal(estadoCobranza(f({ fecha_vencimiento: '2026-01-01', fecha_pago: '2026-02-01' }), HOY), 'pagada');
        assert.equal(estadoCobranza(f({ fecha_vencimiento: '2026-01-01', fecha_pago: '2026-02-01', anulada_nc: '77' }), HOY), 'anulada');
        assert.equal(estadoCobranza(f({ anulada_nc: 'NC-5' }), HOY), 'anulada');
    });
    test('un folio de NC vacio no anula', () => {
        assert.equal(estadoCobranza(f({ anulada_nc: '  ', fecha_vencimiento: '2026-11-10' }), HOY), 'vencida');
    });
    test('acepta Date de la base y entrada nula', () => {
        assert.equal(estadoCobranza(f({ fecha_vencimiento: new Date('2026-11-16T00:00:00Z') }), HOY), 'vencida');
        assert.equal(estadoCobranza(null, HOY), 'sin_vencimiento');
        assert.ok(ESTADOS.includes(estadoCobranza(f({}), HOY)));
    });
});

describe('diasMora', () => {
    test('pagada tarde: pago menos vencimiento', () => {
        assert.equal(diasMora(f({ fecha_vencimiento: '2026-08-28', fecha_pago: '2026-09-10' }), HOY), 13);
    });
    test('pagada a tiempo o antes: 0', () => {
        assert.equal(diasMora(f({ fecha_vencimiento: '2026-08-28', fecha_pago: '2026-08-28' }), HOY), 0);
        assert.equal(diasMora(f({ fecha_vencimiento: '2026-08-28', fecha_pago: '2026-08-01' }), HOY), 0);
    });
    test('vencida sin pagar: hoy menos vencimiento; anulada: 0', () => {
        assert.equal(diasMora(f({ fecha_vencimiento: '2026-10-18' }), HOY), 30);
        assert.equal(diasMora(f({ fecha_vencimiento: '2026-10-18', anulada_nc: '12' }), HOY), 0);
    });
    test('cruza un cambio de año sin errores de zona', () => {
        assert.equal(diasMora(f({ fecha_vencimiento: '2025-12-31' }), '2026-01-02'), 2);
    });
});

describe('vencimientoPropuesto', () => {
    test('PDF y plazo coinciden: la del PDF, sin alternativa', () => {
        const v = vencimientoPropuesto({ emision: '2026-07-14', vencimientoPdf: '2026-08-28', plazoCliente: 45 });
        assert.deepEqual(v, { propuesta: '2026-08-28', origen: 'pdf', alternativa: null, coincide: true, dias_pdf: 45, plazo_cliente_dias: 45 });
    });
    test('PDF y plazo distintos: la del PDF preseleccionada y la del plazo como alternativa', () => {
        const v = vencimientoPropuesto({ emision: '2026-07-14', vencimientoPdf: '2026-08-28', plazoCliente: 30 });
        assert.equal(v.propuesta, '2026-08-28');
        assert.equal(v.origen, 'pdf');
        assert.equal(v.coincide, false);
        assert.equal(v.alternativa, '2026-08-13');
        assert.equal(v.dias_pdf, 45);
        assert.match(textoAvisoPlazo(v), /28-08-2026 \(45 días\).*30 días, 13-08-2026/);
    });
    test('con PDF y cliente sin plazo: la del PDF, coincide null (no hay con que comparar)', () => {
        const v = vencimientoPropuesto({ emision: '2026-07-14', vencimientoPdf: '2026-08-28', plazoCliente: null });
        assert.equal(v.propuesta, '2026-08-28');
        assert.equal(v.coincide, null);
        assert.equal(v.alternativa, null);
    });
    test('sin fecha en el PDF: emision mas el plazo del cliente', () => {
        const v = vencimientoPropuesto({ emision: '2026-07-14', vencimientoPdf: null, plazoCliente: 30 });
        assert.equal(v.propuesta, '2026-08-13');
        assert.equal(v.origen, 'plazo_cliente');
    });
    test('plazo 0 (contado): vence el dia de la emision', () => {
        assert.equal(vencimientoPropuesto({ emision: '2026-07-14', plazoCliente: 0 }).propuesta, '2026-07-14');
        assert.equal(vencimientoPropuesto({ emision: '2026-07-14', vencimientoPdf: '2026-07-14', plazoCliente: 0 }).coincide, true);
    });
    test('sin PDF ni plazo (o sin emision): sin propuesta', () => {
        assert.equal(vencimientoPropuesto({ emision: '2026-07-14' }).propuesta, null);
        assert.equal(vencimientoPropuesto({ emision: null, plazoCliente: 30 }).propuesta, null);
        assert.equal(vencimientoPropuesto().origen, null);
    });
    test('un plazo fuera de rango se ignora', () => {
        assert.equal(vencimientoPropuesto({ emision: '2026-07-14', plazoCliente: 999 }).propuesta, null);
        assert.equal(vencimientoPropuesto({ emision: '2026-07-14', plazoCliente: 1.5 }).propuesta, null);
    });
});

describe('validaciones de fechas', () => {
    test('emision y vencimiento validos', () => {
        assert.deepEqual(validarFechasFactura({ fecha_emision: '2026-07-14', fecha_vencimiento: '2026-08-28' }, HOY),
            { fecha_emision: '2026-07-14', fecha_vencimiento: '2026-08-28' });
        assert.deepEqual(validarFechasFactura({}, HOY), { fecha_emision: null, fecha_vencimiento: null });
        assert.deepEqual(validarFechasFactura({ fecha_emision: '', fecha_vencimiento: null }, HOY), { fecha_emision: null, fecha_vencimiento: null });
    });
    test('dia que no existe o formato malo', () => {
        assert.ok(validarFechasFactura({ fecha_emision: '2026-02-30' }, HOY).error);
        assert.ok(validarFechasFactura({ fecha_vencimiento: '28-08-2026' }, HOY).error);
        assert.ok(validarFechasFactura({ fecha_vencimiento: 20260828 }, HOY).error);
    });
    test('emision: hasta mañana y desde el 2000', () => {
        assert.ok(!validarFechasFactura({ fecha_emision: '2026-11-18' }, HOY).error);
        assert.ok(validarFechasFactura({ fecha_emision: '2026-11-19' }, HOY).error);
        assert.ok(validarFechasFactura({ fecha_emision: '1999-12-31' }, HOY).error);
        assert.ok(validarFechasFactura({ fecha_emision: '2035-01-01' }, HOY).error, 'el error de tipeo de la planilla');
    });
    test('vencimiento: no antes de la emision ni mas de un año despues', () => {
        assert.match(validarFechasFactura({ fecha_emision: '2026-07-14', fecha_vencimiento: '2026-07-13' }, HOY).error, /anterior a la emisión/);
        assert.ok(!validarFechasFactura({ fecha_emision: '2026-07-14', fecha_vencimiento: '2026-07-14' }, HOY).error);
        assert.ok(validarFechasFactura({ fecha_emision: '2026-07-14', fecha_vencimiento: '2027-08-01' }, HOY).error);
        assert.ok(validarFechasFactura({ fecha_vencimiento: '1999-01-01' }, HOY).error);
    });
    test('fecha de pago: no futura, desde el 2000; vacia deshace', () => {
        assert.deepEqual(validarFechaPago('2026-11-17', HOY), { fecha_pago: '2026-11-17' });
        assert.match(validarFechaPago('2026-11-18', HOY).error, /futura/);
        assert.ok(validarFechaPago('1999-12-31', HOY).error);
        assert.ok(validarFechaPago('2026-13-01', HOY).error);
        assert.deepEqual(validarFechaPago(null, HOY), { fecha_pago: null });
        assert.deepEqual(validarFechaPago('', HOY), { fecha_pago: null });
    });
    test('folio de la nota de credito', () => {
        assert.deepEqual(validarFolioNotaCredito(' 76 '), { anulada_nc: '76' });
        assert.deepEqual(validarFolioNotaCredito(76), { anulada_nc: '76' });
        assert.deepEqual(validarFolioNotaCredito(null), { anulada_nc: null });
        assert.ok(validarFolioNotaCredito('x'.repeat(51)).error);
        assert.ok(validarFolioNotaCredito('76; DROP').error);
        assert.ok(validarFolioNotaCredito({}).error);
    });
});

test('hoySantiago usa la zona de Santiago, no la del servidor', () => {
    // 2026-11-18 02:00 UTC es todavia el 17 en Santiago (UTC-3 en verano)
    assert.equal(hoySantiago(new Date('2026-11-18T02:00:00Z')), '2026-11-17');
    assert.equal(hoySantiago(new Date('2026-11-18T04:00:00Z')), '2026-11-18');
});

describe('avisosPrecarga', () => {
    const { avisosPrecarga } = require('../src/utils/cobranza');
    const codigos = (leido, venc) => avisosPrecarga({ varias_cuotas: false, traslado_detectado: null, monto_neto_detectado: null, ...leido }, {
        propuesta: null, origen: null, alternativa: null, coincide: null, dias_pdf: null, plazo_cliente_dias: null, ...venc,
    }).map((a) => a.codigo);

    test('sin nada que avisar: lista vacia', () => {
        assert.deepEqual(codigos({}, {}), []);
    });
    test('vencimiento distinto del plazo, con las dos fechas en el texto', () => {
        const v = vencimientoPropuesto({ emision: '2026-07-14', vencimientoPdf: '2026-08-28', plazoCliente: 30 });
        const avisos = avisosPrecarga({ varias_cuotas: true, traslado_detectado: null, monto_neto_detectado: null }, v);
        assert.deepEqual(avisos.map((a) => a.codigo), ['varias_cuotas', 'vencimiento_distinto_plazo']);
        assert.match(avisos[1].mensaje, /28-08-2026/);
        assert.match(avisos[1].mensaje, /13-08-2026/);
    });
    test('sin fecha en el PDF: se avisa que salio del plazo', () => {
        const v = vencimientoPropuesto({ emision: '2026-07-14', plazoCliente: 30 });
        assert.deepEqual(codigos({}, v), ['vencimiento_desde_plazo']);
    });
    test('traslado: dividido, sin detalle, varias lineas y mayor que el neto', () => {
        assert.deepEqual(codigos({ traslado_detectado: { total: 10, concepto: 'entrega_y_retiro' } }, {}), ['traslado_dividido']);
        assert.deepEqual(codigos({ traslado_detectado: { total: 10, concepto: 'sin_detalle' } }, {}), ['traslado_sin_detalle']);
        assert.deepEqual(codigos({ traslado_detectado: { total: 10, concepto: 'varias_lineas' } }, {}), ['traslado_varias_lineas']);
        assert.deepEqual(codigos({ traslado_detectado: { total: 10, concepto: 'entrega' } }, {}), []);
        assert.deepEqual(codigos({ traslado_detectado: { total: 500, concepto: 'entrega' }, monto_neto_detectado: 100 }, {}), ['traslado_mayor_que_neto']);
    });
});

test('los predicados de las tarjetas son los mismos de la lista', () => {
    assert.equal(FILTROS_ESTADO.vencidas, SQL_FACTURAS_VENCIDAS);
    assert.equal(FILTROS_ESTADO.proximas, SQL_FACTURAS_PROXIMAS);
    assert.match(SQL_FACTURAS_VENCIDAS, /America\/Santiago/);
    for (const p of [SQL_FACTURAS_VENCIDAS, SQL_FACTURAS_PROXIMAS]) {
        assert.match(p, /f\.anulada_nc IS NULL/);
        assert.match(p, /f\.fecha_pago IS NULL/);
    }
});
