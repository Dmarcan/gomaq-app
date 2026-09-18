// Verificacion extremo a extremo contra una instancia desplegada del sistema.
//
// A diferencia del resto de la bateria, estos casos necesitan el servidor encendido y su base
// de datos con las cuentas de prueba. Si no hay instancia disponible, los casos se omiten con
// un aviso en vez de fallar: un servidor apagado no es un defecto del codigo.
//
//   npm test                                  usa el servidor de Railway
//   GOMAQ_TEST_URL=http://localhost:3000 npm test    apunta a otra instancia
//
// Todos los casos son de solo lectura. Ninguno crea, modifica ni borra datos, de modo que la
// bateria puede ejecutarse contra el servidor real sin ensuciarlo.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.GOMAQ_TEST_URL || 'https://gomaq-app-production.up.railway.app';
const CLAVE = process.env.GOMAQ_TEST_PASSWORD || 'PruebaGomaq123';
const CUENTAS = {
    administrativo: 'administrativo@gomaq.test',
    mecanico: 'mecanico@gomaq.test',
    mecanicoDos: 'mecanico2@gomaq.test',
    cliente: 'cliente@gomaq.test',
};

let disponible = false;
let motivo = '';
const tokens = {};

async function pedir(ruta, opciones = {}, esperaMs = 10000) {
    return fetch(`${BASE}${ruta}`, { signal: AbortSignal.timeout(esperaMs), ...opciones });
}

async function autenticar(email) {
    const r = await pedir('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: CLAVE }),
    });
    if (!r.ok) return null;
    return (await r.json()).token;
}

const con = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Omite el caso, con motivo, cuando no hay instancia contra la cual verificar. */
function requiereServidor(t) {
    if (!disponible) {
        t.skip(`sin instancia disponible en ${BASE}: ${motivo}`);
        return false;
    }
    return true;
}

before(async () => {
    try {
        // sonda breve: si no contesta rapido, la instancia no esta operativa y no tiene
        // sentido hacer esperar diez segundos a cada ejecucion de la bateria
        const r = await pedir('/api/health', {}, 3000);
        if (!r.ok) {
            motivo = `/api/health respondio ${r.status}`;
            return;
        }
        for (const [nombre, email] of Object.entries(CUENTAS)) {
            tokens[nombre] = await autenticar(email);
        }
        if (!tokens.mecanico || !tokens.administrativo) {
            motivo = 'las cuentas de prueba no autenticaron';
            return;
        }
        disponible = true;
    } catch (err) {
        motivo = err.name === 'TimeoutError' ? 'tiempo de espera agotado' : err.message;
    }
});

describe('disponibilidad y contrato basico', () => {
    test('el servicio informa su estado y el de la base de datos', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/health');
        const cuerpo = await r.json();
        assert.equal(r.status, 200);
        assert.equal(cuerpo.status, 'ok');
        assert.equal(cuerpo.db, 'connected', 'el servicio no alcanza su base de datos');
    });

    test('los listados extensos responden con el envoltorio de paginacion', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/maquinarias?limit=1', con(tokens.administrativo));
        assert.equal(r.status, 200);
        const cuerpo = await r.json();
        for (const campo of ['items', 'total', 'hay_mas']) {
            assert.ok(campo in cuerpo, `falta el campo ${campo} en la respuesta paginada`);
        }
        assert.ok(Array.isArray(cuerpo.items));
        assert.ok(cuerpo.items.length <= 1, 'el limite solicitado no se respeto');
    });

    test('el listado de servicios reproduce la orden de trabajo en papel', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/checklist', con(tokens.mecanico));
        assert.equal(r.status, 200);
        const cuerpo = await r.json();
        const items = Array.isArray(cuerpo) ? cuerpo : cuerpo.items;
        assert.equal(items.length, 31, 'el formulario en papel tiene 31 servicios');
        const grupos = new Set(items.map((i) => i.grupo));
        assert.equal(grupos.size, 5, 'los servicios se agrupan en 5 categorias');
    });
});

describe('autenticacion', () => {
    test('rechaza credenciales incorrectas', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: CUENTAS.mecanico, password: 'clave-incorrecta' }),
        });
        assert.equal(r.status, 401);
    });

    test('una ruta protegida exige token', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/ordenes-trabajo');
        assert.equal(r.status, 401);
    });

    test('un token invalido no abre ninguna ruta', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/ordenes-trabajo', con('esto.no.es-un-token'));
        assert.equal(r.status, 401);
    });
});

describe('control de acceso por rol', () => {
    test('el mecanico no accede al control de descuadres de inventario', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/insumos/descuadres', con(tokens.mecanico));
        assert.equal(r.status, 403);
    });

    test('el mecanico no accede a los reportes de gestion', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/rentabilidad', con(tokens.mecanico));
        assert.equal(r.status, 403);
    });

    test('el cliente no accede a los modulos internos', async (t) => {
        if (!requiereServidor(t) || !tokens.cliente) return t.skip('sin cuenta de cliente');
        for (const ruta of ['/api/insumos', '/api/rentabilidad', '/api/usuarios']) {
            const r = await pedir(ruta, con(tokens.cliente));
            assert.equal(r.status, 403, `${ruta} deberia estar vedada al cliente`);
        }
    });

    test('el perfil habilitado si accede: el control discrimina, no bloquea a todos', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/insumos/descuadres', con(tokens.administrativo));
        assert.equal(r.status, 200, 'el caso de control debe pasar');
    });
});

describe('pertenencia del recurso', () => {
    test('un mecanico no accede a la orden de trabajo de otro', async (t) => {
        if (!requiereServidor(t)) return;

        // se identifica al mecanico que ejecuta la prueba y se busca, desde el listado
        // completo que ve el administrativo, una orden asignada a alguien distinto
        const perfil = await pedir('/api/usuarios/mi-perfil', con(tokens.mecanico));
        assert.equal(perfil.status, 200);
        const yo = (await perfil.json()).id;

        const listado = await pedir('/api/ordenes-trabajo', con(tokens.administrativo));
        assert.equal(listado.status, 200);
        const cuerpo = await listado.json();
        const ordenes = Array.isArray(cuerpo) ? cuerpo : cuerpo.items;
        const ajena = (ordenes || []).find((o) => o.mecanico_id && o.mecanico_id !== yo);
        if (!ajena) return t.skip('no hay ordenes asignadas a otro mecanico');

        const r = await pedir(`/api/ordenes-trabajo/${ajena.id}`, con(tokens.mecanico));
        assert.equal(r.status, 403, 'conocer el identificador no debe bastar para acceder');
    });

    test('el portal del cliente esta vedado al mecanico', async (t) => {
        if (!requiereServidor(t)) return;
        // /mias entrega el historial del cliente, no el del mecanico: son endpoints distintos
        const r = await pedir('/api/ordenes-trabajo/mias', con(tokens.mecanico));
        assert.equal(r.status, 403);
    });

    test('cada mecanico ve el stock de su propio furgon', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/insumos/mi-furgon', con(tokens.mecanico));
        assert.equal(r.status, 200, 'el mecanico debe poder consultar su propio furgon');
    });
});

describe('superficie expuesta', () => {
    test('el servidor no anuncia la tecnologia que ejecuta', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/health');
        assert.equal(r.headers.get('x-powered-by'), null);
    });

    test('declara una politica de seguridad de contenido', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/health');
        assert.ok(r.headers.get('content-security-policy'), 'falta la cabecera de politica de contenido');
    });

    test('no expone archivos del servidor sin autenticacion', async (t) => {
        if (!requiereServidor(t)) return;
        // el directorio publico de subidas se elimino: la ruta debe caer en el panel web,
        // nunca entregar un archivo del disco del servidor
        const r = await pedir('/uploads/solicitudes/../../.env');
        const cuerpo = await r.text();
        assert.ok(!cuerpo.includes('DATABASE_URL'), 'se filtro contenido de configuracion');
        assert.ok(!cuerpo.includes('JWT_SECRET'), 'se filtro el secreto de firma');
    });
});
