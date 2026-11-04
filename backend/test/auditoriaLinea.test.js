const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    MOTIVOS_CAMBIO, ETIQUETAS_MOTIVO, validarMotivo, evaluarCompuertas, difLinea,
    cambiaLoFacturable, debeAnularValorizacion, mensajeOrdenFacturada, validarPrecioUnitario, detalleFacturaAnulada, esIdPositivo,
} = require('../src/utils/auditoriaLinea');

describe('lista de motivos', () => {
    test('son los cinco acordados y todos tienen etiqueta en español', () => {
        assert.deepEqual(MOTIVOS_CAMBIO, ['cliente_antiguo', 'garantia', 'error_registro', 'cortesia_comercial', 'otro']);
        for (const m of MOTIVOS_CAMBIO) assert.ok(ETIQUETAS_MOTIVO[m]);
    });
});

describe('validarMotivo', () => {
    const texto = 'El cliente pidió no cobrarlo';

    test('orden cerrada: codigo valido y texto suficiente', () => {
        const r = validarMotivo({ ordenCerrada: true, motivoCodigo: 'garantia', motivo: `  ${texto}  ` });
        assert.deepEqual(r, { valido: true, motivoCodigo: 'garantia', motivo: texto });
    });

    test('orden cerrada sin nada: falla', () => {
        const r = validarMotivo({ ordenCerrada: true });
        assert.equal(r.valido, false);
        assert.match(r.error, /motivo/);
    });

    test('orden cerrada sin codigo: falla', () => {
        assert.equal(validarMotivo({ ordenCerrada: true, motivo: texto }).valido, false);
    });

    test('orden cerrada con codigo pero sin texto: falla, tambien con "otro"', () => {
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'garantia' }).valido, false);
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro' }).valido, false);
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro', motivo: '' }).valido, false);
    });

    test('el texto cuenta sin espacios: 9 caracteres no alcanzan, 10 si', () => {
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro', motivo: 'abcdefghi' }).valido, false);
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro', motivo: 'abcdefghij' }).valido, true);
        // 9 letras separadas por muchos espacios: sigue siendo corto
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro', motivo: 'a b c d e f g h i' }).valido, false);
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro', motivo: '          ' }).valido, false);
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro', motivo: 'a b c d e f g h i j' }).valido, true);
    });

    test('codigo fuera de la lista: falla con la orden cerrada y con la abierta', () => {
        for (const ordenCerrada of [true, false]) {
            const r = validarMotivo({ ordenCerrada, motivoCodigo: 'porque_si', motivo: texto });
            assert.equal(r.valido, false);
            assert.match(r.error, /motivo_codigo/);
        }
        assert.equal(validarMotivo({ ordenCerrada: false, motivoCodigo: 5, motivo: texto }).valido, false);
    });

    test('texto que no es texto: falla', () => {
        assert.equal(validarMotivo({ ordenCerrada: true, motivoCodigo: 'otro', motivo: 12345678901 }).valido, false);
    });

    test('texto demasiado largo: falla', () => {
        assert.equal(validarMotivo({ ordenCerrada: false, motivo: 'x'.repeat(501) }).valido, false);
        assert.equal(validarMotivo({ ordenCerrada: false, motivo: 'x'.repeat(500) }).valido, true);
    });

    test('orden abierta: el motivo es opcional', () => {
        assert.deepEqual(validarMotivo({ ordenCerrada: false }), { valido: true, motivoCodigo: null, motivo: null });
        assert.deepEqual(
            validarMotivo({ ordenCerrada: false, motivoCodigo: '', motivo: '   ' }),
            { valido: true, motivoCodigo: null, motivo: null }
        );
    });

    test('orden abierta: si viene, se guarda limpio y sin largo minimo', () => {
        assert.deepEqual(
            validarMotivo({ ordenCerrada: false, motivoCodigo: 'error_registro', motivo: ' corto ' }),
            { valido: true, motivoCodigo: 'error_registro', motivo: 'corto' }
        );
    });
});

describe('evaluarCompuertas', () => {
    const base = { motivoCodigo: 'garantia', motivo: 'Cambio por garantía del fabricante' };

    test('con factura bloquea con 409 y el mensaje de la nota de credito', () => {
        const r = evaluarCompuertas({ estado: 'finalizada', facturaFolio: '1234', ...base });
        assert.equal(r.ok, false);
        assert.equal(r.status, 409);
        assert.equal(r.error, mensajeOrdenFacturada('1234'));
        assert.match(r.error, /nota de crédito/);
        assert.match(r.error, /folio 1234/);
    });

    test('con factura bloquea aunque la orden este abierta o falte el motivo', () => {
        assert.equal(evaluarCompuertas({ estado: 'en_terreno', facturaFolio: 'A-1' }).status, 409);
        assert.equal(evaluarCompuertas({ estado: 'finalizada', facturaFolio: 'A-1' }).status, 409);
    });

    test('orden cerrada sin motivo valido: 400', () => {
        const r = evaluarCompuertas({ estado: 'finalizada' });
        assert.equal(r.ok, false);
        assert.equal(r.status, 400);
    });

    test('orden cerrada con motivo valido: pasa y marca orden_cerrada', () => {
        const r = evaluarCompuertas({ estado: 'finalizada', ...base });
        assert.deepEqual(r, { ok: true, ordenCerrada: true, motivoCodigo: 'garantia', motivo: base.motivo });
    });

    test('orden abierta sin motivo: pasa; el estado pendiente de cierre no cuenta como cerrada', () => {
        for (const estado of ['pendiente', 'asignada', 'aceptada', 'en_camino', 'en_terreno', 'en_reparacion']) {
            const r = evaluarCompuertas({ estado });
            assert.equal(r.ok, true, estado);
            assert.equal(r.ordenCerrada, false);
        }
    });
});

describe('difLinea', () => {
    const linea = { facturable: 'pendiente', cantidad: '2.00', precio_unitario: '15000.00', descripcion: 'Filtro' };

    test('sin cambios: objeto vacio (no se escribe nada)', () => {
        assert.deepEqual(difLinea(linea, {}), {});
        assert.deepEqual(difLinea(linea, { facturable: 'pendiente', precio_unitario: 15000, descripcion: 'Filtro' }), {});
    });

    test('compara la cantidad y el precio como numeros, no como texto', () => {
        assert.deepEqual(difLinea(linea, { cantidad: 2, precio_unitario: '15000' }), {});
        assert.deepEqual(difLinea(linea, { cantidad: '2.0' }), {});
    });

    test('devuelve solo los campos que cambian, con antes y despues', () => {
        const d = difLinea(linea, { facturable: 'si', precio_unitario: 15000, descripcion: 'Filtro' });
        assert.deepEqual(d, { facturable: { antes: 'pendiente', despues: 'si' } });
        const e = difLinea(linea, { facturable: 'no', precio_unitario: 18000 });
        assert.deepEqual(e, {
            facturable: { antes: 'pendiente', despues: 'no' },
            precio_unitario: { antes: 15000, despues: 18000 },
        });
    });

    test('linea sin precio: poner precio es un cambio, de null a numero', () => {
        const d = difLinea({ ...linea, precio_unitario: null }, { precio_unitario: '9900' });
        assert.deepEqual(d, { precio_unitario: { antes: null, despues: 9900 } });
    });

    test('precio vacio, nulo o ausente significa no tocar (el UPDATE usa COALESCE)', () => {
        assert.deepEqual(difLinea(linea, { precio_unitario: '' }), {});
        assert.deepEqual(difLinea(linea, { precio_unitario: null }), {});
        assert.deepEqual(difLinea(linea, { descripcion: null }), {});
    });

    test('la cantidad cambia y se informa', () => {
        assert.deepEqual(difLinea(linea, { cantidad: 3 }), { cantidad: { antes: 2, despues: 3 } });
    });

    test('un precio con decimales o un valor que no es numero cuenta como cambio', () => {
        assert.deepEqual(difLinea(linea, { precio_unitario: 15000.5 }), { precio_unitario: { antes: 15000, despues: 15000.5 } });
        assert.ok(difLinea(linea, { precio_unitario: 'abc' }).precio_unitario);
    });

    test('la descripcion: cambiar el texto es un cambio, dejarla igual no', () => {
        assert.deepEqual(difLinea(linea, { descripcion: 'Filtro de aceite' }), { descripcion: { antes: 'Filtro', despues: 'Filtro de aceite' } });
        assert.deepEqual(difLinea({ ...linea, descripcion: null }, { descripcion: 'Nuevo' }), { descripcion: { antes: null, despues: 'Nuevo' } });
    });

    test('sin linea anterior o sin pedido no revienta', () => {
        assert.deepEqual(difLinea(null, null), {});
        assert.deepEqual(difLinea(undefined, { facturable: 'si' }), { facturable: { antes: null, despues: 'si' } });
    });
});

describe('cambiaLoFacturable y debeAnularValorizacion', () => {
    const si = (id, cantidad = 1, precio = 1000) => ({ id, facturable: 'si', cantidad, precio_unitario: precio });
    const no = (id) => ({ id, facturable: 'no', cantidad: 1, precio_unitario: 500 });
    const pend = (id) => ({ id, facturable: 'pendiente', cantidad: 1, precio_unitario: null });

    test('sin cambios no altera nada', () => {
        assert.equal(cambiaLoFacturable([si(1), no(2)], [si(1), no(2)]), false);
        assert.equal(cambiaLoFacturable([], []), false);
    });

    test('agregar una linea facturable altera', () => {
        assert.equal(cambiaLoFacturable([si(1)], [si(1), si(2)]), true);
    });

    test('agregar una linea no facturable o pendiente no altera', () => {
        assert.equal(cambiaLoFacturable([si(1)], [si(1), no(2)]), false);
        assert.equal(cambiaLoFacturable([si(1)], [si(1), pend(2)]), false);
    });

    test('una linea que pasa a o deja de ser facturable altera', () => {
        assert.equal(cambiaLoFacturable([si(1), pend(2)], [si(1), si(2, 1, 700)]), true);
        assert.equal(cambiaLoFacturable([si(1), si(2)], [si(1), no(2)]), true);
        assert.equal(cambiaLoFacturable([si(1), si(2)], [si(1), pend(2)]), true);
    });

    test('pasar de pendiente a no (o al reves) no altera', () => {
        assert.equal(cambiaLoFacturable([si(1), pend(2)], [si(1), no(2)]), false);
        assert.equal(cambiaLoFacturable([si(1), no(2)], [si(1), pend(2)]), false);
    });

    test('anular una linea facturable altera (sale de las lineas vigentes)', () => {
        assert.equal(cambiaLoFacturable([si(1), si(2)], [si(1)]), true);
        assert.equal(cambiaLoFacturable([si(1), si(2)], [si(1), { ...si(2), anulada_at: '2026-11-04' }]), true);
    });

    test('anular una linea no facturable no altera', () => {
        assert.equal(cambiaLoFacturable([si(1), no(2)], [si(1)]), false);
    });

    test('cambiar cantidad o precio de una facturable altera, de una no facturable no', () => {
        assert.equal(cambiaLoFacturable([si(1, 1, 1000)], [si(1, 2, 1000)]), true);
        assert.equal(cambiaLoFacturable([si(1, 1, 1000)], [si(1, 1, 1200)]), true);
        assert.equal(cambiaLoFacturable([si(1), no(2)], [si(1), { ...no(2), cantidad: 9, precio_unitario: 1 }]), false);
    });

    test('cantidad o precio en texto de Postgres se comparan como numeros', () => {
        assert.equal(cambiaLoFacturable([si(1, '2.00', '1000.00')], [si(1, 2, 1000)]), false);
    });

    test('una facturable sin precio: cambiar la cantidad igual altera aunque el total siga en 0', () => {
        assert.equal(cambiaLoFacturable([si(1, 1, null)], [si(1, 3, null)]), true);
    });

    test('dos lineas que se compensan en el total igual alteran el conjunto', () => {
        assert.equal(cambiaLoFacturable([si(1, 1, 1000), si(2, 1, 1000)], [si(1, 2, 1000), si(2, 1, 0)]), true);
        assert.equal(cambiaLoFacturable([si(1)], [si(2)]), true);
    });

    test('valorizacion: solo se anula si estaba valorizada y el cambio altera lo facturable', () => {
        assert.equal(debeAnularValorizacion({ valorizacion: null, antes: [si(1)], despues: [] }), false);
        assert.equal(debeAnularValorizacion({ valorizacion: undefined, antes: [si(1)], despues: [] }), false);
        assert.equal(debeAnularValorizacion({ valorizacion: '250000.00', antes: [si(1)], despues: [] }), true);
        assert.equal(debeAnularValorizacion({ valorizacion: 0, antes: [si(1)], despues: [si(1), si(2)] }), true);
        assert.equal(debeAnularValorizacion({ valorizacion: 250000, antes: [si(1)], despues: [si(1), no(2)] }), false);
    });

    test('entradas que no son listas no revientan', () => {
        assert.equal(cambiaLoFacturable(null, undefined), false);
    });
});

describe('validarPrecioUnitario', () => {
    test('vacio o ausente es valido; enteros desde 0 tambien', () => {
        for (const v of [undefined, null, '', 0, 1500, '1500', '0']) assert.equal(validarPrecioUnitario(v), null, String(v));
    });
    test('decimales, negativos y no numericos se rechazan', () => {
        for (const v of [1500.5, '1500.5', -1, '-5', 'abc', '  ', NaN, Infinity, true, {}, []]) {
            assert.match(validarPrecioUnitario(v), /entero en pesos/, String(v));
        }
    });
});

describe('detalleFacturaAnulada', () => {
    test('guarda lo que se borra y el motivo, con el monto como numero', () => {
        const d = require('../src/utils/auditoriaLinea').detalleFacturaAnulada(
            { id: 4, folio: 'F-1001', monto: '119000.00', fecha_emision: new Date('2026-11-01T23:00:00Z'), fecha_emision_texto: '2026-11-02', archivo_url: 'facturas/4/a.pdf' },
            { motivoCodigo: 'error_registro', motivo: 'Se subio la factura equivocada' }
        );
        assert.deepEqual(d, {
            factura_id: 4, folio: 'F-1001', monto: 119000, fecha_emision: '2026-11-02',
            archivo_url: 'facturas/4/a.pdf', motivo_codigo: 'error_registro', motivo: 'Se subio la factura equivocada',
        });
    });
    test('sin monto ni fecha queda en null', () => {
        const d = require('../src/utils/auditoriaLinea').detalleFacturaAnulada(
            { id: 1, folio: 'X', monto: null, fecha_emision: null, fecha_emision_texto: null, archivo_url: 'a' }, { motivoCodigo: 'otro', motivo: 'Una explicacion larga' });
        assert.equal(d.monto, null);
        assert.equal(d.fecha_emision, null);
    });
});

describe('esIdPositivo', () => {
    test('acepta enteros positivos hasta el maximo de un INTEGER', () => {
        for (const v of ['1', '42', '2147483647']) assert.equal(esIdPositivo(v), true, v);
    });
    test('rechaza lo demas', () => {
        for (const v of ['0', '-1', '01', '1.5', '1e3', 'abc', '', ' 1', '2147483648', '99999999999', undefined, null, 5]) {
            assert.equal(esIdPositivo(v), false, String(v));
        }
    });
});
