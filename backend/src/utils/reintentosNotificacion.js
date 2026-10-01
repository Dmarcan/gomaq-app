// Reglas de reintento del worker de notificaciones (funciones puras, sin base de datos).

const ESPERA_BASE_SEGUNDOS = 30;
// tope para un Retry-After exagerado del proveedor: mas de una hora ya es un problema distinto
const ESPERA_MAXIMA_SEGUNDOS = 3600;

// Decide que hacer con una notificacion cuyo envio fallo.
//
// - Error comun: suma un intento, con backoff exponencial (30s, 1min, 2min, 4min...). Al llegar
//   a maxIntentos queda en 'error'.
// - Limite del proveedor (429): el error trae `reintentarEnSegundos` (el Retry-After). Eso no es
//   un fallo de la notificacion sino saturacion del proveedor: se reprograma sin sumar intento,
//   para que un rato de limite no la deje en 'error' por culpa ajena.
function planificarReintento({ intentos, maxIntentos, error }) {
    const espera = Number(error && error.reintentarEnSegundos);
    if (Number.isFinite(espera) && espera > 0) {
        return {
            intentos,
            estado: 'pendiente',
            esperaSegundos: Math.min(Math.ceil(espera), ESPERA_MAXIMA_SEGUNDOS),
        };
    }
    const nuevosIntentos = intentos + 1;
    return {
        intentos: nuevosIntentos,
        estado: nuevosIntentos >= maxIntentos ? 'error' : 'pendiente',
        esperaSegundos: ESPERA_BASE_SEGUNDOS * Math.pow(2, nuevosIntentos - 1),
    };
}

// Cuanto tiempo debe quedar "tomado" un lote mientras se envia: el peor caso es que cada envio
// agote su timeout, mas un margen. Si fuera menor, las ultimas filas del lote vencerian antes de
// enviarse y otra instancia las tomaria (aviso duplicado al cliente).
function plazoTomaSegundos({ lote, timeoutMs, minimoSegundos = 120, margenSegundos = 30 }) {
    return Math.max(minimoSegundos, Math.ceil((lote * timeoutMs) / 1000) + margenSegundos);
}

// Corta un envio que tarda demasiado. `ejecutar` recibe un AbortSignal para cancelar la llamada
// de red (fetch lo acepta); sin cancelarla, un envio lento podria completarse despues de que la
// fila ya se reprogramo y el aviso saldria dos veces.
async function conTimeout(ejecutar, timeoutMs) {
    const controlador = new AbortController();
    let temporizador;
    const limite = new Promise((_, rechazar) => {
        temporizador = setTimeout(() => {
            controlador.abort();
            rechazar(new Error(`El envio supero el limite de ${timeoutMs} ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([ejecutar(controlador.signal), limite]);
    } finally {
        clearTimeout(temporizador);
    }
}

module.exports = { planificarReintento, plazoTomaSegundos, conTimeout, ESPERA_MAXIMA_SEGUNDOS };
