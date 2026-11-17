// Comprueba los archivos de datos del repo (db/datos): lo que se carga en la base no debe tener errores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validarArchivo, EJECUTIVOS_A_CREAR } = require('../src/utils/cargaClientes');

const leer = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../db/datos', f), 'utf8'));

const NUEVOS = ['PL-1131', 'PL-1232', 'PL-1833', 'GH-1526', 'GH-1528', 'GH-1539', 'GH-1540', 'GH-1541', 'GH-1642'];
const PREFIJOS = { alzahombre: ['PL', 'BR'], grua_horquilla: ['GH'], transpaleta: ['TP'], apilador: ['AP'] };

test('equipos: 96, codigos unicos y con el prefijo de su tipo, y el codigo termina en el interno', () => {
    const { equipos } = leer('equipos_gomaq.json');
    assert.equal(equipos.length, 96);
    const codigos = equipos.map((e) => e.codigo);
    assert.equal(new Set(codigos).size, codigos.length);
    for (const e of equipos) {
        const [prefijo, interno] = e.codigo.split('-');
        assert.ok((PREFIJOS[e.categoria_equipo] || []).includes(prefijo), `${e.codigo}: prefijo ${prefijo} para ${e.categoria_equipo}`);
        assert.equal(Number(interno), e.interno, e.codigo);
    }
});

test('equipos: estan los 9 nuevos y el 907 sigue', () => {
    const codigos = new Set(leer('equipos_gomaq.json').equipos.map((e) => e.codigo));
    for (const c of NUEVOS) assert.ok(codigos.has(c), c);
    assert.ok(codigos.has('GH-907'));
});

test('equipos nuevos: grua con serie y anio, plataforma sin ellos', () => {
    const porCodigo = new Map(leer('equipos_gomaq.json').equipos.map((e) => [e.codigo, e]));
    assert.equal(porCodigo.get('PL-1232').marca, 'JLG');
    assert.equal(porCodigo.get('PL-1131').marca, 'Genie');
    assert.equal(porCodigo.get('GH-1528').capacidad_carga, 1800);
    for (const c of ['GH-1526', 'GH-1539', 'GH-1540', 'GH-1541', 'GH-1642']) {
        assert.ok(porCodigo.get(c).numero_serie, c);
        assert.ok(porCodigo.get(c).anio >= 2015, c);
    }
});

test('clientes: RUT validos y unicos, sin correo, telefono ni contacto', () => {
    const { clientes } = leer('clientes_gomaq.json');
    assert.ok(clientes.length > 100);
    assert.deepEqual(validarArchivo(clientes).errores, []);
    for (const c of clientes) {
        for (const campo of ['email', 'correo', 'telefono', 'contacto']) assert.equal(campo in c, false, `${c.rut} trae ${campo}`);
        assert.ok(c.ejecutivo === null || EJECUTIVOS_A_CREAR.includes(c.ejecutivo));
    }
});

test('clientes: el plazo, cuando viene, es un numero de dias valido', () => {
    const { clientes } = leer('clientes_gomaq.json');
    const conPlazo = clientes.filter((c) => c.plazo_pago_dias !== null);
    assert.ok(conPlazo.length > 0 && conPlazo.length < clientes.length);
    for (const c of conPlazo) assert.ok(Number.isInteger(c.plazo_pago_dias) && c.plazo_pago_dias >= 0 && c.plazo_pago_dias <= 365);
});
