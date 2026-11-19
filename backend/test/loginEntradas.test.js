// Entradas del login: un valor que no es texto se rechaza con 400 (antes bcrypt lanzaba y salia un 500), y un correo
// sin cuenta cuesta una comparacion de bcrypt igual que uno con cuenta, para que la demora no delate cuales existen.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-login-entradas';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { requiereBase, servirApp, leerRespuesta } = require('./utils/http');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
let ipSiguiente = 1;

async function login(cuerpo) {
    const ip = `10.81.${Math.floor(ipSiguiente / 250)}.${(ipSiguiente++ % 250) + 1}`;
    const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify(cuerpo),
    });
    return leerRespuesta(r);
}

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../src/routes/auth'));
    ({ servidor, base } = await servirApp(app));
});

after(async () => {
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
    if (pool) await pool.end();
});

describe('login: entradas que no son texto', () => {
    test('correo o contraseña numericos, objetos, listas o ausentes responden 400', async (t) => {
        if (!requiereBase(t)) return;
        const casos = [
            { email: 'administrativo@gomaq.test', password: 123456 },
            { email: 'administrativo@gomaq.test', password: { $ne: '' } },
            { email: 'administrativo@gomaq.test', password: ['a'] },
            { email: 12345, password: 'PruebaGomaq123' },
            { email: { a: 1 }, password: 'PruebaGomaq123' },
            { email: ['administrativo@gomaq.test'], password: 'PruebaGomaq123' },
            { email: 'administrativo@gomaq.test' },
            { password: 'PruebaGomaq123' },
            { email: '', password: '' },
            {},
        ];
        for (const cuerpo of casos) {
            const r = await login(cuerpo);
            assert.equal(r.status, 400, JSON.stringify(cuerpo));
            assert.equal(r.body.error, 'Escribe tu correo y tu contraseña');
        }
    });

    test('un cuerpo vacio tampoco rompe el login', async (t) => {
        if (!requiereBase(t)) return;
        const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'CF-Connecting-IP': '10.81.9.9' } });
        assert.equal(r.status, 400);
    });
});

describe('login: un correo sin cuenta tambien pasa por bcrypt', () => {
    test('con correo inexistente hay exactamente una comparacion y la respuesta es 401', async (t) => {
        if (!requiereBase(t)) return;
        const original = bcrypt.compare;
        let comparaciones = 0;
        bcrypt.compare = (...args) => { comparaciones += 1; return original.apply(bcrypt, args); };
        try {
            const r = await login({ email: `no-existe-${Date.now()}@gomaq.test`, password: 'cualquier-clave-1' });
            assert.equal(r.status, 401);
            assert.equal(r.body.error, 'Correo o contraseña incorrectos');
            assert.equal(comparaciones, 1);
        } finally {
            bcrypt.compare = original;
        }
    });

    test('con correo existente y clave mala tambien hay una comparacion y la misma respuesta', async (t) => {
        if (!requiereBase(t)) return;
        const original = bcrypt.compare;
        let comparaciones = 0;
        bcrypt.compare = (...args) => { comparaciones += 1; return original.apply(bcrypt, args); };
        try {
            const r = await login({ email: 'administrativo@gomaq.test', password: 'clave-equivocada-1' });
            assert.equal(r.status, 401);
            assert.equal(r.body.error, 'Correo o contraseña incorrectos');
            assert.equal(comparaciones, 1);
        } finally {
            bcrypt.compare = original;
        }
    });
});
