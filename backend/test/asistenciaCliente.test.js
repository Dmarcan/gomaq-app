const { test, describe } = require('node:test');
const assert = require('node:assert');

const { validarGravedad, gravedadMayor, estadoPorGravedad, SQL_ASISTENCIA_ABIERTA } = require('../src/utils/asistenciaCliente');
const { estadoTrasCierre } = require('../src/utils/estadoEquipo');

describe('validarGravedad', () => {
    test('ausente es sigue_operando (cliente antiguo)', () => {
        for (const v of [undefined, null, '']) assert.deepEqual(validarGravedad(v), { valida: true, gravedad: 'sigue_operando' });
    });
    test('los tres valores son validos y otro no', () => {
        for (const v of ['sigue_operando', 'parcial', 'fuera_de_servicio']) assert.equal(validarGravedad(v).gravedad, v);
        for (const v of ['PARCIAL', 'operativa', 'x', 1, true, {}]) assert.equal(validarGravedad(v).valida, false, JSON.stringify(v));
    });
});

describe('gravedadMayor', () => {
    test('un detalle sube la gravedad y nunca la baja', () => {
        assert.equal(gravedadMayor('sigue_operando', 'parcial'), 'parcial');
        assert.equal(gravedadMayor('parcial', 'fuera_de_servicio'), 'fuera_de_servicio');
        assert.equal(gravedadMayor('fuera_de_servicio', 'sigue_operando'), 'fuera_de_servicio');
        assert.equal(gravedadMayor('parcial', 'parcial'), 'parcial');
    });
});

describe('estadoPorGravedad', () => {
    test('un equipo operativo pasa a parcial o a fuera de servicio, con origen cliente', () => {
        assert.deepEqual(estadoPorGravedad({ gravedad: 'parcial', estadoEquipo: 'operativa' }), { estado: 'parcialmente_operativa', origen: 'cliente' });
        assert.deepEqual(estadoPorGravedad({ gravedad: 'fuera_de_servicio', estadoEquipo: 'operativa' }), { estado: 'fuera_de_servicio', origen: 'cliente' });
    });
    test('sigue_operando no cambia nada', () => {
        for (const e of ['operativa', 'parcialmente_operativa', 'en_mantencion', 'fuera_de_servicio']) {
            assert.equal(estadoPorGravedad({ gravedad: 'sigue_operando', estadoEquipo: e }), null);
        }
    });
    test('solo empeora: parcial puede pasar a fuera de servicio, nunca al reves', () => {
        assert.deepEqual(estadoPorGravedad({ gravedad: 'fuera_de_servicio', estadoEquipo: 'parcialmente_operativa' }), { estado: 'fuera_de_servicio', origen: 'cliente' });
        assert.equal(estadoPorGravedad({ gravedad: 'parcial', estadoEquipo: 'fuera_de_servicio' }), null);
        assert.equal(estadoPorGravedad({ gravedad: 'parcial', estadoEquipo: 'parcialmente_operativa' }), null);
    });
    test('no pisa un equipo en mantencion (ya lo atiende una orden) ni uno fuera de servicio', () => {
        for (const g of ['parcial', 'fuera_de_servicio']) {
            assert.equal(estadoPorGravedad({ gravedad: g, estadoEquipo: 'en_mantencion' }), null);
        }
        assert.equal(estadoPorGravedad({ gravedad: 'fuera_de_servicio', estadoEquipo: 'fuera_de_servicio' }), null);
    });
});

describe('el cierre de una orden corrige lo que puso el cliente', () => {
    test('con pedido operativa vuelve a operativa (el origen cliente no cuenta como estado puesto a mano)', () => {
        assert.deepEqual(
            estadoTrasCierre({ pedido: 'operativa', otrasAbiertas: 0, estadoEquipo: 'parcialmente_operativa', origenEstado: 'cliente' }),
            { estado: 'operativa', origen: 'mecanico' });
    });
    test('sin pedido (APK antiguo) tambien vuelve a operativa si no quedan otras ordenes', () => {
        assert.deepEqual(
            estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'parcialmente_operativa', origenEstado: 'cliente' }),
            { estado: 'operativa', origen: 'ot' });
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 1, estadoEquipo: 'parcialmente_operativa', origenEstado: 'cliente' }), null);
    });
    test('un estado puesto desde el panel sigue sin tocarse', () => {
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'parcialmente_operativa', origenEstado: 'panel' }), null);
        assert.equal(estadoTrasCierre({ pedido: 'operativa', otrasAbiertas: 0, estadoEquipo: 'parcialmente_operativa', origenEstado: 'panel' }), null);
    });
});

test('una asistencia abierta es pendiente o con la orden sin terminar', () => {
    assert.match(SQL_ASISTENCIA_ABIERTA, /pendiente/);
    assert.match(SQL_ASISTENCIA_ABIERTA, /finalizada/);
});

test('GET /api/maquinarias/mias entrega asistencia_abierta con lo ya enviado (el portal lo necesita para agregar un detalle)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const codigo = fs.readFileSync(path.join(__dirname, '../src/routes/maquinarias.js'), 'utf8');
    const ruta = codigo.slice(codigo.indexOf("router.get('/mias'"), codigo.indexOf("router.get('/mias/historicos'"));
    assert.match(ruta, /AS asistencia_abierta\b/);
    assert.match(ruta, /'descripcion', s\.descripcion/);
    assert.match(ruta, /'detalles'/);
    assert.match(ruta, /SQL_ASISTENCIA_ABIERTA/);
});

const { textoMotivo, textoDetalle, ESTADOS_OT_CON_DETALLE } = require('../src/utils/asistenciaCliente');

describe('texto que lee el tecnico en la orden', () => {
    test('el motivo lleva como esta el equipo y lo que escribio el cliente', () => {
        const t = textoMotivo({ descripcion: 'Pierde aceite', gravedad: 'parcial' });
        assert.match(t, /^Estado del equipo según el cliente: opera parcialmente\./);
        assert.match(t, /Pierde aceite$/);
        assert.match(textoMotivo({ descripcion: 'x', gravedad: 'fuera_de_servicio' }), /no funciona \(fuera de servicio\)/);
        assert.match(textoMotivo({ descripcion: 'x', gravedad: 'sigue_operando' }), /sigue operando/);
    });
    test('un detalle avisa solo si la gravedad subio', () => {
        assert.equal(textoDetalle({ texto: 'ahora hace ruido', gravedadAnterior: 'parcial', gravedadNueva: 'parcial' }), '\n\nDetalle del cliente: ahora hace ruido');
        assert.match(textoDetalle({ texto: 'ya no parte', gravedadAnterior: 'parcial', gravedadNueva: 'fuera_de_servicio' }), /Ahora el cliente indica que el equipo no funciona/);
    });
    test('el detalle se admite mientras el tecnico no acepto la orden', () => {
        assert.deepEqual(ESTADOS_OT_CON_DETALLE, ['pendiente', 'asignada']);
    });
});

test('la ruta de solicitudes crea la OT con su evento de creacion en la misma transaccion', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const codigo = fs.readFileSync(path.join(__dirname, '../src/routes/solicitudes.js'), 'utf8');
    const post = codigo.slice(codigo.indexOf("router.post('/'"), codigo.indexOf("router.post('/:id/detalle'"));
    assert.match(post, /INSERT INTO ordenes_trabajo/);
    assert.match(post, /tipo: 'creacion'/);
    assert.match(post, /fijarDestinoOt/);
    assert.ok(post.indexOf('INSERT INTO ordenes_trabajo') < post.indexOf("COMMIT"));
});

test('la foto de la solicitud tiene su ruta para el tecnico', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const codigo = fs.readFileSync(path.join(__dirname, '../src/routes/ordenes.js'), 'utf8');
    assert.match(codigo, /router\.get\('\/:id\/foto-solicitud'/);
    assert.match(codigo, /requireRole\('gerente', 'administrativo', 'mecanico'\)[^\n]*\n[\s\S]*?foto-solicitud|foto-solicitud'[^\n]*requireRole\('gerente', 'administrativo', 'mecanico'\)/);
});
