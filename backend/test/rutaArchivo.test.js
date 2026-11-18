const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { rutaAdjuntoSolicitud } = require('../src/utils/rutaArchivo');

/**
 * Regresion de una vulnerabilidad critica: guardar el adjunto con `multer.diskStorage` y el nombre que
 * envia el cliente. Multer hace `path.join(destino, nombre)` SIN normalizar, asi que un nombre con `../`
 * escapa del directorio: `1700-../../../../.env` terminaba escribiendo `backend/.env`, es decir el
 * JWT_SECRET y las credenciales de la base.
 *
 * La regla: el nombre del cliente no participa de la ruta; el servidor la arma entera y del original
 * solo rescata la extension, saneada.
 */
describe('rutaAdjuntoSolicitud', () => {
    test('conserva la extension de un nombre normal', () => {
        assert.match(rutaAdjuntoSolicitud(7, 'foto.jpg'), /^solicitudes\/cliente-7\/\d+-[a-z0-9]+\.jpg$/);
    });

    test('neutraliza el path traversal que permitia escribir el .env', () => {
        const ruta = rutaAdjuntoSolicitud(7, '../../../../.env');
        assert.ok(!ruta.includes('..'), 'la ruta no debe contener ..');
        assert.ok(ruta.startsWith('solicitudes/cliente-7/'), 'debe quedar dentro de su carpeta');
    });

    test('ninguna entrada logra salir de la carpeta del cliente', () => {
        const maliciosos = [
            '../../../../.env',
            '..\\..\\..\\windows\\system32\\x.dll',
            'a/../../b.png',
            '....//....//x.js',
            '/etc/passwd',
            'sin-extension',
            '',
        ];
        for (const nombre of maliciosos) {
            const ruta = rutaAdjuntoSolicitud(7, nombre);
            assert.ok(ruta.startsWith('solicitudes/cliente-7/'), `escapo con: ${nombre}`);
            assert.ok(!ruta.includes('..'), `dejo .. con: ${nombre}`);
            // aunque se usara para armar una ruta de disco, sigue dentro del directorio
            const resuelta = path.posix.normalize(`/base/${ruta}`);
            assert.ok(resuelta.startsWith('/base/solicitudes/cliente-7/'), `normalizo fuera con: ${nombre}`);
        }
    });

    test('no hereda una extension peligrosa ni larga', () => {
        assert.match(rutaAdjuntoSolicitud(1, 'x.PhP'), /\.php$/, 'la extension se normaliza a minusculas');
        // el bucket es privado y no ejecuta nada, pero la extension igual queda acotada
        assert.match(rutaAdjuntoSolicitud(1, 'x.extensionmuylarga'), /\.bin$/);
    });

    test('dos subidas del mismo nombre no se pisan', () => {
        const a = rutaAdjuntoSolicitud(1, 'foto.jpg');
        const b = rutaAdjuntoSolicitud(1, 'foto.jpg');
        assert.notStrictEqual(a, b);
    });
});

// guias, facturas, fotos de equipos, documentos de vehiculos y evidencias: el nombre enviado por el
// usuario tampoco entra en la ruta
const { rutaArchivo, segmentoSeguro, rutaPerteneceAOrden } = require('../src/utils/rutaArchivo');

describe('rutaArchivo', () => {
    test('arma la ruta con las carpetas del servidor y solo la extension del original', () => {
        assert.match(rutaArchivo(['guias', 12], 'Guia 00904.PDF'), /^guias\/12\/\d+-[a-z0-9]+\.pdf$/);
    });

    test('el nombre original nunca aporta carpetas ni ..', () => {
        for (const malo of ['../../x.pdf', 'a/b/c.pdf', '..\\..\\x.pdf', 'ot-99/robada.jpg']) {
            const ruta = rutaArchivo(['ot-5'], malo);
            assert.ok(!ruta.includes('..'), malo);
            assert.equal(ruta.split('/').length, 2, `${malo} no debe crear subcarpetas`);
        }
    });

    test('sanea un segmento que viene de un dato, como el codigo de un equipo', () => {
        assert.equal(segmentoSeguro('GH-204'), 'GH-204');
        assert.equal(segmentoSeguro('../../etc'), '______etc');
        assert.equal(segmentoSeguro('a/b'), 'a_b');
        assert.equal(segmentoSeguro(''), 'sin-nombre');
    });
});

describe('rutaPerteneceAOrden', () => {
    test('acepta una foto subida a la carpeta de la propia orden', () => {
        assert.equal(rutaPerteneceAOrden('ot-5/1726000000000-abc.jpg', 'ot-5/'), true);
    });

    test('rechaza fotos de otra orden, firmas y rutas con trucos', () => {
        for (const ruta of ['ot-6/x.jpg', 'ot-55/x.jpg', 'firmas/ot-5/x.png', 'ot-5/../ot-6/x.jpg',
            'ot-5//x.jpg', 'ot-5\\..\\x', null, 42]) {
            assert.equal(rutaPerteneceAOrden(ruta, 'ot-5/'), false, String(ruta));
        }
    });
});
