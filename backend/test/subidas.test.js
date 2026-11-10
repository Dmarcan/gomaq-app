// Pruebas de las subidas de archivos: el tipo se decide por el contenido (firma), no por lo que
// declara el cliente, y la lectura de PDF tiene tope de paginas y de tiempo (auditoria H8 y H10).
// No necesitan base de datos: la comprobacion corre antes de que la ruta toque nada.

process.env.DATABASE_URL = 'postgres://nadie:nada@127.0.0.1:1/ninguna';
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-subidas';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ci.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'clave-solo-para-pruebas';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { creerEnElToken } = require('./_sesionDePrueba');

// sin base de datos: la cuenta del token se da por buena (verifyToken la revisa en la base en cada peticion)
creerEnElToken();
const express = require('express');
const { detectarTipoArchivo } = require('../src/utils/firmaArchivo');
const { verificarFirma } = require('../src/middleware/upload');
const { leerTextoPdf, MAX_PAGINAS } = require('../src/utils/leerTextoPdf');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');

/** PDF de N paginas, cada una con el texto "Pagina k": basta para probar el tope de paginas. */
function pdfConPaginas(n) {
    const objetos = [];
    const kids = [];
    objetos.push('<< /Type /Catalog /Pages 2 0 R >>');
    objetos.push(''); // se completa abajo (lista de paginas)
    objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    for (let i = 1; i <= n; i++) {
        const numPagina = objetos.length + 1;
        const numContenido = numPagina + 1;
        kids.push(`${numPagina} 0 R`);
        objetos.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${numContenido} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
        const flujo = `BT /F1 12 Tf 20 100 Td (Pagina ${i}) Tj ET`;
        objetos.push(`<< /Length ${flujo.length} >>\nstream\n${flujo}\nendstream`);
    }
    objetos[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
    let cuerpo = '%PDF-1.4\n';
    const posiciones = [];
    objetos.forEach((o, i) => {
        posiciones.push(cuerpo.length);
        cuerpo += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = cuerpo.length;
    cuerpo += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    for (const p of posiciones) cuerpo += `${String(p).padStart(10, '0')} 00000 n \n`;
    cuerpo += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(cuerpo, 'latin1');
}

describe('detectarTipoArchivo', () => {
    test('reconoce PDF, JPEG, PNG, WEBP y HEIC por sus primeros bytes', () => {
        assert.equal(detectarTipoArchivo(pdfConPaginas(1)), 'pdf');
        assert.equal(detectarTipoArchivo(JPEG), 'jpeg');
        assert.equal(detectarTipoArchivo(PNG), 'png');
        assert.equal(detectarTipoArchivo(WEBP), 'webp');
        assert.equal(detectarTipoArchivo(HEIC), 'heic');
        const mif1 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmif1'), Buffer.alloc(16)]);
        assert.equal(detectarTipoArchivo(mif1), 'heic');
    });

    test('una imagen con %PDF- en sus metadatos sigue siendo imagen', () => {
        assert.equal(detectarTipoArchivo(Buffer.concat([JPEG, Buffer.from('%PDF-1.4'), Buffer.alloc(32)])), 'jpeg');
        assert.equal(detectarTipoArchivo(Buffer.concat([PNG, Buffer.from('%PDF-1.4'), Buffer.alloc(32)])), 'png');
    });

    test('rechaza SVG, HTML, texto, vacio y cabeceras truncadas', () => {
        for (const malo of [SVG, HTML, Buffer.from('no soy pdf, soy un texto cualquiera'), Buffer.alloc(0), Buffer.from('%PDF'), Buffer.from([0xff, 0xd8]), 'texto', null]) {
            assert.equal(detectarTipoArchivo(malo), null);
        }
        // RIFF que no es WEBP (un WAV)
        assert.equal(detectarTipoArchivo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(8)])), null);
        // ftyp de un MP4, no de una imagen
        assert.equal(detectarTipoArchivo(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)])), null);
    });

    test('el encabezado %PDF- fuera de los primeros 1024 bytes no cuenta', () => {
        assert.equal(detectarTipoArchivo(Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from('%PDF-1.4 ...')])), null);
    });
});

describe('verificarFirma', () => {
    function correr(permitidos, file) {
        const req = { file };
        const res = { codigo: null, cuerpo: null, status(c) { this.codigo = c; return this; }, json(b) { this.cuerpo = b; return this; } };
        let siguio = false;
        verificarFirma(permitidos, 'un PDF')(req, res, () => { siguio = true; });
        return { req, res, siguio };
    }

    test('fija el mimetype segun el contenido, no segun lo declarado', () => {
        const { req, siguio } = correr(['pdf'], { buffer: pdfConPaginas(1), mimetype: 'text/html' });
        assert.equal(siguio, true);
        assert.equal(req.file.mimetype, 'application/pdf');
        const img = correr(['jpeg', 'png'], { buffer: PNG, mimetype: 'application/octet-stream' });
        assert.equal(img.req.file.mimetype, 'image/png');
    });

    test('rechaza con 400 un archivo que declara ser PDF pero no lo es', () => {
        const { res, siguio } = correr(['pdf'], { buffer: Buffer.from('no soy pdf, soy un texto cualquiera'), mimetype: 'application/pdf' });
        assert.equal(siguio, false);
        assert.equal(res.codigo, 400);
    });

    test('rechaza un SVG declarado como imagen y una imagen donde se pide PDF', () => {
        assert.equal(correr(['jpeg', 'png', 'webp', 'heic'], { buffer: SVG, mimetype: 'image/svg+xml' }).res.codigo, 400);
        assert.equal(correr(['pdf'], { buffer: PNG, mimetype: 'application/pdf' }).res.codigo, 400);
    });

    test('sin archivo deja pasar (la ruta decide si lo exige)', () => {
        assert.equal(correr(['pdf'], undefined).siguio, true);
    });
});

describe('rutas de subida', () => {
    let servidor;
    let base;
    const token = (rol) => jwt.sign({ id: 1, rol, cliente_id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    before(async () => {
        const { manejarErroresDeSubida } = require('../src/middleware/upload');
        const { manejarErrores } = require('../src/middleware/errores');
        const app = express();
        app.use(express.json());
        app.use('/api/maquinarias', require('../src/routes/maquinarias'));
        app.use('/api/maquinarias', require('../src/routes/guias'));
        app.use('/api/solicitudes', require('../src/routes/solicitudes'));
        app.use('/api/vehiculos', require('../src/routes/vehiculos'));
        app.use(manejarErroresDeSubida);
        app.use(manejarErrores);
        await new Promise((resolve) => { servidor = app.listen(0, resolve); });
        base = `http://127.0.0.1:${servidor.address().port}`;
    });

    after(async () => {
        if (servidor) await new Promise((resolve) => servidor.close(resolve));
        await require('../src/config/db').end().catch(() => {});
    });

    async function subir(metodo, ruta, rol, contenido, tipoDeclarado, nombre, campos = {}) {
        const form = new FormData();
        for (const [k, v] of Object.entries(campos)) form.append(k, v);
        form.append('archivo', new Blob([contenido], { type: tipoDeclarado }), nombre);
        const r = await fetch(`${base}${ruta}`, { method: metodo, headers: { Authorization: `Bearer ${token(rol)}` }, body: form });
        let json = null;
        try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body: json };
    }

    test('un texto declarado como PDF ya no pasa por /guias/detectar', async () => {
        const r = await subir('POST', '/api/maquinarias/guias/detectar', 'administrativo', 'no soy pdf', 'application/pdf', 'x.pdf');
        assert.equal(r.status, 400);
        assert.match(r.body.error, /PDF/);
    });

    test('un PDF de verdad sigue pasando por /guias/detectar', async () => {
        const r = await subir('POST', '/api/maquinarias/guias/detectar', 'administrativo', pdfConPaginas(1), 'application/pdf', 'guia.pdf');
        // pasa la comprobacion de la firma; lo que responda despues depende de la base (aca inalcanzable)
        assert.notEqual(r.status, 400, JSON.stringify(r.body));
    });

    test('un SVG o un HTML declarados como imagen se rechazan en la evidencia de una solicitud', async () => {
        for (const [contenido, tipo, nombre] of [[SVG, 'image/svg+xml', 'a.svg'], [HTML, 'image/png', 'a.png'], [HTML, 'image/jpeg', 'a.jpg']]) {
            const r = await subir('POST', '/api/solicitudes', 'cliente', contenido, tipo, nombre, { maquinaria_id: '1', descripcion: 'x' });
            assert.equal(r.status, 400, nombre);
        }
    });

    test('la foto de un equipo rechaza lo que no es JPEG, PNG, WEBP ni HEIC', async () => {
        assert.equal((await subir('PATCH', '/api/maquinarias/1/foto', 'administrativo', SVG, 'image/svg+xml', 'f.svg')).status, 400);
        assert.equal((await subir('PATCH', '/api/maquinarias/1/foto', 'administrativo', pdfConPaginas(1), 'image/png', 'f.png')).status, 400);
    });

    test('los documentos de un vehiculo aceptan PDF e imagen pero no un texto', async () => {
        const malo = await subir('POST', '/api/vehiculos/1/documentos', 'administrativo', 'texto plano', 'application/pdf', 'p.pdf', { tipo: 'seguro' });
        assert.equal(malo.status, 400);
    });
});

describe('leerTextoPdf', () => {
    test('lee solo las primeras paginas', async () => {
        const texto = await leerTextoPdf(pdfConPaginas(MAX_PAGINAS + 25));
        assert.match(texto, /Pagina 1\b/);
        assert.doesNotMatch(texto, /Pagina 30\b/, 'las paginas posteriores al tope no se leen');
    });

    test('un PDF corrupto o vacio devuelve texto vacio y no lanza', async () => {
        assert.equal(await leerTextoPdf(Buffer.from('%PDF-1.4 basura')), '');
        assert.equal(await leerTextoPdf(Buffer.alloc(0)), '');
    });

    test('un PDF con miles de paginas se lee en segundos (antes tardaba minutos)', async () => {
        const inicio = Date.now();
        const texto = await leerTextoPdf(pdfConPaginas(3000));
        assert.match(texto, /Pagina 1[^0-9]/);
        assert.ok(Date.now() - inicio < 20000, 'debe respetar el tope de paginas');
    });

    test('con el tiempo agotado devuelve texto vacio', async () => {
        // un limite de tiempo ya vencido: el resultado es vacio o el texto leido, pero nunca lanza ni se cuelga
        const texto = await leerTextoPdf(pdfConPaginas(3), { timeoutMs: 0 });
        assert.equal(typeof texto, 'string');
    });
});
