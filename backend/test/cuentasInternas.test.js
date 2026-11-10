const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validarNuevaCuenta, validarCambioDeEstado, validarCambioDePassword, validarPassword, ROLES_INTERNOS } = require('../src/utils/cuentasInternas');

const valido = (extra = {}) => ({ nombre: 'Juan Pérez', email: 'juan@gomaq.cl', rol: 'mecanico', password: 'una-clave-larga', ...extra });

describe('validarNuevaCuenta', () => {
    test('acepta una cuenta de cada rol interno y normaliza nombre y correo', () => {
        for (const rol of ROLES_INTERNOS) {
            const r = validarNuevaCuenta(valido({ rol, nombre: '  Ana Soto ', email: '  Ana@Gomaq.CL ' }));
            assert.equal(r.ok, true, rol);
            assert.equal(r.datos.rol, rol);
            assert.equal(r.datos.nombre, 'Ana Soto');
            assert.equal(r.datos.email, 'ana@gomaq.cl');
        }
    });

    test('el rol cliente y los roles inventados se rechazan (los clientes se crean por el registro)', () => {
        for (const rol of ['cliente', 'superadmin', '', null, undefined, 7, ['gerente']]) {
            assert.equal(validarNuevaCuenta(valido({ rol })).ok, false, String(rol));
        }
    });

    test('contraseña: minimo 8 caracteres y no mas de 72 bytes (bcrypt trunca en silencio)', () => {
        assert.equal(validarNuevaCuenta(valido({ password: '1234567' })).ok, false);
        assert.equal(validarNuevaCuenta(valido({ password: '12345678' })).ok, true);
        assert.equal(validarNuevaCuenta(valido({ password: 'a'.repeat(72) })).ok, true);
        assert.equal(validarNuevaCuenta(valido({ password: 'a'.repeat(73) })).ok, false);
        // 40 letras con tilde son 80 bytes: pasan el largo en caracteres pero no el de bcrypt
        assert.equal(validarNuevaCuenta(valido({ password: 'é'.repeat(40) })).ok, false);
    });

    test('campos mal tipados no lanzan: 400 con mensaje', () => {
        for (const mal of [123, {}, [], true, null]) {
            assert.equal(validarNuevaCuenta(valido({ nombre: mal })).ok, false);
            assert.equal(validarNuevaCuenta(valido({ email: mal })).ok, false);
            assert.equal(validarNuevaCuenta(valido({ password: mal })).ok, false);
        }
        for (const cuerpo of [null, undefined, 'texto', 5, []]) {
            assert.equal(validarNuevaCuenta(cuerpo).ok, false);
        }
    });

    test('nombre y correo: largo y formato', () => {
        assert.equal(validarNuevaCuenta(valido({ nombre: 'A' })).ok, false);
        assert.equal(validarNuevaCuenta(valido({ nombre: 'x'.repeat(151) })).ok, false);
        for (const email of ['sin-arroba', 'a@b', 'a b@c.cl', '@gomaq.cl', 'a@.cl', `${'x'.repeat(146)}@g.cl`]) {
            assert.equal(validarNuevaCuenta(valido({ email })).ok, false, email);
        }
    });
});

describe('validarPassword y validarCambioDePassword', () => {
    test('minimo 8 caracteres y maximo 72 bytes', () => {
        assert.equal(validarPassword('1234567').ok, false);
        assert.equal(validarPassword('12345678').ok, true);
        assert.equal(validarPassword('a'.repeat(72)).ok, true);
        assert.equal(validarPassword('a'.repeat(73)).ok, false);
        assert.equal(validarPassword('é'.repeat(40)).ok, false, '80 bytes');
    });

    test('el cuerpo debe traer una contraseña de texto', () => {
        assert.deepEqual(validarCambioDePassword({ password: 'una-clave-nueva' }), { ok: true, password: 'una-clave-nueva' });
        for (const cuerpo of [null, undefined, 'texto', 5, [], {}, { password: 12345678 }, { password: ['abcdefgh'] }, { clave: 'una-clave-nueva' }]) {
            assert.equal(validarCambioDePassword(cuerpo).ok, false, JSON.stringify(cuerpo));
        }
    });
});

describe('validarCambioDeEstado', () => {
    test('activo true o false, pero nunca la propia cuenta', () => {
        assert.deepEqual(validarCambioDeEstado({ activo: false }, 5, 9), { ok: true, estado: 'rechazado' });
        assert.deepEqual(validarCambioDeEstado({ activo: true }, 5, 9), { ok: true, estado: 'activo' });
        const propia = validarCambioDeEstado({ activo: false }, 9, 9);
        assert.equal(propia.ok, false);
        assert.equal(propia.codigo, 409);
        assert.equal(validarCambioDeEstado({ activo: false }, '9', 9).ok, false, 'el id de la ruta llega como texto');
    });

    test('un valor que no es booleano se rechaza', () => {
        for (const activo of ['false', 0, 1, null, undefined, {}]) {
            const r = validarCambioDeEstado({ activo }, 5, 9);
            assert.equal(r.ok, false, String(activo));
            assert.equal(r.codigo, 400);
        }
        assert.equal(validarCambioDeEstado(undefined, 5, 9).ok, false);
    });
});
