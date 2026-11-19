// Verificacion extremo a extremo contra una instancia desplegada del sistema.
//
// A diferencia del resto de la bateria, estos casos necesitan el servidor encendido y su base
// de datos con las cuentas de prueba. Si no hay instancia disponible, los casos se omiten con
// un aviso en vez de fallar: un servidor apagado no es un defecto del codigo.
//
//   GOMAQ_TEST_URL=http://localhost:3000 npm test    apunta a la instancia a verificar
//
// Sin GOMAQ_TEST_URL los casos se omiten: no hay instancia por defecto, para que una ejecucion
// local nunca inicie sesion ni consulte el servidor de produccion. Todos los casos son de solo
// lectura, pero se usan cuentas de prueba, asi que el destino debe ser una instancia propia
// (local o del CI).

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.GOMAQ_TEST_URL || '';
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
        t.skip(`sin instancia disponible${BASE ? ` en ${BASE}` : ''}: ${motivo}`);
        return false;
    }
    return true;
}

before(async () => {
    if (!BASE) {
        motivo = 'defina GOMAQ_TEST_URL';
        return;
    }
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

    test('Flota: cada fila trae lo que la tabla muestra para distinguir equipos', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/maquinarias?limit=1', con(tokens.administrativo));
        const { items } = await r.json();
        if (items.length === 0) return t.skip('no hay equipos cargados');
        for (const campo of ['codigo', 'tipo', 'estado', 'marca', 'modelo', 'capacidad_carga', 'altura_trabajo', 'tipo_combustible']) {
            assert.ok(campo in items[0], `falta ${campo} en la fila del listado`);
        }
    });

    test('Flota: el resumen cuenta la flota completa y por categoria', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/maquinarias/resumen', con(tokens.administrativo));
        assert.equal(r.status, 200);
        const cuerpo = await r.json();
        for (const campo of ['total', 'disponibles', 'arrendados', 'en_mantencion', 'fuera_de_servicio']) {
            assert.equal(typeof cuerpo[campo], 'number', campo);
        }
        // un equipo no puede estar disponible y arrendado a la vez; los que no estan operativos
        // ni tienen cliente no son ninguno de los dos
        assert.ok(cuerpo.disponibles + cuerpo.arrendados <= cuerpo.total);
        const enCategorias = Object.values(cuerpo.por_categoria).reduce((a, b) => a + b, 0);
        assert.ok(enCategorias <= cuerpo.total, 'las categorias no pueden sumar mas que la flota');
    });

    test('Flota: el Dashboard y el resumen cuentan igual los disponibles', async (t) => {
        if (!requiereServidor(t)) return;
        const flota = await (await pedir('/api/maquinarias/resumen', con(tokens.administrativo))).json();
        const dash = await (await pedir('/api/dashboard/resumen', con(tokens.administrativo))).json();
        assert.equal(Number(dash.flota.disponibles), flota.disponibles);
        assert.equal(Number(dash.flota.arrendados), flota.arrendados);
        // y el filtro de la lista devuelve exactamente esa cantidad
        const lista = await (await pedir('/api/maquinarias?disponibilidad=disponibles&limit=1', con(tokens.administrativo))).json();
        assert.equal(lista.total, flota.disponibles);
    });

    test('Flota: el resumen no lo ve el cliente', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/maquinarias/resumen', con(tokens.cliente));
        assert.equal(r.status, 403);
    });

    test('Flota: ordenar por altura deja los equipos sin altura al final', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/maquinarias?orden=altura&dir=desc', con(tokens.administrativo));
        assert.equal(r.status, 200);
        const alturas = (await r.json()).items.map((m) => (m.altura_trabajo === null ? null : Number(m.altura_trabajo)));
        const primerVacio = alturas.indexOf(null);
        if (primerVacio !== -1) {
            assert.ok(alturas.slice(primerVacio).every((a) => a === null), 'un equipo con altura aparecio despues de uno sin altura');
        }
        const conAltura = alturas.filter((a) => a !== null);
        assert.deepEqual(conAltura, [...conAltura].sort((a, b) => b - a));
    });

    test('Flota: un orden inventado no rompe el listado', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/maquinarias?orden=' + encodeURIComponent("x'; DROP TABLE maquinarias; --"), con(tokens.administrativo));
        assert.equal(r.status, 200);
    });

    test('el perfil del equipo trae cuanto falta para la mantencion', async (t) => {
        if (!requiereServidor(t)) return;
        const lista = await (await pedir('/api/maquinarias?limit=1', con(tokens.administrativo))).json();
        if (lista.items.length === 0) return t.skip('no hay equipos cargados');
        const r = await pedir(`/api/maquinarias/${lista.items[0].id}`, con(tokens.administrativo));
        assert.equal(r.status, 200);
        const { mantencion } = await r.json();
        for (const campo of ['ultima_lectura', 'intervalo_horas', 'horas_restantes', 'por_vencer', 'vencida']) {
            assert.ok(campo in mantencion, `falta ${campo} en mantencion`);
        }
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

    test('la politica permite el registro de avisos push (Firebase) en la web', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/health');
        const politica = r.headers.get('content-security-policy') || '';
        const connect = (politica.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) || '').split(/\s+/);
        for (const host of ['https://fcmregistrations.googleapis.com', 'https://firebaseinstallations.googleapis.com']) {
            assert.ok(connect.includes(host), `connect-src no incluye ${host}`);
        }
    });

    test('el service worker de avisos nunca se reemplaza por el index.html del panel', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/firebase-messaging-sw.js');
        const tipo = r.headers.get('content-type') || '';
        assert.ok(!tipo.includes('text/html'), `content-type ${tipo}`);
        if (r.status === 200) {
            // con el panel compilado: JavaScript y sin cache largo
            assert.match(tipo, /javascript/);
            assert.match(r.headers.get('cache-control') || '', /no-cache/);
        } else {
            assert.equal(r.status, 404);
        }
    });

    test('no borra el Referer: el mapa de OpenStreetMap lo exige y bloquea sin el', async (t) => {
        if (!requiereServidor(t)) return;
        const r = await pedir('/api/health');
        const politica = r.headers.get('referrer-policy');
        assert.ok(politica, 'falta la cabecera Referrer-Policy');
        assert.notEqual(politica, 'no-referrer', 'no-referrer quita el Referer y OSM responde 403 a las imagenes del mapa');
        assert.ok(!politica.includes('no-referrer'), politica);
        // a otros sitios debe viajar como maximo el origen, nunca la ruta con datos
        assert.ok(['strict-origin-when-cross-origin', 'strict-origin', 'origin-when-cross-origin', 'origin'].includes(politica), politica);
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

describe('bloque 6 (parte 1): pendientes del dashboard y pestanas de Ordenes', () => {
    test('/dashboard/pendientes lo ven administrativo y gerente; mecanico y cliente reciben 403', async (t) => {
        if (!requiereServidor(t)) return;
        assert.equal((await pedir('/api/dashboard/pendientes', con(tokens.administrativo))).status, 200);
        assert.equal((await pedir('/api/dashboard/pendientes', con(tokens.mecanico))).status, 403);
        assert.equal((await pedir('/api/dashboard/pendientes', con(tokens.cliente))).status, 403);
        assert.equal((await pedir('/api/dashboard/pendientes')).status, 401);
    });

    test('el portal no ve los pendientes ni el resumen de ordenes', async (t) => {
        if (!requiereServidor(t)) return;
        assert.equal((await pedir('/api/ordenes-trabajo/resumen', con(tokens.cliente))).status, 403);
        assert.equal((await pedir('/api/notificaciones?problemas=1', con(tokens.cliente))).status, 403);
    });
});
