// Detalle de una orden de trabajo como lo ve el cliente en el historial del portal: datos de la
// orden, linea de tiempo en palabras del cliente y fotos antes/despues.
//
// Reglas puras, sin consultas: la ruta (GET /api/ordenes-trabajo/mias/:id) lee y llama aqui. Por
// privacidad cada campo se copia a mano (nunca `...fila`, como en mapaOperativo.js): una columna nueva
// en una consulta no llega al cliente por accidente.
// Quedan fuera a proposito: facturable, valorizacion y lineas (solo entran para decidir el mensaje de
// cobro, que no lleva montos), el detalle y el usuario de los eventos, el origen, las coordenadas, la
// ETA, la ruta de las fotos en el bucket, la factura y la foto que el cliente adjunto al pedir asistencia.
// La observacion final se muestra tal cual.

const { cobroParaCliente } = require('./cobroCliente');

// Mismos textos que etiquetaParaCliente en panel/lib/utils/seguimiento_cliente.dart
const PASOS = {
    recibida: 'Solicitud recibida',
    ordenGomaq: 'Orden creada por GOMAQ',
    tecnicoAsignado: 'Técnico asignado',
    tecnicoAcepto: 'Técnico aceptó',
    enCamino: 'Técnico en camino',
    trabajando: 'Trabajando en tu equipo',
    finalizada: 'Finalizada',
};

/** { paso, texto } de un evento, o null si al cliente no le dice nada (valorizacion, lineas, facturas...). */
function pasoDeEvento(e) {
    switch (e.tipo) {
        case 'creacion':
            return e.rol === 'cliente'
                ? { paso: 'recibida', texto: PASOS.recibida }
                : { paso: 'recibida', texto: PASOS.ordenGomaq };
        case 'asignacion':
        case 'toma':
            return { paso: 'tecnico_asignado', texto: PASOS.tecnicoAsignado };
        case 'cambio_estado':
            if (e.estado_nuevo === 'aceptada') return { paso: 'tecnico_acepto', texto: PASOS.tecnicoAcepto };
            if (e.estado_nuevo === 'en_camino') return { paso: 'en_camino', texto: PASOS.enCamino };
            if (e.estado_nuevo === 'en_terreno' || e.estado_nuevo === 'en_reparacion') {
                return { paso: 'trabajando', texto: PASOS.trabajando };
            }
            return null;
        case 'cierre':
            return { paso: 'finalizada', texto: PASOS.finalizada };
        default:
            return null;
    }
}

function aIso(valor) {
    if (valor === null || valor === undefined) return null;
    return valor instanceof Date ? valor.toISOString() : valor;
}

/**
 * Linea de tiempo del cliente. Los eventos vienen en orden de escritura (la creacion primero). Solo
 * cuentan los aplicados; la hora es ocurrio_en, o registrado_en si la hora del telefono es dudosa; si dos
 * pasos seguidos dicen lo mismo queda uno.
 * @returns {{paso:string, texto:string, ocurrio_en:string|null}[]}
 */
function lineaTiempoCliente(eventos) {
    const salida = [];
    for (const e of eventos || []) {
        if (e.aplicado !== true) continue;
        const paso = pasoDeEvento(e);
        if (!paso) continue;
        if (salida.length > 0 && salida[salida.length - 1].texto === paso.texto) continue;
        salida.push({ paso: paso.paso, texto: paso.texto, ocurrio_en: aIso(e.hora_dudosa ? e.registrado_en : e.ocurrio_en) });
    }
    return salida;
}

/**
 * @param {object} p
 * @param {object} p.orden   fila de la OT (ver la consulta de la ruta)
 * @param {object[]} p.eventos  filas de ordenes_eventos
 * @param {{id:number, tipo:string, url:string|null, created_at:Date|string}[]} p.fotos  ya con la URL firmada
 */
function armarDetalleOtCliente({ orden, eventos, fotos }) {
    return {
        id: orden.id,
        estado: orden.estado,
        maquinaria_codigo: orden.maquinaria_codigo,
        maquinaria_tipo: orden.maquinaria_tipo,
        motivo: orden.motivo,
        diagnostico: orden.diagnostico,
        observacion_final: orden.observacion_final,
        fecha_creacion: orden.fecha_creacion,
        fecha_cierre: orden.fecha_cierre,
        mecanico_nombre: orden.mecanico_nombre,
        cobro: cobroParaCliente({
            estado: orden.estado,
            facturable: orden.facturable,
            lineasPendientes: orden.lineas_pendientes,
            valorizacion: orden.valorizacion,
        }),
        linea_tiempo: lineaTiempoCliente(eventos),
        fotos: (fotos || []).map((f) => ({
            id: f.id,
            tipo: f.tipo === 'despues' ? 'despues' : 'antes',
            url: f.url,
            tomada_en: aIso(f.created_at),
        })),
    };
}

module.exports = { lineaTiempoCliente, armarDetalleOtCliente };
