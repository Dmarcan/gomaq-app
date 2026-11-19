// Piezas que comparten los routers de ordenes.

const MAX_ELEMENTOS_CHECKLIST = 100;

// Estado interno de la ETA (origen de la ultima consulta, cupo gastado, ajuste): no sale en el listado
// ni en el detalle de la OT, que se arman con `ot.*`. Una columna nueva de ETA no llega por accidente.
const CAMPOS_INTERNOS_ETA = [
    'eta_origen_lat', 'eta_origen_lng', 'eta_consultas', 'eta_intento_at', 'eta_ajustada_llegada_at', 'eta_ajustada_at',
];

function sinInternosEta(fila) {
    const copia = { ...fila };
    for (const campo of CAMPOS_INTERNOS_ETA) delete copia[campo];
    return copia;
}

// Los seis tipos del talonario. Los marca el mecanico en terreno, que es quien sabe de que
// se trato la visita; el administrativo no lo fija al crear la OT.
const TIPOS_SERVICIO = [
    'preventivo', 'reparacion', 'garantia_full_mantencion',
    'correctivo', 'bateria_cargador', 'administrativo',
];

module.exports = { MAX_ELEMENTOS_CHECKLIST, CAMPOS_INTERNOS_ETA, sinInternosEta, TIPOS_SERVICIO };
