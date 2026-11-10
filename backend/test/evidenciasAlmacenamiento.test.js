// Si Supabase falla al generar la URL de subida (caido o pausado), solicitar-upload responde 503
// con un mensaje entendible y no 500: la app del mecanico trata el 503 como pasajero y lo
// reintenta sola sin gastar intentos. Sin base de datos ni Supabase real: se reemplazan la
// verificacion de dueño de la orden y el cliente de Supabase antes de cargar la ruta.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nadie:nada@127.0.0.1:1/ninguna';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-pruebas-de-evidencias';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ci.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'clave-solo-para-pruebas';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const { creerEnElToken } = require('./_sesionDePrueba');

creerEnElToken();

// la ruta toma estas funciones al cargarse: se reemplazan antes del require de la ruta
const ordenes = require('../src/utils/ordenes');
ordenes.verificarDuenoOrden = async () => ({ existe: true, esDueno: true, editable: true });

let comportamiento = 'ok';
const config = require('../src/config/supabase');
config.supabase = {
    storage: {
        from: () => ({
            createSignedUploadUrl: async (path) => {
                if (comportamiento === 'error') return { data: null, error: new Error('Service Unavailable') };
                if (comportamiento === 'lanza') throw new Error('fetch failed');
                return { data: { path, token: 't', signedUrl: `https://ci.invalid/subir/${path}` }, error: null };
            },
        }),
    },
};

const evidencias = require('../src/routes/evidencias');

describe('solicitar-upload con el almacenamiento caido', () => {
    let servidor;
    let base;
    const token = jwt.sign({ id: 1, rol: 'mecanico' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    before(async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/ordenes-trabajo', evidencias);
        await new Promise((resolve) => { servidor = app.listen(0, resolve); });
        base = `http://127.0.0.1:${servidor.address().port}`;
    });

    after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
    });

    const solicitar = () => fetch(`${base}/api/ordenes-trabajo/7/evidencia/solicitar-upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre_archivo: 'foto.jpg' }),
    });

    test('Supabase responde con error: 503 con mensaje en español', async () => {
        comportamiento = 'error';
        const r = await solicitar();
        assert.equal(r.status, 503);
        const cuerpo = await r.json();
        assert.match(cuerpo.error, /servidor de fotos no está disponible/);
    });

    test('el cliente de Supabase lanza (sin red hacia Supabase): tambien 503', async () => {
        comportamiento = 'lanza';
        const r = await solicitar();
        assert.equal(r.status, 503);
    });

    test('con Supabase disponible responde la URL firmada', async () => {
        comportamiento = 'ok';
        const r = await solicitar();
        assert.equal(r.status, 200);
        const cuerpo = await r.json();
        assert.match(cuerpo.path, /^ot-7\//);
        assert.ok(cuerpo.signedUrl);
    });
});
