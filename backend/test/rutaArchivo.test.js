const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { rutaAdjuntoSolicitud } = require('../src/utils/rutaArchivo');

/**
 * Regresion del hallazgo critico de la auditoria.
 *
 * Antes el adjunto del cliente se guardaba con `multer.diskStorage` usando el nombre que el
 * propio cliente enviaba. Multer hace `path.join(destino, nombre)` SIN normalizar, asi que un
 * nombre con `../` escapaba del directorio: se verifico que `1700-../../../../.env` terminaba
 * escribiendo `backend/.env`, es decir el JWT_SECRET y las credenciales de la base.
 *
 * La correccion es que el nombre del cliente ya no participe de la ruta: el servidor la arma
 * entera y del original solo rescata la extension, saneada.
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
