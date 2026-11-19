const { test, describe } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');

const {
    MAX_FOTOS, validarIdsFotos, leerFotosDeOrden, nombresAdjuntos, reducirFoto, prepararAdjuntosFotos, descargadorDeBucket, formatearMb,
} = require('../src/utils/fotosCorreo');

describe('validarIdsFotos', () => {
    test('ausente o vacia es sin fotos', () => {
        assert.deepEqual(validarIdsFotos(undefined), { ids: [] });
        assert.deepEqual(validarIdsFotos(null), { ids: [] });
        assert.deepEqual(validarIdsFotos([]), { ids: [] });
    });
    test('acepta enteros y textos numericos, sin repetidos y en el orden recibido', () => {
        assert.deepEqual(validarIdsFotos([5, '3', 5, 9]), { ids: [5, 3, 9] });
    });
    test('rechaza lo que no es una lista de ids de fotos', () => {
        for (const malo of ['1,2', {}, [0], [-1], [1.5], ['a'], [null], [2147483648], [true]]) {
            assert.ok(validarIdsFotos(malo).error, `debio rechazar ${JSON.stringify(malo)}`);
        }
    });
    test(`rechaza mas de ${MAX_FOTOS} fotos`, () => {
        const ids = Array.from({ length: MAX_FOTOS + 1 }, (_, i) => i + 1);
        assert.match(validarIdsFotos(ids).error, /hasta 12 fotos/);
        assert.equal(validarIdsFotos(ids.slice(0, MAX_FOTOS)).ids.length, MAX_FOTOS);
    });
});

describe('leerFotosDeOrden', () => {
    test('sin ids no consulta la base', async () => {
        const db = { query: async () => { throw new Error('no debio consultar'); } };
        assert.deepEqual(await leerFotosDeOrden(db, 1, []), { fotos: [] });
    });
    test('pide solo las fotos de esa orden y rechaza si falta alguna', async () => {
        let llamada;
        const db = { query: async (sql, params) => { llamada = { sql, params }; return { rows: [{ id: 1, tipo: 'antes', path: 'a' }] }; } };
        const r = await leerFotosDeOrden(db, 7, [1, 2]);
        assert.match(r.error, /no pertenece a esta orden/);
        assert.match(llamada.sql, /orden_trabajo_id = \$1/);
        assert.deepEqual(llamada.params, [7, [1, 2]]);
        const ok = await leerFotosDeOrden(db, 7, [1]);
        assert.equal(ok.fotos.length, 1);
    });
});

describe('nombresAdjuntos', () => {
    test('numera por tipo en el orden recibido', () => {
        const fotos = [{ tipo: 'antes' }, { tipo: 'antes' }, { tipo: 'despues' }, { tipo: 'despues' }, { tipo: 'despues' }];
        assert.deepEqual(nombresAdjuntos(fotos), ['antes-1.jpg', 'antes-2.jpg', 'despues-1.jpg', 'despues-2.jpg', 'despues-3.jpg']);
    });
    test('un tipo desconocido cuenta como antes', () => {
        assert.deepEqual(nombresAdjuntos([{ tipo: 'otro' }]), ['antes-1.jpg']);
    });
});

describe('prepararAdjuntosFotos', () => {
    const fotos = [
        { id: 1, tipo: 'antes', path: 'p1' },
        { id: 2, tipo: 'antes', path: 'p2' },
        { id: 3, tipo: 'despues', path: 'p3' },
    ];
    // reduce a un tamano que depende del paso, para probar el segundo intento sin imagenes reales
    const reducirFalso = (tamanos) => async (bytes, paso) => Buffer.alloc(tamanos[paso.lado], 1);

    test('arma los adjuntos con nombre y base64, y suma el peso', async () => {
        const r = await prepararAdjuntosFotos({
            fotos, descargar: async () => Buffer.from('x'), reducir: reducirFalso({ 1600: 1000, 1200: 500 }), limite: 10000,
        });
        assert.equal(r.excede, false);
        assert.equal(r.total, 3000);
        assert.deepEqual(r.adjuntos.map((a) => a.filename), ['antes-1.jpg', 'antes-2.jpg', 'despues-1.jpg']);
        assert.equal(Buffer.from(r.adjuntos[0].content, 'base64').length, 1000);
    });

    test('si no cabe a 1600 px prueba el paso de 1200 px', async () => {
        const usados = [];
        const r = await prepararAdjuntosFotos({
            fotos, descargar: async () => Buffer.from('x'),
            reducir: async (b, paso) => { usados.push(paso.lado); return Buffer.alloc(paso.lado === 1600 ? 4000 : 2000); },
            limite: 7000,
        });
        assert.equal(r.excede, false);
        assert.equal(r.total, 6000);
        assert.deepEqual([...new Set(usados)], [1600, 1200]);
    });

    test('si tampoco cabe asi, avisa que excede (y no adjunta de mas)', async () => {
        const r = await prepararAdjuntosFotos({
            fotos, descargar: async () => Buffer.from('x'), reducir: reducirFalso({ 1600: 9000, 1200: 8000 }), limite: 10000,
        });
        assert.equal(r.excede, true);
        assert.equal(r.total, 24000);
    });

    test('una foto que ya no existe se omite, se informa y la numeracion no queda con huecos', async () => {
        const r = await prepararAdjuntosFotos({
            fotos, descargar: async (path) => (path === 'p1' ? null : Buffer.from('x')), reducir: reducirFalso({ 1600: 10, 1200: 10 }),
        });
        assert.deepEqual(r.faltantes, [1]);
        assert.deepEqual(r.adjuntos.map((a) => a.filename), ['antes-1.jpg', 'despues-1.jpg']);
    });

    test('descarga y reduce de a una foto (no las junta todas en memoria)', async () => {
        let enCurso = 0;
        let maximo = 0;
        await prepararAdjuntosFotos({
            fotos,
            descargar: async () => { enCurso += 1; maximo = Math.max(maximo, enCurso); await new Promise((r) => setImmediate(r)); return Buffer.from('x'); },
            reducir: async () => { enCurso -= 1; return Buffer.from('y'); },
        });
        assert.equal(maximo, 1);
    });

    test('un error al descargar se propaga (el worker lo reintenta)', async () => {
        await assert.rejects(
            prepararAdjuntosFotos({ fotos, descargar: async () => { throw new Error('Storage caido'); }, reducir: async () => Buffer.from('y') }),
            /Storage caido/
        );
    });
});

describe('reducirFoto (con sharp de verdad)', () => {
    async function fotoGrande(opciones = {}) {
        let img = sharp({ create: { width: 3200, height: 2400, channels: 3, background: { r: 200, g: 80, b: 20 } } });
        if (opciones.exif) img = img.withExif({ IFD0: { Copyright: 'GOMAQ' } });
        return img.jpeg({ quality: 95 }).toBuffer();
    }

    test('encaja en 1600 px, sale JPEG y pesa menos que el original', async () => {
        const original = await fotoGrande();
        const salida = await reducirFoto(original, { lado: 1600, calidad: 80 });
        const meta = await sharp(salida).metadata();
        assert.equal(meta.format, 'jpeg');
        assert.equal(Math.max(meta.width, meta.height), 1600);
        assert.ok(salida.length < original.length);
    });

    test('no agranda una foto chica', async () => {
        const chica = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } }).jpeg().toBuffer();
        const meta = await sharp(await reducirFoto(chica, { lado: 1600, calidad: 80 })).metadata();
        assert.equal(meta.width, 400);
    });

    test('quita los metadatos EXIF (el cliente nunca recibe coordenadas)', async () => {
        const conExif = await fotoGrande({ exif: true });
        assert.ok((await sharp(conExif).metadata()).exif, 'la prueba necesita una foto con EXIF');
        const salida = await reducirFoto(conExif, { lado: 1600, calidad: 80 });
        assert.equal((await sharp(salida).metadata()).exif, undefined);
    });

    test('aplica la orientacion EXIF antes de perderla', async () => {
        const horizontal = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#cc0000' } })
            .jpeg().withMetadata({ orientation: 6 }).toBuffer();
        const meta = await sharp(await reducirFoto(horizontal, { lado: 1600, calidad: 80 })).metadata();
        assert.equal(meta.width, 400);
        assert.equal(meta.height, 800);
    });

    test('un PNG con transparencia no sale negro', async () => {
        const png = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
        const { data } = await sharp(await reducirFoto(png, { lado: 1600, calidad: 80 })).raw().toBuffer({ resolveWithObject: true });
        assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, 'el fondo transparente debe quedar blanco');
    });

    test('un archivo que no es imagen falla (no se adjunta basura)', async () => {
        await assert.rejects(reducirFoto(Buffer.from('esto no es una imagen'), { lado: 1600, calidad: 80 }));
    });
});

describe('descargadorDeBucket', () => {
    const conRespuesta = (respuesta) => ({ storage: { from: () => ({ download: async () => respuesta }) } });

    test('devuelve los bytes del archivo', async () => {
        const dl = descargadorDeBucket(conRespuesta({ data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null }), 'b');
        assert.deepEqual([...(await dl('x'))], [1, 2, 3]);
    });
    test('un archivo que no existe da null, otro error se propaga', async () => {
        assert.equal(await descargadorDeBucket(conRespuesta({ data: null, error: { message: 'Object not found', statusCode: '404' } }), 'b')('x'), null);
        await assert.rejects(descargadorDeBucket(conRespuesta({ data: null, error: { message: 'timeout' } }), 'b')('x'), /No se pudo leer una foto: timeout/);
    });
});

test('formatearMb', () => {
    assert.equal(formatearMb(10 * 1024 * 1024), '10 MB');
    assert.equal(formatearMb(9.44 * 1024 * 1024), '9,4 MB');
});
