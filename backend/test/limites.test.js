// IP con que se cuentan los intentos de login y de registro (middleware/limites.js).
//
// Detras del tunel todas las peticiones llegan desde 127.0.0.1: si el limite contara por esa
// IP, diez contraseñas equivocadas de una persona dejarian a todos sin poder entrar.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ipDelCliente } = require('../src/middleware/limites');

const peticion = ({ directa, ip, cabeceras = {} }) => ({
    socket: { remoteAddress: directa },
    ip,
    headers: cabeceras,
});

describe('ipDelCliente', () => {
    test('detras del tunel usa la IP que entrega cloudflared, no la de loopback', () => {
        const a = peticion({ directa: '127.0.0.1', ip: '127.0.0.1', cabeceras: { 'cf-connecting-ip': '200.1.2.3' } });
        const b = peticion({ directa: '127.0.0.1', ip: '127.0.0.1', cabeceras: { 'cf-connecting-ip': '190.9.8.7' } });
        assert.equal(ipDelCliente(a), '200.1.2.3');
        assert.notEqual(ipDelCliente(a), ipDelCliente(b), 'dos personas distintas no comparten contador');
    });

    test('tambien reconoce loopback en IPv6', () => {
        const r = peticion({ directa: '::1', ip: '::1', cabeceras: { 'cf-connecting-ip': '200.1.2.3' } });
        assert.equal(ipDelCliente(r), '200.1.2.3');
    });

    test('ignora CF-Connecting-IP si la conexion no viene del propio equipo', () => {
        // desde afuera cualquiera puede inventar la cabecera para saltarse el limite
        const r = peticion({ directa: '181.5.5.5', ip: '181.5.5.5', cabeceras: { 'cf-connecting-ip': '1.1.1.1' } });
        assert.equal(ipDelCliente(r), '181.5.5.5');
    });

    test('detras de otro proxy usa req.ip, calculada por Express segun trust proxy', () => {
        const r = peticion({ directa: '10.0.0.4', ip: '200.1.2.3' });
        assert.equal(ipDelCliente(r), '200.1.2.3');
    });
});
