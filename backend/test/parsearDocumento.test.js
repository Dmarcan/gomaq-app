const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    parsearFechaEmision,
    parsearHora,
    detectarTipoGuia,
    parsearFolio,
    parsearRutReceptor,
    parsearMonto,
    parsearHorometro,
    normalizarRut,
    parsearGuia,
    parsearFactura,
} = require('../src/utils/parsearDocumento');
const { elegirCliente } = require('../src/utils/detectarCliente');

// Texto real extraido con pdf-parse de documentos de GOMAQ (clientes y choferes anonimizados).
const fixture = (nombre) => fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8');
const GUIA_DESPACHO = fixture('guia_despacho.txt');
const GUIA_RETIRO = fixture('guia_retiro.txt');
const FACTURA = fixture('factura.txt');

describe('parsearFechaEmision', () => {
    test('lee la fecha con mes en palabras de una guia de entrega', () => {
        assert.strictEqual(parsearFechaEmision(GUIA_DESPACHO), '2026-05-15');
    });

    test('lee la fecha con mes en palabras de una guia de retiro', () => {
        assert.strictEqual(parsearFechaEmision(GUIA_RETIRO), '2026-07-22');
    });

    test('lee la fecha de la factura', () => {
        assert.strictEqual(parsearFechaEmision(FACTURA), '2026-07-14');
    });

    test('acepta el formato numerico como respaldo', () => {
        assert.strictEqual(parsearFechaEmision('Fecha Emision: 15/05/2026'), '2026-05-15');
    });

    test('ignora fechas que no son la de emision', () => {
        // todo DTE lleva impresa la resolucion del SII; no debe ganarle a la fecha real
        const texto = 'Res. Ex. 80 de 22/08/2014 SII\nFecha Emision: 15 de Mayo del 2026';
        assert.strictEqual(parsearFechaEmision(texto), '2026-05-15');
    });

    test('devuelve null si no hay fecha de emision', () => {
        assert.strictEqual(parsearFechaEmision('documento sin fecha'), null);
    });
});

describe('parsearHora', () => {
    test('los documentos reales de GOMAQ no traen hora', () => {
        assert.strictEqual(parsearHora(GUIA_DESPACHO), null);
        assert.strictEqual(parsearHora(GUIA_RETIRO), null);
    });

    test('lee una hora valida', () => {
        assert.strictEqual(parsearHora('Hora de salida: 10:30'), '10:30');
    });

    test('rechaza horas fuera de rango', () => {
        assert.strictEqual(parsearHora('Referencia interna: 99:99'), null);
        assert.strictEqual(parsearHora('codigo 12:75'), null);
    });
});

describe('detectarTipoGuia', () => {
    test('la guia de entrega es un despacho', () => {
        assert.strictEqual(detectarTipoGuia(GUIA_DESPACHO), 'despacho');
    });

    test('la guia de retiro es una recepcion', () => {
        // el documento real nunca dice "devolucion" ni "recepcion": dice RETIRO DE EQUIPO
        assert.strictEqual(detectarTipoGuia(GUIA_RETIRO), 'recepcion');
    });

    test('reconoce Devolucion en el campo Tipo Traslado', () => {
        const texto = 'GUIA DE DESPACHO ELECTRONICA\nTipo\nTraslado: Devolucion';
        assert.strictEqual(detectarTipoGuia(texto), 'recepcion');
    });

    test('no confunde la palabra devolucion de las condiciones comerciales', () => {
        const texto = 'GUIA DE DESPACHO ELECTRONICA\nTipo Traslado: Otros Traslados No Venta\n'
            + 'CONDICIONES: en caso de devolucion anticipada avisar con 24 horas.';
        assert.strictEqual(detectarTipoGuia(texto), 'despacho');
    });
});

describe('parsearFolio', () => {
    test('lee el folio de la factura', () => {
        assert.strictEqual(parsearFolio(FACTURA), '1512');
    });

    test('lee el folio de las guias', () => {
        assert.strictEqual(parsearFolio(GUIA_DESPACHO), '458');
        assert.strictEqual(parsearFolio(GUIA_RETIRO), '511');
    });

    test('no confunde otros numeros del documento', () => {
        // la factura trae "Orden Compra N 10104" y "N INTERNO: 0506"
        assert.notStrictEqual(parsearFolio(FACTURA), '10104');
        assert.notStrictEqual(parsearFolio(FACTURA), '0506');
    });
});

describe('normalizarRut', () => {
    test('quita puntos, espacios y normaliza el digito verificador', () => {
        assert.strictEqual(normalizarRut('12.345.678- 5'), '12345678-5');
        assert.strictEqual(normalizarRut('12345678-k'), '12345678-K');
        assert.strictEqual(normalizarRut('77.089.584- 7'), '77089584-7');
    });

    test('devuelve null con entrada vacia', () => {
        assert.strictEqual(normalizarRut(null), null);
        assert.strictEqual(normalizarRut('   '), null);
    });
});

describe('parsearRutReceptor', () => {
    test('toma el RUT del receptor, no el del emisor', () => {
        // 77.089.584-7 es el RUT de GOMAQ y aparece en el mismo documento
        assert.strictEqual(parsearRutReceptor(GUIA_DESPACHO), '12345678-5');
        assert.strictEqual(parsearRutReceptor(FACTURA), '98765432-1');
    });
});

describe('parsearMonto', () => {
    test('lee el total de la factura real (regresion)', () => {
        assert.strictEqual(parsearMonto(FACTURA), 249900);
    });
});

describe('parsearHorometro', () => {
    test('lee el horometro de la guia de entrega', () => {
        assert.strictEqual(parsearHorometro(GUIA_DESPACHO), 1156);
    });

    test('la guia de retiro y la factura no lo traen', () => {
        assert.strictEqual(parsearHorometro(GUIA_RETIRO), null);
        assert.strictEqual(parsearHorometro(FACTURA), null);
    });

    test('el punto es separador de miles, no decimal', () => {
        assert.strictEqual(parsearHorometro('HOROMETRO: 1.156'), 1156);
    });
});

describe('parsearGuia', () => {
    test('guia de entrega completa', () => {
        assert.deepStrictEqual(parsearGuia(GUIA_DESPACHO), {
            fecha_detectada: '2026-05-15',
            hora_detectada: null,
            tipo_detectado: 'despacho',
            rut_detectado: '12345678-5',
            folio_detectado: '458',
            horometro_detectado: 1156,
        });
    });

    test('guia de retiro completa', () => {
        assert.deepStrictEqual(parsearGuia(GUIA_RETIRO), {
            fecha_detectada: '2026-07-22',
            hora_detectada: null,
            tipo_detectado: 'recepcion',
            rut_detectado: '12345678-5',
            folio_detectado: '511',
            horometro_detectado: null,
        });
    });

    test('una hora invalida no descarta la fecha', () => {
        const texto = 'GUIA DE DESPACHO ELECTRONICA\nFecha Emision: 15 de Mayo del 2026\nRef: 99:99';
        const r = parsearGuia(texto);
        assert.strictEqual(r.fecha_detectada, '2026-05-15');
        assert.strictEqual(r.hora_detectada, null);
    });
});

describe('parsearFactura', () => {
    test('factura real completa', () => {
        assert.deepStrictEqual(parsearFactura(FACTURA), {
            monto_detectado: 249900,
            folio_detectado: '1512',
            rut_detectado: '98765432-1',
        });
    });
});

describe('elegirCliente', () => {
    const CLIENTES = [
        { id: 1, nombre: 'TRANSPORTES LOS ANDES SPA', rut: '12.345.678-5' },
        { id: 2, nombre: 'CONSTRUCTORA DEL VALLE SPA', rut: '98765432-1' },
    ];

    test('empareja por RUT', () => {
        assert.strictEqual(elegirCliente(GUIA_DESPACHO, '12345678-5', CLIENTES).id, 1);
        assert.strictEqual(elegirCliente(FACTURA, '98765432-1', CLIENTES).id, 2);
    });

    test('cae al nombre cuando no hay RUT', () => {
        assert.strictEqual(elegirCliente(GUIA_DESPACHO, null, CLIENTES).id, 1);
    });

    test('es determinista ante nombres que se contienen', () => {
        const texto = 'Cliente: Acsa International Ltda';
        const a = [{ id: 1, nombre: 'Acsa', rut: null }, { id: 2, nombre: 'Acsa International', rut: null }];
        const b = [{ id: 2, nombre: 'Acsa International', rut: null }, { id: 1, nombre: 'Acsa', rut: null }];
        // gana el nombre mas largo sin importar el orden que devuelva Postgres
        assert.strictEqual(elegirCliente(texto, null, a).id, 2);
        assert.strictEqual(elegirCliente(texto, null, b).id, 2);
    });

    test('no elige al emisor cuando GOMAQ tambien es cliente', () => {
        const clientes = [
            { id: 9, nombre: 'ARRIENDO DE MAQUINARIAS GOMAQ SPA', rut: '77.089.584-7' },
            ...CLIENTES,
        ];
        assert.strictEqual(elegirCliente(GUIA_DESPACHO, '12345678-5', clientes).id, 1);
    });

    test('devuelve null si no encuentra ninguno', () => {
        assert.strictEqual(elegirCliente('texto sin clientes conocidos', null, CLIENTES), null);
    });
});
