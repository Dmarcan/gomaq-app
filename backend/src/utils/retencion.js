// Retencion de datos personales: borra lo que ya no sirve para operar, pasado un plazo.
//
// Solo toca cuatro tipos de filas que son datos de acceso o avisos viejos; NUNCA facturas, guias,
// ordenes, clientes ni equipos (esos son el registro del negocio). Los plazos son:
//   * notificaciones ya terminadas (enviadas o con error definitivo): 180 dias
//   * solicitudes de cliente rechazadas (guardan nombre, RUT, correo y el hash de la clave): 30 dias
//   * sesiones vencidas o cerradas: 30 dias
//   * codigos de cuenta vencidos, usados o revocados: 30 dias
// El borrado es irreversible: por eso la tarea del worker esta apagada por defecto (RETENCION_ACTIVA=1
// la enciende) y scripts/retencion.js solo cuenta, salvo con --ejecutar.

const PLAZOS_DIAS = {
    notificaciones: 180,
    solicitudes_rechazadas: 30,
    sesiones: 30,
    codigos_cuenta: 30,
};

// cada regla: la tabla, la condicion SQL con $1 = dias y el orden en que se borra
const REGLAS = [
    {
        clave: 'notificaciones',
        tabla: 'notificaciones_pendientes',
        donde: `estado IN ('enviado', 'error') AND created_at < now() - make_interval(days => $1)`,
    },
    {
        clave: 'solicitudes_rechazadas',
        tabla: 'solicitudes_cliente',
        donde: `estado = 'rechazada' AND created_at < now() - make_interval(days => $1)`,
    },
    {
        clave: 'sesiones',
        tabla: 'sesiones',
        donde: `LEAST(expira_at, COALESCE(revocada_at, expira_at)) < now() - make_interval(days => $1)`,
    },
    {
        clave: 'codigos_cuenta',
        tabla: 'codigos_cuenta',
        donde: `LEAST(expira_at, COALESCE(usado_at, expira_at), COALESCE(revocado_at, expira_at)) < now() - make_interval(days => $1)`,
    },
];

function validarPlazos(plazos) {
    const final = { ...PLAZOS_DIAS, ...(plazos || {}) };
    for (const [clave, dias] of Object.entries(final)) {
        if (!Number.isInteger(dias) || dias < 1) throw new Error(`Plazo de retencion invalido para ${clave}: ${dias}`);
    }
    return final;
}

/** Cuenta lo que se borraria con esos plazos, sin tocar nada. */
async function contarRetencion(db, plazos) {
    const p = validarPlazos(plazos);
    const resultado = {};
    for (const r of REGLAS) {
        const q = await db.query(`SELECT count(*)::int AS n FROM ${r.tabla} WHERE ${r.donde}`, [p[r.clave]]);
        resultado[r.clave] = q.rows[0].n;
    }
    return resultado;
}

/** Borra lo vencido, todo en una transaccion. Devuelve cuantas filas borro de cada tipo. */
async function ejecutarRetencion(pool, plazos) {
    const p = validarPlazos(plazos);
    const client = await pool.connect();
    const resultado = {};
    try {
        await client.query('BEGIN');
        for (const r of REGLAS) {
            const q = await client.query(`DELETE FROM ${r.tabla} WHERE ${r.donde}`, [p[r.clave]]);
            resultado[r.clave] = q.rowCount;
        }
        await client.query('COMMIT');
        return resultado;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

const CANDADO_RETENCION = 724901;
const UN_DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Tarea diaria del worker. Apagada salvo RETENCION_ACTIVA=1. Con el candado de la base solo una instancia
 * la corre aunque haya dos workers. Devuelve la funcion que la detiene.
 */
function iniciarRetencion(pool, { activa = process.env.RETENCION_ACTIVA === '1', log = console } = {}) {
    if (!activa) return () => {};
    const correr = async () => {
        const client = await pool.connect();
        try {
            const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CANDADO_RETENCION]);
            if (!rows[0].ok) return;
            try {
                const r = await ejecutarRetencion(pool);
                log.log(`[retencion] borrado: ${JSON.stringify(r)}`);
            } finally {
                await client.query('SELECT pg_advisory_unlock($1)', [CANDADO_RETENCION]).catch(() => {});
            }
        } catch (err) {
            log.error('[retencion] error:', err.message);
        } finally {
            client.release();
        }
    };
    // la primera pasada 10 minutos despues de arrancar, para no cargar el arranque; despues una vez al dia
    const inicio = setTimeout(correr, 10 * 60 * 1000);
    const intervalo = setInterval(correr, UN_DIA_MS);
    inicio.unref();
    intervalo.unref();
    log.log('[retencion] tarea diaria activada');
    return () => { clearTimeout(inicio); clearInterval(intervalo); };
}

module.exports = { PLAZOS_DIAS, REGLAS, contarRetencion, ejecutarRetencion, iniciarRetencion, validarPlazos };
