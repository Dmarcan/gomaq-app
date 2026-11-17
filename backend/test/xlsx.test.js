// Pruebas del escritor de .xlsx: estructura del ZIP, XML bien formado, escape y tipos de celda.
// Un lector minimo dentro de la prueba (directorio central e inflateRaw) recupera cada parte.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { crearXlsx, serieExcel, letraColumna, escaparXml, crc32 } = require('../src/utils/xlsx');

/** Lee el ZIP: { nombre -> Buffer }, comprobando el CRC y los tamanos de cada parte. */
function leerZip(buf) {
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'firma de archivo local');
    const fin = buf.length - 22;
    assert.equal(buf.readUInt32LE(fin), 0x06054b50, 'firma del fin del directorio central');
    const total = buf.readUInt16LE(fin + 10);
    let pos = buf.readUInt32LE(fin + 16);
    const partes = {};
    for (let i = 0; i < total; i += 1) {
        assert.equal(buf.readUInt32LE(pos), 0x02014b50, 'firma del directorio central');
        const crc = buf.readUInt32LE(pos + 16);
        const tamComprimido = buf.readUInt32LE(pos + 20);
        const tam = buf.readUInt32LE(pos + 24);
        const largoNombre = buf.readUInt16LE(pos + 28);
        const desplazamiento = buf.readUInt32LE(pos + 42);
        const nombre = buf.toString('utf8', pos + 46, pos + 46 + largoNombre);
        assert.equal(buf.readUInt32LE(desplazamiento), 0x04034b50);
        const nombreLocal = buf.readUInt16LE(desplazamiento + 26);
        const extraLocal = buf.readUInt16LE(desplazamiento + 28);
        const inicio = desplazamiento + 30 + nombreLocal + extraLocal;
        const datos = zlib.inflateRawSync(buf.subarray(inicio, inicio + tamComprimido));
        assert.equal(datos.length, tam, `tamano de ${nombre}`);
        assert.equal(crc32(datos), crc, `crc de ${nombre}`);
        partes[nombre] = datos;
        pos += 46 + largoNombre + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    }
    return partes;
}

/** Comprobacion minima de XML bien formado: etiquetas balanceadas y sin & ni < sueltos en el texto. */
function comprobarXml(xml) {
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/);
    const sinDeclaracion = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
    const pila = [];
    const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
    let consumido = 0;
    let m;
    while ((m = re.exec(sinDeclaracion)) !== null) {
        consumido += m[0].length;
        if (m[5] !== undefined) {
            assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(m[5]), `& sin escapar en: ${m[5]}`);
            continue;
        }
        const [, cierra, nombre, , autocierra] = m;
        if (autocierra) continue;
        if (cierra) assert.equal(pila.pop(), nombre, `cierre de ${nombre}`);
        else pila.push(nombre);
    }
    assert.equal(consumido, sinDeclaracion.length, 'todo el XML se pudo leer como etiquetas y texto');
    assert.deepEqual(pila, [], 'todas las etiquetas cerradas');
}

test('el archivo empieza con la firma ZIP y trae las seis partes minimas', () => {
    const buf = crearXlsx({ hoja: 'CLIENTES', filas: [['a']] });
    assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304');
    const partes = leerZip(buf);
    assert.deepEqual(Object.keys(partes).sort(), [
        '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
    ]);
    for (const [nombre, datos] of Object.entries(partes)) {
        assert.doesNotThrow(() => comprobarXml(datos.toString('utf8')), nombre);
    }
});

test('el mismo contenido da siempre los mismos bytes', () => {
    const a = crearXlsx({ hoja: 'CLIENTES', filas: [['x', 1, { fecha: '2026-01-02' }]] });
    const b = crearXlsx({ hoja: 'CLIENTES', filas: [['x', 1, { fecha: '2026-01-02' }]] });
    assert.ok(a.equals(b));
});

test('tipos de celda: texto en linea, numero, fecha con estilo y vacia sin escribir', () => {
    const buf = crearXlsx({
        hoja: 'CLIENTES',
        filas: [
            [],
            ['Texto', 12345, -250, 0, { fecha: '2026-11-17' }, null, '', undefined, 'fin'],
        ],
    });
    const hoja = leerZip(buf)['xl/worksheets/sheet1.xml'].toString('utf8');
    comprobarXml(hoja);
    assert.ok(!hoja.includes('<row r="1">'), 'una fila vacia no se escribe');
    assert.match(hoja, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">Texto<\/t><\/is><\/c>/);
    assert.match(hoja, /<c r="B2"><v>12345<\/v><\/c>/);
    assert.match(hoja, /<c r="C2"><v>-250<\/v><\/c>/);
    assert.match(hoja, /<c r="D2"><v>0<\/v><\/c>/);
    assert.match(hoja, /<c r="E2" s="1"><v>46343<\/v><\/c>/);
    for (const ref of ['F2', 'G2', 'H2']) assert.ok(!hoja.includes(`r="${ref}"`), `${ref} vacia`);
    assert.match(hoja, /<c r="I2" t="inlineStr">/);
    assert.ok(!hoja.includes('<f>'), 'sin formulas');
});

test('la fecha usa el formato dd-mm-yyyy y la hoja tiene el nombre dado', () => {
    const partes = leerZip(crearXlsx({ hoja: 'CLIENTES', filas: [['a']] }));
    const estilos = partes['xl/styles.xml'].toString('utf8');
    assert.match(estilos, /<numFmt numFmtId="164" formatCode="dd\\-mm\\-yyyy"\/>/);
    assert.match(estilos, /<cellXfs count="2">/);
    assert.match(partes['xl/workbook.xml'].toString('utf8'), /<sheet name="CLIENTES" sheetId="1" r:id="rId1"\/>/);
});

test('escapa & < > comillas y quita caracteres de control', () => {
    assert.equal(escaparXml('A&B <c> "d" \'e\''), 'A&amp;B &lt;c&gt; &quot;d&quot; &apos;e&apos;');
    assert.equal(escaparXml('a\u0000b\u0007c\u001Fd\te\nf'), 'abcd\te\nf');
    const hoja = leerZip(crearXlsx({ hoja: 'H', filas: [['Ñandú & Hijos <ltda> "x"\u0001']] }))['xl/worksheets/sheet1.xml'].toString('utf8');
    comprobarXml(hoja);
    assert.ok(hoja.includes('Ñandú &amp; Hijos &lt;ltda&gt; &quot;x&quot;</t>'));
});

test('los acentos y el signo de grado viajan en UTF-8', () => {
    const hoja = leerZip(crearXlsx({ hoja: 'H', filas: [['Dirección', 'N° Interno']] }))['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.ok(hoja.includes('Dirección'));
    assert.ok(hoja.includes('N° Interno'));
});

test('numeros de serie de Excel', () => {
    assert.equal(serieExcel('1900-01-01'), 2);
    assert.equal(serieExcel('2000-01-01'), 36526);
    assert.equal(serieExcel('2026-11-17'), 46343);
    assert.throws(() => serieExcel('2026-02-30'));
    assert.throws(() => serieExcel('17-11-2026'));
});

test('letras de columna', () => {
    assert.equal(letraColumna(0), 'A');
    assert.equal(letraColumna(24), 'Y');
    assert.equal(letraColumna(25), 'Z');
    assert.equal(letraColumna(26), 'AA');
    assert.equal(letraColumna(701), 'ZZ');
    assert.equal(letraColumna(702), 'AAA');
});

test('rechaza celdas y hojas invalidas', () => {
    assert.throws(() => crearXlsx({ hoja: 'H', filas: [[NaN]] }));
    assert.throws(() => crearXlsx({ hoja: 'H', filas: [[true]] }));
    assert.throws(() => crearXlsx({ hoja: 'H', filas: [[{ otra: 1 }]] }));
    assert.throws(() => crearXlsx({ hoja: 'a/b', filas: [] }));
    assert.throws(() => crearXlsx({ hoja: '', filas: [] }));
    assert.throws(() => crearXlsx({ hoja: 'x'.repeat(32), filas: [] }));
});

test('crc32 conocido', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('una hoja grande se arma y se lee completa', () => {
    const filas = Array.from({ length: 2000 }, (_, i) => [`fila ${i}`, i, { fecha: '2026-03-01' }]);
    const hoja = leerZip(crearXlsx({ hoja: 'CLIENTES', filas }))['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.equal((hoja.match(/<row /g) || []).length, 2000);
    assert.ok(hoja.includes('<c r="A2000" t="inlineStr">'));
});
