// Pruebas de la capa de autorizacion.
//
// Es la capa donde un error no se nota: el sistema sigue funcionando igual, solo que deja pasar
// a quien no corresponde. Por eso se prueba aparte y sin depender del servidor ni de la base de
// datos: estos casos corren en cualquier maquina con `npm test`.
//
// verifyToken responde 401 (no se sabe quien eres) y requireRole responde 403 (se sabe quien
// eres, pero no puedes hacer esto). La distincion importa: un 403 le confirma a quien prueba
// que su sesion es valida, y por eso nunca debe usarse donde corresponde un 401.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-pruebas';
const { verifyToken, requireRole, usarBuscadorDeUsuarios } = require('../src/middleware/auth');
const { creerEnElToken } = require('./_sesionDePrueba');

/** Doble de `res` que registra el estado y el cuerpo en vez de escribir en un socket. */
function respuestaFalsa() {
    const res = { codigo: null, cuerpo: null };
    res.status = (c) => { res.codigo = c; return res; };
    res.json = (b) => { res.cuerpo = b; return res; };
    return res;
}

async function ejecutar(middleware, req) {
    const res = respuestaFalsa();
    let continuo = false;
    await middleware(req, res, () => { continuo = true; });
    return { res, continuo };
}

const firmar = (payload, opciones = {}) =>
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h', ...opciones });

creerEnElToken();

describe('verifyToken', () => {
    test('rechaza la peticion sin cabecera de autorizacion', async () => {
        const { res, continuo } = await ejecutar(verifyToken, { headers: {} });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false, 'no debe continuar hacia la ruta');
    });

    test('rechaza una cabecera que no usa el esquema Bearer', async () => {
        const { res, continuo } = await ejecutar(verifyToken, {
            headers: { authorization: 'Basic dXN1YXJpbzpjbGF2ZQ==' },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false);
    });

    test('rechaza un token firmado con otro secreto', async () => {
        const ajeno = jwt.sign({ id: 1, rol: 'gerente' }, 'otro-secreto');
        const { res, continuo } = await ejecutar(verifyToken, {
            headers: { authorization: `Bearer ${ajeno}` },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false, 'un token de otro emisor no puede pasar');
    });

    test('rechaza un token ya expirado', async () => {
        const vencido = jwt.sign({ id: 1, rol: 'mecanico' }, process.env.JWT_SECRET, { expiresIn: -10 });
        const { res, continuo } = await ejecutar(verifyToken, {
            headers: { authorization: `Bearer ${vencido}` },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false);
    });

    test('rechaza un token manipulado', async () => {
        // se altera un caracter del cuerpo: la firma deja de calzar
        const valido = firmar({ id: 1, rol: 'mecanico' });
        const [cab, cuerpo, firma] = valido.split('.');
        const alterado = `${cab}.${cuerpo.slice(0, -1)}${cuerpo.slice(-1) === 'A' ? 'B' : 'A'}.${firma}`;
        const { res, continuo } = await ejecutar(verifyToken, {
            headers: { authorization: `Bearer ${alterado}` },
        });
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false);
    });

    test('acepta un token valido y expone la identidad a la ruta', async () => {
        const req = { headers: { authorization: `Bearer ${firmar({ id: 7, rol: 'mecanico' })}` } };
        const { res, continuo } = await ejecutar(verifyToken, req);
        assert.equal(continuo, true);
        assert.equal(res.codigo, null, 'no debe responder: debe dejar seguir');
        assert.equal(req.user.id, 7);
        assert.equal(req.user.rol, 'mecanico');
    });
});

describe('verifyToken revisa la cuenta en la base', () => {
    const peticion = (id = 7, rol = 'mecanico', cliente = null) => ({
        headers: { authorization: `Bearer ${firmar({ id, rol, cliente_id: cliente })}` },
    });
    let restaurar;
    afterEach(() => { if (restaurar) restaurar(); restaurar = null; creerEnElToken(); });

    test('una cuenta desactivada o pendiente responde 401 aunque el token siga vigente', async () => {
        for (const estado of ['rechazado', 'pendiente']) {
            restaurar = usarBuscadorDeUsuarios(async () => ({ rol: 'mecanico', cliente_id: null, estado_cuenta: estado }));
            const { res, continuo } = await ejecutar(verifyToken, peticion());
            assert.equal(res.codigo, 401, estado);
            assert.equal(continuo, false);
            restaurar();
        }
    });

    test('un usuario que ya no existe responde 401', async () => {
        restaurar = usarBuscadorDeUsuarios(async () => null);
        const { res, continuo } = await ejecutar(verifyToken, peticion());
        assert.equal(res.codigo, 401);
        assert.equal(continuo, false);
    });

    test('el rol y el cliente salen de la base, no del token: un cambio rige de inmediato', async () => {
        restaurar = usarBuscadorDeUsuarios(async () => ({ rol: 'mecanico', cliente_id: 5, estado_cuenta: 'activo' }));
        const req = peticion(7, 'gerente', 99); // el token dice gerente y cliente 99
        const { continuo } = await ejecutar(verifyToken, req);
        assert.equal(continuo, true);
        assert.equal(req.user.rol, 'mecanico', 'manda el rol vigente');
        assert.equal(req.user.cliente_id, 5, 'manda el cliente vigente');
        assert.equal((await ejecutar(requireRole('gerente'), req)).res.codigo, 403, 'ya no pasa como gerente');
    });

    test('si la base no responde contesta 503 y no 401: una caida no cierra sesiones', async () => {
        restaurar = usarBuscadorDeUsuarios(async () => { throw new Error('conexion rechazada'); });
        const silenciar = console.error;
        console.error = () => {};
        try {
            const { res, continuo } = await ejecutar(verifyToken, peticion());
            assert.equal(res.codigo, 503);
            assert.equal(continuo, false);
            assert.ok(!JSON.stringify(res.cuerpo).includes('conexion rechazada'), 'no filtra el detalle del error');
        } finally {
            console.error = silenciar;
        }
    });

    test('un token emitido antes de que se cambiara la contraseña deja de valer (sin ventana, ni en el mismo segundo)', async () => {
        const cambio = new Date('2026-11-10T12:00:00.500Z');
        const ms = cambio.getTime();
        const casos = [
            { claim: 0, bd: cambio, pasa: false, nombre: 'token de antes del cambio (la clave se cambio despues)' },
            { claim: undefined, bd: cambio, pasa: false, nombre: 'token antiguo sin claim, y la clave ya se cambio' },
            { claim: ms - 1, bd: cambio, pasa: false, nombre: 'token con un cambio anterior, y hubo otro despues' },
            { claim: ms, bd: cambio, pasa: true, nombre: 'token emitido despues del cambio' },
            { claim: 0, bd: null, pasa: true, nombre: 'la clave nunca se cambio' },
            { claim: undefined, bd: null, pasa: true, nombre: 'token antiguo sin claim y la clave nunca se cambio' },
            { claim: ms, bd: null, pasa: false, nombre: 'el claim dice que se cambio pero la base no: no coincide' },
        ];
        for (const c of casos) {
            restaurar = usarBuscadorDeUsuarios(async () => ({
                rol: 'mecanico', cliente_id: null, estado_cuenta: 'activo', password_cambiada_at: c.bd,
            }));
            const req = { headers: { authorization: `Bearer ${firmar({ id: 7, rol: 'mecanico', cliente_id: null, pc: c.claim })}` } };
            const { res, continuo } = await ejecutar(verifyToken, req);
            assert.equal(continuo, c.pasa, c.nombre);
            assert.equal(res.codigo, c.pasa ? null : 401, c.nombre);
            restaurar();
        }
    });

    test('un id que no es entero no llega a la base', async () => {
        let consultas = 0;
        restaurar = usarBuscadorDeUsuarios(async () => { consultas++; return { rol: 'gerente', cliente_id: null, estado_cuenta: 'activo' }; });
        for (const id of ['1 OR 1=1', null, 1.5, undefined]) {
            const req = { headers: { authorization: `Bearer ${firmar({ id, rol: 'gerente' })}` } };
            const { res, continuo } = await ejecutar(verifyToken, req);
            assert.equal(res.codigo, 401);
            assert.equal(continuo, false);
        }
        assert.equal(consultas, 0);
    });
});

describe('requireRole', () => {
    test('deja pasar al rol habilitado', async () => {
        const { res, continuo } = await ejecutar(requireRole('administrativo'), {
            user: { id: 4, rol: 'administrativo' },
        });
        assert.equal(continuo, true);
        assert.equal(res.codigo, null);
    });

    test('deja pasar a cualquiera de los roles enumerados', async () => {
        for (const rol of ['gerente', 'administrativo', 'mecanico']) {
            const { continuo } = await ejecutar(requireRole('gerente', 'administrativo', 'mecanico'), {
                user: { id: 1, rol },
            });
            assert.equal(continuo, true, `el rol ${rol} deberia estar habilitado`);
        }
    });

    test('rechaza con 403 al rol no habilitado', async () => {
        const { res, continuo } = await ejecutar(requireRole('administrativo', 'gerente'), {
            user: { id: 2, rol: 'mecanico' },
        });
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });

    test('rechaza al cliente en un modulo interno', async () => {
        const { res, continuo } = await ejecutar(requireRole('administrativo', 'gerente'), {
            user: { id: 3, rol: 'cliente' },
        });
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });

    test('rechaza cuando no hay usuario en la peticion', async () => {
        // ocurriria si una ruta montara requireRole sin verifyToken delante:
        // el control no debe asumir que alguien ya autentico
        const { res, continuo } = await ejecutar(requireRole('gerente'), {});
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });

    test('un rol inventado no atraviesa el control', async () => {
        const { res, continuo } = await ejecutar(requireRole('gerente'), {
            user: { id: 9, rol: 'superadministrador' },
        });
        assert.equal(res.codigo, 403);
        assert.equal(continuo, false);
    });
});

describe('encadenamiento de ambos controles', () => {
    test('un token valido de mecanico no habilita una ruta de administrativo', async () => {
        const req = { headers: { authorization: `Bearer ${firmar({ id: 2, rol: 'mecanico' })}` } };
        const paso1 = await ejecutar(verifyToken, req);
        assert.equal(paso1.continuo, true, 'la autenticacion si debe pasar');

        const paso2 = await ejecutar(requireRole('administrativo'), req);
        assert.equal(paso2.res.codigo, 403, 'la autorizacion debe detenerlo');
        assert.equal(paso2.continuo, false);
    });

    test('el rol viaja en el token y no en la peticion', async () => {
        // si el rol se leyera de la cabecera o del cuerpo, bastaria con declararse gerente
        const req = {
            headers: { authorization: `Bearer ${firmar({ id: 2, rol: 'mecanico' })}`, rol: 'gerente' },
            body: { rol: 'gerente' },
        };
        await ejecutar(verifyToken, req);
        assert.equal(req.user.rol, 'mecanico', 'debe primar el rol firmado en el token');
        const { res } = await ejecutar(requireRole('gerente'), req);
        assert.equal(res.codigo, 403);
    });
});
