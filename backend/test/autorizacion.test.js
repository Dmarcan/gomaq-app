// Pruebas de la capa de autorizacion.
//
// Es la capa donde un error no se nota: el sistema sigue funcionando igual, solo que deja pasar
// a quien no corresponde. Por eso se prueba aparte y sin depender del servidor ni de la base de
// datos: estos casos corren en cualquier maquina con `npm test`.
//
// verifyToken responde 401 (no se sabe quien eres) y requireRole responde 403 (se sabe quien
// eres, pero no puedes hacer esto). La distincion importa: un 403 le confirma a quien prueba
// que su sesion es valida, y por eso nunca debe usarse donde corresponde un 401.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-pruebas';
const { verifyToken, requireRole } = require('../src/middleware/auth');

/** Doble de `res` que registra el estado y el cuerpo en vez de escribir en un socket. */
function respuestaFalsa() {
    const res = { codigo: null, cuerpo: null };
    res.status = (c) => { res.codigo = c; return res; };
    res.json = (b) => { res.cuerpo = b; return res; };
    return res;
}

function ejecutar(middleware, req) {
    const res = respuestaFalsa();
    let continuo = false;
    middleware(req, res, () => { continuo = true; });
    return { res, continuo };
}

const firmar = (payload, opciones = {}) =>
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h', ...opciones });

describe('verifyToken', () => {
    test('rechaza la peticion sin cabecera de autorizacion', () => {
        const { res, continuo } = ejecutar(verifyToken, { headers: {} });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false, 'no debe continuar hacia la ruta');
    });

    test('rechaza una cabecera que no usa el esquema Bearer', () => {
        const { res, continuo } = ejecutar(verifyToken, {
            headers: { authorization: 'Basic dXN1YXJpbzpjbGF2ZQ==' },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false);
    });

    test('rechaza un token firmado con otro secreto', () => {
        const ajeno = jwt.sign({ id: 1, rol: 'gerente' }, 'otro-secreto');
        const { res, continuo } = ejecutar(verifyToken, {
            headers: { authorization: `Bearer ${ajeno}` },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false, 'un token de otro emisor no puede pasar');
    });

    test('rechaza un token ya expirado', () => {
        const vencido = jwt.sign({ id: 1, rol: 'mecanico' }, process.env.JWT_SECRET, { expiresIn: -10 });
        const { res, continuo } = ejecutar(verifyToken, {
            headers: { authorization: `Bearer ${vencido}` },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false);
    });

    test('rechaza un token manipulado', () => {
        // se altera un caracter del cuerpo: la firma deja de calzar
        const valido = firmar({ id: 1, rol: 'mecanico' });
        const [cab, cuerpo, firma] = valido.split('.');
        const alterado = `${cab}.${cuerpo.slice(0, -1)}${cuerpo.slice(-1) === 'A' ? 'B' : 'A'}.${firma}`;
        const { res, continuo } = ejecutar(verifyToken, {
            headers: { authorization: `Bearer ${alterado}` },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false);
    });

    test('acepta un token valido y expone la identidad a la ruta', () => {
        const req = { headers: { authorization: `Bearer ${firmar({ id: 7, rol: 'mecanico' })}` } };
        const { res, continuo } = ejecutar(verifyToken, req);
        assert.equal(continuo, true);
        assert.equal(res.codigo, null, 'no debe responder: debe dejar seguir');
        assert.equal(req.user.id, 7);
        assert.equal(req.user.rol, 'mecanico');
    });
});

describe('requireRole', () => {
    test('deja pasar al rol habilitado', () => {
        const { res, continuo } = ejecutar(requireRole('administrativo'), {
            user: { id: 4, rol: 'administrativo' },
        });
        assert.equal(continuo, true);
        assert.equal(res.codigo, null);
    });

    test('deja pasar a cualquiera de los roles enumerados', () => {
        for (const rol of ['gerente', 'administrativo', 'mecanico']) {
            const { continuo } = ejecutar(requireRole('gerente', 'administrativo', 'mecanico'), {
                user: { id: 1, rol },
            });
            assert.equal(continuo, true, `el rol ${rol} deberia estar habilitado`);
        }
    });

    test('rechaza con 403 al rol no habilitado', () => {
        const { res, continuo } = ejecutar(requireRole('administrativo', 'gerente'), {
            user: { id: 2, rol: 'mecanico' },
        });
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });

    test('rechaza al cliente en un modulo interno', () => {
        const { res, continuo } = ejecutar(requireRole('administrativo', 'gerente'), {
            user: { id: 3, rol: 'cliente' },
        });
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });

    test('rechaza cuando no hay usuario en la peticion', () => {
        // ocurriria si una ruta montara requireRole sin verifyToken delante:
        // el control no debe asumir que alguien ya autentico
        const { res, continuo } = ejecutar(requireRole('gerente'), {});
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });

    test('un rol inventado no atraviesa el control', () => {
        const { res, continuo } = ejecutar(requireRole('gerente'), {
            user: { id: 9, rol: 'superadministrador' },
        });
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });
});

describe('encadenamiento de ambos controles', () => {
    test('un token valido de mecanico no habilita una ruta de administrativo', () => {
        const req = { headers: { authorization: `Bearer ${firmar({ id: 2, rol: 'mecanico' })}` } };
        const paso1 = ejecutar(verifyToken, req);
        assert.equal(paso1.continuo, true, 'la autenticacion si debe pasar');

        const paso2 = ejecutar(requireRole('administrativo'), req);
        assert.equal(paso2.res.codigo, 403, 'la autorizacion debe detenerlo');
        assert.equal(paso2.continuo, false);
    });

    test('el rol viaja en el token y no en la peticion', () => {
        // si el rol se leyera de la cabecera o del cuerpo, bastaria con declararse gerente
        const req = {
            headers: { authorization: `Bearer ${firmar({ id: 2, rol: 'mecanico' })}`, rol: 'gerente' },
            body: { rol: 'gerente' },
        };
        ejecutar(verifyToken, req);
        assert.equal(req.user.rol, 'mecanico', 'debe primar el rol firmado en el token');
        const { res } = ejecutar(requireRole('gerente'), req);
        assert.equal(res.codigo, 403);
    });
});
